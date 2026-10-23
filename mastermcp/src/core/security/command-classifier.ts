/**
 * Terminal command risk classification (§31).
 *
 * The agent needs to run commands to be useful, and the user needs to not wake up to a wiped disk.
 * So every command is classified before it runs:
 *
 *   SAFE      read-only: ls, cat, git status, tsc --noEmit, running tests
 *   MODIFY    changes the workspace: npm install, git commit, mkdir, code formatters
 *   DANGEROUS destructive or wide-reaching: rm -rf, git reset --hard, chmod -R, kill
 *   CRITICAL  system/credential level: disk writes, sudo, curl | sh, editing ~/.ssh, git push --force
 *
 * Design notes:
 *  - We parse the command into segments first (`&&`, `||`, `;`, `|`, backticks, `$( )`), because the
 *    risk of a command line is the risk of its worst part. `ls && rm -rf /` is not safe.
 *  - Substitution and piping into a shell are treated as their own hazard: `curl x | sh` is critical
 *    regardless of what `curl` alone would be.
 *  - Unknown commands default to MODIFY, not SAFE. Failing open here would be the whole ballgame.
 */

export const RiskClass = {
	Safe: 'safe',
	Modify: 'modify',
	Dangerous: 'dangerous',
	Critical: 'critical'
} as const;

export type RiskClass = (typeof RiskClass)[keyof typeof RiskClass];

export const RISK_ORDER: readonly RiskClass[] = [
	RiskClass.Safe, RiskClass.Modify, RiskClass.Dangerous, RiskClass.Critical
];

export function riskRank(risk: RiskClass): number {
	return RISK_ORDER.indexOf(risk);
}

export function maxRisk(a: RiskClass, b: RiskClass): RiskClass {
	return riskRank(a) >= riskRank(b) ? a : b;
}

export interface CommandFinding {
	readonly risk: RiskClass;
	readonly reason: string;
	/** The segment that triggered it, truncated for display. */
	readonly segment: string;
}

export interface Classification {
	readonly risk: RiskClass;
	readonly findings: readonly CommandFinding[];
	readonly segments: readonly string[];
	/** Short user-facing summary, e.g. "deletes files recursively". */
	readonly summary: string;
	/** True when the command appears to install or update dependencies (§ needs its own consent). */
	readonly touchesDependencies: boolean;
	/** True when the command talks to the network. */
	readonly network: boolean;
}

/**
 * Splits a command line into independently-classified segments.
 * Quote-aware, so `echo "a && b"` stays one segment, and it also surfaces the contents of command
 * substitutions as their own segments.
 */
export function splitCommand(command: string): string[] {
	const segments: string[] = [];
	let current = '';
	let quote: '"' | "'" | '`' | undefined;
	let depth = 0;

	const flush = (): void => {
		const trimmed = current.trim();
		if (trimmed) {
			segments.push(trimmed);
		}
		current = '';
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		const next = command[i + 1];

		if (quote) {
			// Inside single quotes nothing is special; inside double quotes `$( )` still executes.
			if (char === '\\' && quote !== "'") {
				current += char + (next ?? '');
				i++;
				continue;
			}
			if (char === quote) {
				quote = undefined;
				if (char === '`') {
					flush();
					continue;
				}
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'" || char === '`') {
			quote = char;
			if (char === '`') {
				flush();
				continue;
			}
			current += char;
			continue;
		}
		if (char === '$' && next === '(') {
			flush();
			depth++;
			i++;
			continue;
		}
		if (char === ')' && depth > 0) {
			flush();
			depth--;
			continue;
		}
		if (char === ';' || char === '\n') {
			flush();
			continue;
		}
		if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
			flush();
			i++;
			continue;
		}
		if (char === '|') {
			flush();
			continue;
		}
		current += char;
	}
	flush();
	return segments;
}

interface Rule {
	readonly pattern: RegExp;
	readonly risk: RiskClass;
	readonly reason: string;
}

