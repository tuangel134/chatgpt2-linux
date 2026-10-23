/**
 * Lightweight symbol and import extraction.
 *
 * Design decision: no tree-sitter, no per-language parser dependency. Reasons:
 *  - a real parser per language is dozens of native modules and a build nightmare across platforms;
 *  - the LSP already gives us exact symbols *when the IDE is running and a server is installed*, and
 *    the context engine uses it when available;
 *  - what we need here is a fast, always-available, good-enough index for retrieval and for the repo
 *    map, on any file in any language, including ones no parser supports.
 *
 * So this is regex-based, per-language, and deliberately conservative: it prefers missing a symbol
 * to inventing one. Accuracy is verified by tests against real-world snippets.
 */

export const SymbolKind = {
	Class: 'class',
	Interface: 'interface',
	Function: 'function',
	Method: 'method',
	Type: 'type',
	Enum: 'enum',
	Constant: 'constant',
	Variable: 'variable',
	Struct: 'struct',
	Trait: 'trait',
	Module: 'module'
} as const;

export type SymbolKind = (typeof SymbolKind)[keyof typeof SymbolKind];

export interface SymbolInfo {
	readonly name: string;
	readonly kind: SymbolKind;
	readonly line: number;
	readonly exported: boolean;
	/** Enclosing symbol name, when we can tell cheaply (indentation/braces heuristic). */
	readonly container?: string;
	/** The declaration line, trimmed, for display in search results. */
	readonly signature: string;
}

export interface ImportInfo {
	/** Module specifier exactly as written. */
	readonly module: string;
	readonly line: number;
	/** True for relative/workspace-internal imports. */
	readonly local: boolean;
}

export function symbolKindLabel(kind: SymbolKind): string {
	return kind;
}

const EXTENSION_LANGUAGE: Record<string, string> = {
	ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
	js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
	py: 'python', pyi: 'python',
	go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
	rb: 'ruby', php: 'php', cs: 'csharp', swift: 'swift', scala: 'scala',
	c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
	sh: 'shell', bash: 'shell', zsh: 'shell',
	sql: 'sql', vue: 'vue', svelte: 'svelte', dart: 'dart', ex: 'elixir', exs: 'elixir',
	lua: 'lua', pl: 'perl', r: 'r', m: 'objectivec', mm: 'objectivec',
	json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown',
	css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml'
};

export function languageForPath(path: string): string {
	const filename = path.split('/').pop() ?? path;
	// Files that are identified by name, not extension.
	const byName: Record<string, string> = {
		'dockerfile': 'dockerfile', 'makefile': 'makefile', 'cmakelists.txt': 'cmake',
		'gemfile': 'ruby', 'rakefile': 'ruby', 'brewfile': 'ruby', 'vagrantfile': 'ruby'
	};
	const named = byName[filename.toLowerCase()];
	if (named) {
		return named;
	}
	const extension = filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : '';
	return EXTENSION_LANGUAGE[extension] ?? (extension || 'plaintext');
}

interface SymbolRule {
	readonly pattern: RegExp;
	readonly kind: SymbolKind;
	/** Capture group holding the name. Defaults to 1. */
	readonly group?: number;
}

