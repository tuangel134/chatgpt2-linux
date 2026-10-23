/**
 * Secret detection and redaction.
 *
 * Two different jobs share one pattern table:
 *  1. `redact()` — used by the logger. Must be cheap and never throw.
 *  2. `scan()` / `sanitizeText()` — used before any text leaves the machine towards a provider.
 *
 * Design notes:
 *  - Patterns are intentionally provider-agnostic and shape-based (prefix + entropy + length)
 *    because hardcoding vendor prefixes only catches yesterday's key formats.
 *  - We prefer false positives over leaks, but we keep the redaction local to the matched span so
 *    the model still sees usable context around it.
 */

export type SecretKind =
	| 'private-key'
	| 'api-key'
	| 'bearer-token'
	| 'jwt'
	| 'aws-access-key'
	| 'aws-secret-key'
	| 'gcp-service-account'
	| 'ssh-key'
	| 'connection-string'
	| 'password-assignment'
	| 'env-assignment'
	| 'high-entropy-string';

export interface SecretFinding {
	readonly kind: SecretKind;
	readonly start: number;
	readonly end: number;
	readonly preview: string;
	/** 0..1 — how sure we are. Used to decide between blocking and warning. */
	readonly confidence: number;
}

interface PatternSpec {
	readonly kind: SecretKind;
	readonly regex: RegExp;
	readonly confidence: number;
	/** When set, only this capture group is redacted (keeps `KEY=` visible). */
	readonly group?: number;
	/** Extra validation to cut down false positives. */
	readonly validate?: (match: RegExpExecArray) => boolean;
}

const PLACEHOLDER_VALUES = new Set([
	'', 'null', 'none', 'todo', 'changeme', 'change_me', 'xxx', 'xxxx', 'placeholder', 'example',
	'your_api_key', 'your-api-key', 'yourkeyhere', 'secret', 'password', 'test', 'dummy', 'fake',
	'undefined', 'redacted', 'sk-xxx', '<your-key>', 'string', 'value'
]);

/** Words that mark a value as a template rather than a real credential. */
const PLACEHOLDER_HINTS = [
	'your', 'yours', 'myapi', 'insert', 'replace', 'example', 'sample', 'dummy', 'fake', 'placeholder',
	'changeme', 'change_me', 'todo', 'xxxx', 'abc123', 'notreal', 'redacted'
];