/** Ordered: the first matching rule of the highest risk wins per segment. */
const RULES: readonly Rule[] = [
	// ---------------------------------------------------------------- CRITICAL
	{ pattern: /\brm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b[^|;]*\s(\/|~|\$HOME|\/\*)\s*$/i, risk: RiskClass.Critical, reason: 'recursively deletes a root or home directory' },
	{ pattern: /\b(mkfs|fdisk|parted|dd)\b/i, risk: RiskClass.Critical, reason: 'writes directly to a disk device' },
	{ pattern: /\bdd\s+[^|;]*of=\/dev\//i, risk: RiskClass.Critical, reason: 'writes to a block device' },
	{ pattern: /\b(sudo|doas|su)\b/i, risk: RiskClass.Critical, reason: 'runs with elevated privileges' },
	{ pattern: /(^|\s)runas(?:\.exe)?\b|\bStart-Process\b[^\r\n]*\b-Verb\s+RunAs\b/i, risk: RiskClass.Critical, reason: 'requests Windows administrator privileges' },
	{ pattern: /\b(shutdown|reboot|halt|poweroff|systemctl\s+(stop|disable|mask))\b/i, risk: RiskClass.Critical, reason: 'changes system state' },
	{ pattern: /\b(curl|wget|fetch)\b[^|;]*\|\s*(ba|z|k|d)?sh\b/i, risk: RiskClass.Critical, reason: 'pipes a downloaded script straight into a shell' },
	{ pattern: /(^|\s)(ba|z|k|d)?sh\s+-c\b[^|;]*\b(curl|wget)\b/i, risk: RiskClass.Critical, reason: 'executes a downloaded script' },
	{ pattern: /(~|\/home\/[^/\s]+|\$HOME)\/\.(ssh|aws|gnupg|kube|docker|config\/gh)\b/i, risk: RiskClass.Critical, reason: 'touches stored credentials' },
	{ pattern: /\b(git\s+push[^|;]*(--force|-f)\b|git\s+push[^|;]*\+)/i, risk: RiskClass.Critical, reason: 'force-pushes, which can destroy remote history' },
	{ pattern: /\bgit\s+(filter-branch|filter-repo)\b/i, risk: RiskClass.Critical, reason: 'rewrites repository history' },
	{ pattern: /\b(chown|chmod)\s+(-[a-z]*R[a-z]*\s+)?[^|;]*\s(\/|\/etc|\/usr|\/var)\b/i, risk: RiskClass.Critical, reason: 'changes ownership or permissions outside the workspace' },
	{ pattern: /\b(iptables|nft|ufw|firewall-cmd)\b/i, risk: RiskClass.Critical, reason: 'modifies firewall rules' },
	{ pattern: /\b(crontab|at)\s+-?[a-z]*\s*-?/i, risk: RiskClass.Critical, reason: 'schedules background jobs' },
	{ pattern: /\b(eval|exec)\s/i, risk: RiskClass.Critical, reason: 'evaluates dynamically constructed code' },
	{ pattern: /\bdrop\s+(database|table|schema)\b/i, risk: RiskClass.Critical, reason: 'drops a database object' },
	{ pattern: /\b(aws|gcloud|az|kubectl)\b[^|;]*\b(delete|destroy|rm|terminate)\b/i, risk: RiskClass.Critical, reason: 'deletes cloud infrastructure' },
	{ pattern: /\bterraform\s+(destroy|apply)\b/i, risk: RiskClass.Critical, reason: 'changes live infrastructure' },

	// --------------------------------------------------------------- DANGEROUS
	{ pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*r/i, risk: RiskClass.Dangerous, reason: 'deletes files recursively' },
	{ pattern: /\brm\b/i, risk: RiskClass.Dangerous, reason: 'deletes files' },
	{ pattern: /\b(git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+checkout\s+--\s|git\s+restore\s)/i, risk: RiskClass.Dangerous, reason: 'discards uncommitted work' },
	{ pattern: /\bgit\s+branch\s+-D\b/i, risk: RiskClass.Dangerous, reason: 'force-deletes a branch' },
	{ pattern: /\bgit\s+(rebase|cherry-pick|revert)\b/i, risk: RiskClass.Dangerous, reason: 'rewrites local history' },
	{ pattern: /\bgit\s+push\b/i, risk: RiskClass.Dangerous, reason: 'publishes commits to a remote' },
	{ pattern: /\b(kill|killall|pkill)\b/i, risk: RiskClass.Dangerous, reason: 'terminates processes' },
	{ pattern: /\b(truncate|shred)\b/i, risk: RiskClass.Dangerous, reason: 'destroys file contents' },
	{ pattern: /\bmv\s+[^|;]*\s+\/(?!tmp)/i, risk: RiskClass.Dangerous, reason: 'moves files outside the workspace' },
	{ pattern: /\b(chmod|chown)\b/i, risk: RiskClass.Dangerous, reason: 'changes file permissions' },
	{ pattern: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/i, risk: RiskClass.Dangerous, reason: 'removes containers, images or volumes' },
	{ pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b/i, risk: RiskClass.Dangerous, reason: 'publishes a package' },
	{ pattern: /\b(psql|mysql|sqlite3|mongo|redis-cli)\b[^|;]*\b(delete|truncate|update)\b/i, risk: RiskClass.Dangerous, reason: 'mutates database rows' },
	{ pattern: />\s*\/dev\/(sd|nvme|hd)/i, risk: RiskClass.Dangerous, reason: 'redirects output to a device' },

	// ------------------------------------------------------------------ MODIFY
	{ pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|update|upgrade|remove|uninstall|ci|dedupe)\b/i, risk: RiskClass.Modify, reason: 'changes installed dependencies' },
	{ pattern: /\b(pip3?|uv|poetry|pipenv|conda)\s+(install|uninstall|add|remove|sync|update)\b/i, risk: RiskClass.Modify, reason: 'changes installed dependencies' },
	{ pattern: /\b(cargo|go|composer|gem|mix|swift|bundle)\s+(add|install|get|remove|update|tidy)\b/i, risk: RiskClass.Modify, reason: 'changes installed dependencies' },
	{ pattern: /\b(apt|apt-get|dnf|yum|pacman|brew|apk|snap|zypper)\s+(install|remove|upgrade|update)\b/i, risk: RiskClass.Critical, reason: 'changes system packages' },
	{ pattern: /\bgit\s+(add|commit|stash|tag|merge|apply|am|switch|checkout)\b/i, risk: RiskClass.Modify, reason: 'changes git state' },
	{ pattern: /\bgit\s+(fetch|pull|clone|remote)\b/i, risk: RiskClass.Modify, reason: 'talks to a git remote' },
	{ pattern: /\b(mkdir|touch|cp|mv|ln|rmdir|sed\s+-i|perl\s+-i|tee)\b/i, risk: RiskClass.Modify, reason: 'creates or modifies files' },
	{ pattern: /(^|\s)>>?\s*[^\s&|]/, risk: RiskClass.Modify, reason: 'redirects output into a file' },
	{ pattern: /\b(prettier|eslint|ruff|black|gofmt|rustfmt|clang-format)\b[^|;]*(--write|--fix|-w|-i)\b/i, risk: RiskClass.Modify, reason: 'rewrites source files' },
	{ pattern: /\b(docker|docker-compose|podman)\s+(build|up|run|start|restart|exec)\b/i, risk: RiskClass.Modify, reason: 'runs containers' },
	{ pattern: /\b(make|cmake|gradle|mvn|ninja|bazel|dotnet|xcodebuild)\b/i, risk: RiskClass.Modify, reason: 'runs a build' },
	{ pattern: /\b(alembic|prisma|knex|sequelize|rails|django-admin|manage\.py)\b[^|;]*\bmigrat/i, risk: RiskClass.Dangerous, reason: 'runs database migrations' },

	// -------------------------------------------------------------------- SAFE
	{ pattern: /^\s*(ls|ll|pwd|cd|echo|printf|cat|head|tail|wc|file|stat|which|type|whoami|date|env|printenv|uname|df|du|ps|top|uptime|hostname|id|basename|dirname|realpath|readlink|sort|uniq|cut|tr|awk|sed(?!\s+-i)|grep|egrep|fgrep|rg|ag|ack|find|fd|jq|yq|diff|cmp|tree|nl|less|more|column|xargs|tee?st|true|false|sleep|seq|nproc|locale)\b/i, risk: RiskClass.Safe, reason: 'reads information' },
	{ pattern: /\bgit\s+(status|diff|log|show|blame|branch(?!\s+-D)|ls-files|rev-parse|describe|shortlog|config\s+--get|worktree\s+list|check-ignore|stash\s+list|remote\s+-v)\b/i, risk: RiskClass.Safe, reason: 'reads git state' },
	{ pattern: /\b(tsc|tsx|node|deno|bun|python3?|ruby|php|java|dotnet)\b[^|;]*--(version|help)\b/i, risk: RiskClass.Safe, reason: 'prints version information' },
	{ pattern: /\btsc\b[^|;]*--noEmit\b/i, risk: RiskClass.Safe, reason: 'type checks without writing output' },
	{ pattern: /\b(jest|vitest|mocha|pytest|ava|tap|phpunit|rspec|go\s+test|cargo\s+test|dotnet\s+test|gradle\s+test|mvn\s+test)\b/i, risk: RiskClass.Safe, reason: 'runs tests' },
	{ pattern: /\b(npm|pnpm|yarn|bun)\s+(run|test|exec|why|ls|list|outdated|view|info)\b/i, risk: RiskClass.Modify, reason: 'runs a package script' },
	{ pattern: /\b(eslint|ruff|flake8|mypy|pyright|clippy|shellcheck|stylelint|tsc)\b/i, risk: RiskClass.Safe, reason: 'runs a static check' }
];