const TS_RULES: readonly SymbolRule[] = [
	{ pattern: /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: SymbolKind.Class },
	{ pattern: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: SymbolKind.Interface },
	{ pattern: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: SymbolKind.Enum },
	{ pattern: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, kind: SymbolKind.Type },
	{ pattern: /^\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: SymbolKind.Function },
	// const foo = (…) => / const foo = async (…) => / const foo = function(…)
	{ pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]*)?=>|function\b)/, kind: SymbolKind.Function },
	{ pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::|=)/, kind: SymbolKind.Constant },
	{ pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::|=)/, kind: SymbolKind.Variable },
	// Class members: `foo(…) {`, `async foo(…)`, `get foo()`, `static foo(…)`.
	// Indented by at least one tab or space (a single tab is the common case, so `\s{2,}` would miss
	// most real code). The lookahead rules out control-flow keywords, which otherwise look identical.
	{
		pattern: /^\s+(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|abstract\s+|override\s+|async\s+|get\s+|set\s+)*\*?\s*(?!(?:if|for|while|switch|catch|return|function|new|typeof|await|do|else|try|throw|yield|delete|void|case|with)\b)([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{;=]+)?\s*[{;]/,
		kind: SymbolKind.Method
	}
];

const LANGUAGE_RULES: Record<string, readonly SymbolRule[]> = {
	typescript: TS_RULES,
	javascript: TS_RULES,
	vue: TS_RULES,
	svelte: TS_RULES,
	python: [
		{ pattern: /^\s*class\s+([A-Za-z_]\w*)/, kind: SymbolKind.Class },
		{ pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: SymbolKind.Function },
		{ pattern: /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/, kind: SymbolKind.Constant }
	],
	go: [
		{ pattern: /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/, kind: SymbolKind.Struct },
		{ pattern: /^\s*type\s+([A-Za-z_]\w*)\s+interface\b/, kind: SymbolKind.Interface },
		{ pattern: /^\s*type\s+([A-Za-z_]\w*)/, kind: SymbolKind.Type },
		{ pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: SymbolKind.Function },
		{ pattern: /^\s*(?:const|var)\s+([A-Za-z_]\w*)/, kind: SymbolKind.Variable }
	],
	rust: [
		{ pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: SymbolKind.Struct },
		{ pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: SymbolKind.Enum },
		{ pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: SymbolKind.Trait },
		{ pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, kind: SymbolKind.Function },
		{ pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, kind: SymbolKind.Type },
		{ pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:static|const)\s+([A-Z][A-Z0-9_]*)/, kind: SymbolKind.Constant },
		{ pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: SymbolKind.Module }
	],
	java: [
		{ pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/, kind: SymbolKind.Class },
		{ pattern: /^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_]\w*)/, kind: SymbolKind.Interface },
		{ pattern: /^\s*(?:public|private|protected)?\s*enum\s+([A-Za-z_]\w*)/, kind: SymbolKind.Enum },
		{ pattern: /^\s+(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],.\s?]+\s+([A-Za-z_]\w*)\s*\(/, kind: SymbolKind.Method }
	],
	csharp: [
		{ pattern: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*class\s+([A-Za-z_]\w*)/, kind: SymbolKind.Class },
		{ pattern: /^\s*(?:public|private|protected|internal)?\s*interface\s+([A-Za-z_]\w*)/, kind: SymbolKind.Interface },
		{ pattern: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|virtual\s+|override\s+|async\s+)*[\w<>[\],.\s?]+\s+([A-Za-z_]\w*)\s*\(/, kind: SymbolKind.Method }
	],
	ruby: [
		{ pattern: /^\s*class\s+([A-Z]\w*)/, kind: SymbolKind.Class },
		{ pattern: /^\s*module\s+([A-Z]\w*)/, kind: SymbolKind.Module },
		{ pattern: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: SymbolKind.Function }
	],
	php: [
		{ pattern: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: SymbolKind.Class },
		{ pattern: /^\s*interface\s+([A-Za-z_]\w*)/, kind: SymbolKind.Interface },
		{ pattern: /^\s*trait\s+([A-Za-z_]\w*)/, kind: SymbolKind.Trait },
		{ pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)/, kind: SymbolKind.Function }
	],
	kotlin: [
		{ pattern: /^\s*(?:open\s+|data\s+|sealed\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/, kind: SymbolKind.Class },
		{ pattern: /^\s*interface\s+([A-Za-z_]\w*)/, kind: SymbolKind.Interface },
		{ pattern: /^\s*(?:suspend\s+)?fun\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, kind: SymbolKind.Function },
		{ pattern: /^\s*(?:val|var)\s+([A-Za-z_]\w*)/, kind: SymbolKind.Variable }
	],
	swift: [
		{ pattern: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/, kind: SymbolKind.Class },
		{ pattern: /^\s*(?:public\s+|private\s+)?struct\s+([A-Za-z_]\w*)/, kind: SymbolKind.Struct },
		{ pattern: /^\s*(?:public\s+|private\s+)?protocol\s+([A-Za-z_]\w*)/, kind: SymbolKind.Interface },
		{ pattern: /^\s*(?:public\s+|private\s+|static\s+|override\s+)*func\s+([A-Za-z_]\w*)/, kind: SymbolKind.Function }
	],
	cpp: [
		{ pattern: /^\s*(?:template\s*<[^>]*>\s*)?class\s+([A-Za-z_]\w*)/, kind: SymbolKind.Class },
		{ pattern: /^\s*(?:template\s*<[^>]*>\s*)?struct\s+([A-Za-z_]\w*)/, kind: SymbolKind.Struct },
		{ pattern: /^\s*namespace\s+([A-Za-z_]\w*)/, kind: SymbolKind.Module },
		{ pattern: /^[\w:<>*&\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/, kind: SymbolKind.Function }
	],
	shell: [
		{ pattern: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/, kind: SymbolKind.Function }
	],
	sql: [
		{ pattern: /^\s*create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)/i, kind: SymbolKind.Struct },
		{ pattern: /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+["`]?([\w.]+)/i, kind: SymbolKind.Function }
	]
};

const IMPORT_RULES: Record<string, readonly RegExp[]> = {
	typescript: [
		/^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/,
		/^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/,
		/\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
		/\bimport\(\s*['"]([^'"]+)['"]\s*\)/
	],
	python: [
		/^\s*from\s+([\w.]+)\s+import\b/,
		/^\s*import\s+([\w.]+)/
	],
	go: [/^\s*(?:[\w.]+\s+)?"([^"]+)"\s*$/],
	rust: [/^\s*use\s+([\w:]+)/],
	java: [/^\s*import\s+(?:static\s+)?([\w.]+)/],
	csharp: [/^\s*using\s+(?:static\s+)?([\w.]+)/],
	ruby: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/],
	php: [/^\s*(?:use|require|include)(?:_once)?\s+['"]?([\w\\/.]+)['"]?/],
	kotlin: [/^\s*import\s+([\w.]+)/],
	swift: [/^\s*import\s+([\w.]+)/],
	cpp: [/^\s*#include\s*[<"]([^>"]+)[>"]/],
	c: [/^\s*#include\s*[<"]([^>"]+)[>"]/]
};

IMPORT_RULES['javascript'] = IMPORT_RULES['typescript'] as readonly RegExp[];
IMPORT_RULES['vue'] = IMPORT_RULES['typescript'] as readonly RegExp[];
IMPORT_RULES['svelte'] = IMPORT_RULES['typescript'] as readonly RegExp[];

function isLocalModule(specifier: string, language: string): boolean {
	if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
		return true;
	}
	if (language === 'python') {
		return !specifier.includes('.') || /^[a-z_]+$/.test(specifier.split('.')[0] ?? '');
	}
	if (language === 'cpp' || language === 'c') {
		// `#include "x"` is local by convention, `<x>` is a system header — the quote form already
		// reached us stripped, so fall back to "has a path separator or a project-looking name".
		return specifier.includes('/') || specifier.endsWith('.h') || specifier.endsWith('.hpp');
	}
	return false;
}

/** Strips string and comment content so declarations inside them are not mistaken for symbols. */
function isCommentLine(line: string, language: string): boolean {
	const trimmed = line.trimStart();
	if (language === 'python' || language === 'shell' || language === 'ruby' || language === 'yaml' || language === 'toml') {
		return trimmed.startsWith('#');
	}
	if (language === 'sql') {
		return trimmed.startsWith('--');
	}
	return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

export interface ExtractResult {
	readonly language: string;
	readonly symbols: readonly SymbolInfo[];
	readonly imports: readonly ImportInfo[];
	readonly lineCount: number;
}

export interface ExtractOptions {
	readonly maxLines?: number;
	readonly maxSymbols?: number;
}

/** Extracts symbols and imports from source text. Never throws on unknown languages. */
export function extractSymbols(path: string, content: string, options: ExtractOptions = {}): ExtractResult {
	const language = languageForPath(path);
	const rules = LANGUAGE_RULES[language] ?? [];
	const importRules = IMPORT_RULES[language] ?? [];
	const maxLines = options.maxLines ?? 20_000;
	const maxSymbols = options.maxSymbols ?? 800;

	const lines = content.split('\n');
	const symbols: SymbolInfo[] = [];
	const imports: ImportInfo[] = [];
	const seen = new Set<string>();
	// Track the innermost top-level container so methods can be attributed to their class.
	let container: string | undefined;
	let containerIndent = -1;

	const limit = Math.min(lines.length, maxLines);
	for (let index = 0; index < limit; index++) {
		const line = lines[index] as string;
		if (line.length > 2_000) {
			continue;
		}
		if (isCommentLine(line, language)) {
			continue;
		}
		const indent = line.length - line.trimStart().length;

		for (const rule of importRules) {
			const match = rule.exec(line);
			if (match?.[1]) {
				imports.push({ module: match[1], line: index + 1, local: isLocalModule(match[1], language) });
				break;
			}
		}
		if (symbols.length >= maxSymbols) {
			continue;
		}
		for (const rule of rules) {
			const match = rule.pattern.exec(line);
			const name = match?.[rule.group ?? 1];
			if (!match || !name) {
				continue;
			}
			// Reset the container when we dedent back to or past its level.
			if (container !== undefined && indent <= containerIndent && rule.kind !== SymbolKind.Method) {
				container = undefined;
				containerIndent = -1;
			}
			const isContainerKind = rule.kind === SymbolKind.Class || rule.kind === SymbolKind.Interface
				|| rule.kind === SymbolKind.Struct || rule.kind === SymbolKind.Trait || rule.kind === SymbolKind.Module;
			const key = `${rule.kind}:${name}:${index}`;
			if (!seen.has(key)) {
				seen.add(key);
				symbols.push({
					name,
					kind: rule.kind,
					line: index + 1,
					exported: /^\s*(?:export|pub|public)\b/.test(line),
					...(rule.kind === SymbolKind.Method && container ? { container } : {}),
					signature: line.trim().slice(0, 200)
				});
			}
			if (isContainerKind) {
				container = name;
				containerIndent = indent;
			}
			break;
		}
	}
	return { language, symbols, imports, lineCount: lines.length };
}