function looksLikePlaceholder(value: string): boolean {
	const normalized = value.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase();
	if (PLACEHOLDER_VALUES.has(normalized)) {
		return true;
	}
	// `your_api_key_here`, `insert-token-here`, `REPLACE_WITH_KEY`, `<my-key>` and friends. Split on
	// separators so we only match whole words: `hereford` must not look like a placeholder.
	const words = normalized.split(/[^a-z0-9]+/).filter((word) => word.length > 0);
	if (words.length > 0 && words.some((word) => PLACEHOLDER_HINTS.includes(word))) {
		return true;
	}
	// "...goes_here" / "...-here" only counts as a template when nothing looks random, otherwise a
	// real secret that happens to end in "here" would slip through.
	if (/(?:goes[_-]?here|[_-]here)$/.test(normalized) && shannonEntropy(normalized) < 3.2) {
		return true;
	}
	// ${VAR}, $VAR, {{VAR}}, %VAR%, <VAR> style interpolations are not secrets.
	if (/^(\$\{?[a-z_][a-z0-9_]*\}?|\{\{.*\}\}|%[a-z_]+%|<[^>]+>)$/i.test(normalized)) {
		return true;
	}
	// All same char, or obviously masked.
	if (/^(.)\1{3,}$/.test(normalized) || /^\*+$/.test(normalized) || /x{6,}/.test(normalized)) {
		return true;
	}
	return false;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
	if (value.length === 0) {
		return 0;
	}
	const counts = new Map<string, number>();
	for (const char of value) {
		counts.set(char, (counts.get(char) ?? 0) + 1);
	}
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

const PATTERNS: PatternSpec[] = [
	{
		kind: 'private-key',
		regex: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
		confidence: 1
	},
	{
		kind: 'ssh-key',
		regex: /\b(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/]{60,}={0,3}/g,
		confidence: 0.95
	},
	{
		kind: 'gcp-service-account',
		regex: /"type"\s*:\s*"service_account"[\s\S]{0,400}?"private_key"\s*:\s*"[^"]+"/g,
		confidence: 1
	},
	{
		kind: 'aws-access-key',
		regex: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g,
		confidence: 0.98,
		group: 1
	},
	{
		kind: 'aws-secret-key',
		regex: /\baws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
		confidence: 0.98,
		group: 1
	},
	{
		kind: 'jwt',
		regex: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
		confidence: 0.9
	},
	{
		kind: 'bearer-token',
		regex: /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})/g,
		confidence: 0.85,
		group: 1,
		validate: (m) => !looksLikePlaceholder(m[1] ?? '')
	},
	{
		// Vendor-prefixed keys: sk-..., xoxb-..., ghp_..., gsk_..., AIza..., hf_..., etc.
		kind: 'api-key',
		regex: /\b((?:sk|pk|rk|ak|api|key|tok)[-_][A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{16,}|dop_v1_[a-f0-9]{60,}|sq0(?:atp|csp)-[A-Za-z0-9_-]{20,})\b/g,
		confidence: 0.95,
		group: 1,
		validate: (m) => !looksLikePlaceholder(m[1] ?? '')
	},
	{
		kind: 'connection-string',
		regex: /\b([a-z][a-z0-9+.-]{2,20}:\/\/[^\s:/@]+:([^\s/@]{3,})@[^\s]+)/gi,
		confidence: 0.9,
		group: 2,
		validate: (m) => !looksLikePlaceholder(m[2] ?? '')
	},
	{
		kind: 'password-assignment',
		regex: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token)\s*[:=]\s*["'`]([^"'`\n]{6,})["'`]/gi,
		confidence: 0.8,
		group: 1,
		validate: (m) => !looksLikePlaceholder(m[1] ?? '')
	},
	{
		// KEY=value in .env style files (unquoted).
		kind: 'env-assignment',
		regex: /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*([^\s#"'][^\n#]{7,})$/gm,
		confidence: 0.6,
		group: 2,
		validate: (m) => {
			const name = m[1] ?? '';
			const value = m[2]?.trim() ?? '';
			if (looksLikePlaceholder(value)) {
				return false;
			}
			const sensitiveName = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|SIGNATURE|SALT|CERT|DSN|CONNECTION)/.test(name);
			if (!sensitiveName) {
				return false;
			}
			return shannonEntropy(value) >= 2.5 || value.length >= 20;
		}
	}
];

const MASK = '[REDACTED]';

export interface ScanOptions {
	/** Findings below this confidence are ignored. Default 0.6. */
	readonly minConfidence?: number;
	/** Additional literal strings to redact (e.g. the API keys we ourselves hold). */
	readonly extraLiterals?: readonly string[];
}

export class SecretScanner {
	private readonly literals: string[];

	constructor(extraLiterals: readonly string[] = []) {
		this.literals = extraLiterals.filter((value) => value.length >= 8);
	}

	/** Registers a known-sensitive literal (an API key we loaded) for guaranteed redaction. */
	addLiteral(value: string): void {
		if (value && value.length >= 8 && !this.literals.includes(value)) {
			this.literals.push(value);
		}
	}

	scan(text: string, options: ScanOptions = {}): SecretFinding[] {
		if (!text) {
			return [];
		}
		const minConfidence = options.minConfidence ?? 0.6;
		const findings: SecretFinding[] = [];

		for (const literal of [...this.literals, ...(options.extraLiterals ?? [])]) {
			let index = text.indexOf(literal);
			while (index >= 0) {
				findings.push({
					kind: 'api-key',
					start: index,
					end: index + literal.length,
					preview: preview(literal),
					confidence: 1
				});
				index = text.indexOf(literal, index + literal.length);
			}
		}

		for (const spec of PATTERNS) {
			if (spec.confidence < minConfidence) {
				continue;
			}
			// Fresh regex per scan: the shared `g` lastIndex is not reentrancy-safe.
			const regex = new RegExp(spec.regex.source, spec.regex.flags);
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				if (match[0].length === 0) {
					regex.lastIndex++;
					continue;
				}
				if (spec.validate && !spec.validate(match)) {
					continue;
				}
				const groupIndex = spec.group ?? 0;
				const groupValue = match[groupIndex];
				if (groupValue === undefined) {
					continue;
				}
				const offsetInMatch = groupIndex === 0 ? 0 : match[0].indexOf(groupValue);
				const start = match.index + (offsetInMatch < 0 ? 0 : offsetInMatch);
				findings.push({
					kind: spec.kind,
					start,
					end: start + groupValue.length,
					preview: preview(groupValue),
					confidence: spec.confidence
				});
			}
		}

		return mergeOverlapping(findings);
	}

	/** Returns the text with every finding replaced by a mask. */
	redact(text: string, options: ScanOptions = {}): { text: string; findings: SecretFinding[] } {
		const findings = this.scan(text, options);
		if (findings.length === 0) {
			return { text, findings };
		}
		let result = '';
		let cursor = 0;
		for (const finding of findings) {
			result += text.slice(cursor, finding.start) + MASK;
			cursor = finding.end;
		}
		result += text.slice(cursor);
		return { text: result, findings };
	}

	hasSecrets(text: string, options: ScanOptions = {}): boolean {
		return this.scan(text, options).length > 0;
	}
}

function preview(value: string): string {
	if (value.length <= 8) {
		return `${value.slice(0, 2)}***`;
	}
	return `${value.slice(0, 4)}***${value.slice(-2)} (${value.length} chars)`;
}

function mergeOverlapping(findings: SecretFinding[]): SecretFinding[] {
	if (findings.length <= 1) {
		return findings;
	}
	const sorted = findings.slice().sort((a, b) => (a.start - b.start) || (b.end - a.end));
	const result: SecretFinding[] = [];
	for (const finding of sorted) {
		const last = result[result.length - 1];
		if (last && finding.start < last.end) {
			if (finding.end > last.end) {
				result[result.length - 1] = {
					kind: last.confidence >= finding.confidence ? last.kind : finding.kind,
					start: last.start,
					end: finding.end,
					preview: last.preview,
					confidence: Math.max(last.confidence, finding.confidence)
				};
			}
			continue;
		}
		result.push(finding);
	}
	return result;
}

/** Process-wide scanner used by the logger. Keys get registered here when loaded. */
export const globalSecretScanner = new SecretScanner();

/**
 * Cheap redaction for log lines. Also masks obvious `key=`/`authorization:` headers even at low
 * confidence, because logs are the most common accidental leak channel.
 */
export function redactForLog(value: string): string {
	if (!value) {
		return value;
	}
	const withHeaders = value
		.replace(/(authorization\s*[:=]\s*)([^\s,;"']+)/gi, `$1${MASK}`)
		.replace(/(x-api-key\s*[:=]\s*)([^\s,;"']+)/gi, `$1${MASK}`)
		.replace(/(api[-_]?key["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/gi, `$1${MASK}`);
	return globalSecretScanner.redact(withHeaders, { minConfidence: 0.6 }).text;
}