/**
 * Hazards that only exist in the *composition* of a command line, so they must be matched before
 * splitting. `curl x | sh` is the canonical example: neither `curl x` nor `sh` is critical alone,
 * but piping one into the other is remote code execution.
 */
const WHOLE_LINE_RULES: readonly Rule[] = [
	{ pattern: /\b(curl|wget|fetch|aria2c)\b[\s\S]*\|\s*(sudo\s+)?(ba|z|k|d|fi)?sh\b/i, risk: RiskClass.Critical, reason: 'pipes downloaded content into a shell' },
	{ pattern: /\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(python3?|perl|ruby|node)\b/i, risk: RiskClass.Critical, reason: 'pipes downloaded content into an interpreter' },
	{ pattern: /\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(tee|bash\s+-)/i, risk: RiskClass.Critical, reason: 'writes downloaded content through a privileged command' },
	{ pattern: /\|\s*(sudo|doas)\b/i, risk: RiskClass.Critical, reason: 'pipes into a privileged command' },
	{ pattern: /\b(base64\s+-d|xxd\s+-r)\b[\s\S]*\|\s*(ba|z)?sh\b/i, risk: RiskClass.Critical, reason: 'decodes and executes obfuscated content' }
];

const NETWORK = /\b(curl|wget|fetch|http|https|nc|netcat|ssh|scp|rsync|ftp|telnet|git\s+(clone|fetch|pull|push)|npm\s+(i|install|publish)|pip3?\s+install)\b/i;
const DEPENDENCIES = /\b((npm|pnpm|yarn|bun)\s+(i|install|add|update|upgrade|remove|uninstall|ci)|(pip3?|uv|poetry|pipenv)\s+(install|add|uninstall|remove|sync)|(cargo|go|composer|gem|bundle|mix)\s+(add|install|get|update|tidy)|(apt|apt-get|dnf|yum|pacman|brew|apk)\s+(install|remove|upgrade))\b/i;

export interface ClassifyOptions {
	/** Commands the user explicitly trusts, matched as a prefix. Downgrades them to SAFE. */
	readonly allowList?: readonly string[];
	/** Commands the user always wants blocked, matched as a substring. Forces CRITICAL. */
	readonly denyList?: readonly string[];
}

export function classifyCommand(command: string, options: ClassifyOptions = {}): Classification {
	const trimmed = (command ?? '').trim();
	const segments = splitCommand(trimmed);
	const findings: CommandFinding[] = [];

	for (const denied of options.denyList ?? []) {
		if (denied && trimmed.includes(denied)) {
			findings.push({ risk: RiskClass.Critical, reason: `matches your blocked-command list ("${denied}")`, segment: trimmed.slice(0, 120) });
		}
	}

	// Composition hazards, evaluated on the full line before it is split apart.
	for (const rule of WHOLE_LINE_RULES) {
		if (rule.pattern.test(trimmed)) {
			findings.push({ risk: rule.risk, reason: rule.reason, segment: trimmed.slice(0, 120) });
		}
	}

	for (const segment of segments.length > 0 ? segments : [trimmed]) {
		const allowed = (options.allowList ?? []).some((prefix) => prefix && segment.startsWith(prefix));
		if (allowed) {
			findings.push({ risk: RiskClass.Safe, reason: 'on your trusted-command list', segment: segment.slice(0, 120) });
			continue;
		}
		let best: CommandFinding | undefined;
		for (const rule of RULES) {
			if (!rule.pattern.test(segment)) {
				continue;
			}
			if (!best || riskRank(rule.risk) > riskRank(best.risk)) {
				best = { risk: rule.risk, reason: rule.reason, segment: segment.slice(0, 120) };
			}
		}
		// Unknown command: assume it can change something. Failing open would defeat the point.
		findings.push(best ?? {
			risk: RiskClass.Modify,
			reason: 'unrecognized command, treated as potentially modifying',
			segment: segment.slice(0, 120)
		});
	}

	const risk = findings.reduce<RiskClass>((worst, finding) => maxRisk(worst, finding.risk), RiskClass.Safe);
	const worst = findings.filter((finding) => finding.risk === risk);
	return {
		risk,
		findings,
		segments,
		summary: worst.map((finding) => finding.reason).join('; ') || 'reads information',
		touchesDependencies: DEPENDENCIES.test(trimmed),
		network: NETWORK.test(trimmed)
	};
}

export type TerminalPolicy = 'ask-always' | 'ask-dangerous' | 'trusted';
export type AutoApproveLevel = 'never' | 'safe' | 'safe-and-modify' | 'always';

export interface ApprovalDecision {
	readonly allowed: boolean;
	readonly needsConfirmation: boolean;
	readonly reason: string;
}

/**
 * Combines the two settings that govern command execution: the security policy (what needs asking)
 * and the agent's auto-approve level (what the agent may do unattended). The stricter of the two
 * always wins, and CRITICAL always asks — "trusted mode" buys convenience, not a blank cheque on
 * `sudo` or a force-push.
 */
export function decideApproval(
	classification: Classification,
	policy: TerminalPolicy,
	autoApprove: AutoApproveLevel,
	options: { confirmDependencyInstall?: boolean } = {}
): ApprovalDecision {
	const { risk } = classification;

	if (risk === RiskClass.Critical) {
		return {
			allowed: true,
			needsConfirmation: true,
			reason: `This command ${classification.summary}. It always needs your confirmation.`
		};
	}
	if (options.confirmDependencyInstall && classification.touchesDependencies) {
		return {
			allowed: true,
			needsConfirmation: true,
			reason: 'This installs or changes dependencies, which you asked to confirm.'
		};
	}

	const policyWants = policy === 'ask-always'
		? true
		: policy === 'ask-dangerous'
			? riskRank(risk) >= riskRank(RiskClass.Dangerous)
			: false;

	const autoAllows = autoApprove === 'always'
		? riskRank(risk) <= riskRank(RiskClass.Dangerous)
		: autoApprove === 'safe-and-modify'
			? riskRank(risk) <= riskRank(RiskClass.Modify)
			: autoApprove === 'safe'
				? risk === RiskClass.Safe
				: false;

	const needsConfirmation = policyWants || !autoAllows;
	return {
		allowed: true,
		needsConfirmation,
		reason: needsConfirmation
			? `This command ${classification.summary}.`
			: `Ran automatically: ${classification.summary}.`
	};
}
