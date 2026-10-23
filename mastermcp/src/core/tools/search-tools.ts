/**
 * Search tools.
 *
 * Retrieval quality is what determines whether the agent finds the bug (§114), so search is not one
 * regex pass: text, filename, and symbol search are separate tools with different ranking, and each
 * returns compact, citable results rather than raw dumps.
 *
 * Implemented in-process rather than shelling out to ripgrep so behaviour is identical on every
 * machine and there is no dependency on what the user happens to have installed.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { DEFAULT_SKIP_DIRS, isProbablyBinary, walk, type WalkEntry } from '../platform/fsx.ts';
import { throwIfCancelled } from '../platform/events.ts';
import { globToRegExp } from '../security/workspace-boundary.ts';
import { RiskClass } from '../security/command-classifier.ts';
import { arr, bool, int, objectSchema, requireValid, str } from './schema.ts';
import { extractSymbols, symbolKindLabel } from '../context/symbols.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

export interface TextMatch {
	readonly path: string;
	readonly line: number;
	readonly column: number;
	readonly text: string;
	readonly before: readonly string[];
	readonly after: readonly string[];
}

function buildQueryRegExp(query: string, options: { regex: boolean; caseSensitive: boolean; wholeWord: boolean }): RegExp {
	const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source;
	return new RegExp(wrapped, options.caseSensitive ? 'g' : 'gi');
}

/** Files worth searching: text, not too large, not in an ignored directory. */
function makeFilter(includeGlobs: readonly string[], excludeGlobs: readonly string[], maxBytes: number) {
	const includes = includeGlobs.map(globToRegExp);
	const excludes = excludeGlobs.map(globToRegExp);
	return (entry: WalkEntry): boolean => {
		if (entry.isDirectory) {
			return true;
		}
		if (entry.size > maxBytes) {
			return false;
		}
		if (excludes.some((pattern) => pattern.test(entry.relativePath) || pattern.test(basename(entry.relativePath)))) {
			return false;
		}
		if (includes.length === 0) {
			return true;
		}
		return includes.some((pattern) => pattern.test(entry.relativePath) || pattern.test(basename(entry.relativePath)));
	};
}

export interface SearchTextOptions {
	readonly query: string;
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
	readonly regex?: boolean;
	readonly caseSensitive?: boolean;
	readonly wholeWord?: boolean;
	readonly maxResults?: number;
	readonly contextLines?: number;
	readonly maxFileBytes?: number;
	readonly signal?: AbortSignal;
}

/** Core text search, reusable by the context engine as well as the tool. */
export async function searchText(root: string, options: SearchTextOptions): Promise<{
	matches: TextMatch[]; filesScanned: number; truncated: boolean;
}> {
	const pattern = buildQueryRegExp(options.query, {
		regex: options.regex === true,
		caseSensitive: options.caseSensitive === true,
		wholeWord: options.wholeWord === true
	});
	const maxResults = options.maxResults ?? 100;
	const contextLines = Math.min(options.contextLines ?? 1, 10);
	const filter = makeFilter(options.include ?? [], options.exclude ?? [], options.maxFileBytes ?? 2_000_000);

	const matches: TextMatch[] = [];
	let filesScanned = 0;
	let truncated = false;

	for await (const entry of walk(root, { filter, skipDirs: DEFAULT_SKIP_DIRS, ...(options.signal ? { signal: options.signal } : {}) })) {
		throwIfCancelled(options.signal);
		if (matches.length >= maxResults) {
			truncated = true;
			break;
		}
		let buffer: Buffer;
		try {
			buffer = await readFile(entry.path);
		} catch {
			continue;
		}
		if (isProbablyBinary(buffer)) {
			continue;
		}
		filesScanned++;
		const lines = buffer.toString('utf8').split('\n');
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] as string;
			pattern.lastIndex = 0;
			const found = pattern.exec(line);
			if (!found) {
				continue;
			}
			matches.push({
				path: entry.relativePath,
				line: index + 1,
				column: found.index + 1,
				// Very long lines (minified bundles) would blow the budget.
				text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
				before: lines.slice(Math.max(0, index - contextLines), index),
				after: lines.slice(index + 1, index + 1 + contextLines)
			});
			if (matches.length >= maxResults) {
				truncated = true;
				break;
			}
		}
	}
	return { matches, filesScanned, truncated };
}

export const searchTextTool: Tool = {
	name: 'search_text',
	description:
		'Search file contents across the workspace. Returns file:line matches with surrounding context. '
		+ 'Use this to find where something is used; use search_symbol to find where it is defined.',
	parameters: objectSchema({
		query: str('Text or regular expression to find.'),
		regex: bool('Treat the query as a regular expression. Default false.'),
		caseSensitive: bool('Match case. Default false.'),
		wholeWord: bool('Only match whole words. Useful to avoid matching "password" when looking for "pass".'),
		include: arr('Glob patterns to include, e.g. ["**/*.ts", "src/**"].', { type: 'string' }),
		exclude: arr('Glob patterns to exclude.', { type: 'string' }),
		maxResults: int('Maximum matches to return. Default 60.', { minimum: 1, maximum: 500, default: 60 }),
		contextLines: int('Lines of context around each match. Default 1.', { minimum: 0, maximum: 10, default: 1 })
	}, ['query']),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const result = await searchText(context.workspaceRoot, {
			query: String(args['query']),
			regex: args['regex'] === true,
			caseSensitive: args['caseSensitive'] === true,
			wholeWord: args['wholeWord'] === true,
			include: (args['include'] as string[]) ?? [],
			exclude: (args['exclude'] as string[]) ?? [],
			maxResults: typeof args['maxResults'] === 'number' ? args['maxResults'] : 60,
			contextLines: typeof args['contextLines'] === 'number' ? args['contextLines'] : 1,
			signal: context.signal
		});
		if (result.matches.length === 0) {
			return {
				output: `No matches for ${JSON.stringify(String(args['query']))} in ${result.filesScanned} files searched.`,
				data: { matches: 0, filesScanned: result.filesScanned }
			};
		}
		// Group by file: the model reads that far more reliably than a flat list.
		const byFile = new Map<string, TextMatch[]>();
		for (const match of result.matches) {
			const list = byFile.get(match.path) ?? [];
			list.push(match);
			byFile.set(match.path, list);
		}
		const sections: string[] = [];
		for (const [path, fileMatches] of byFile) {
			const lines = fileMatches.map((match) => {
				const context_ = [
					...match.before.map((line, i) => `  ${match.line - match.before.length + i}  ${line}`),
					`> ${match.line}  ${match.text}`,
					...match.after.map((line, i) => `  ${match.line + 1 + i}  ${line}`)
				];
				return context_.join('\n');
			});
			sections.push(`${path} (${fileMatches.length} match${fileMatches.length === 1 ? '' : 'es'})\n${lines.join('\n  ---\n')}`);
		}
		const output = sections.join('\n\n');
		const limit = context.settings.tools.maxOutputChars;
		return {
			output: (output.length > limit ? `${output.slice(0, limit)}\n… more matches omitted.` : output)
				+ (result.truncated ? `\n(result limit reached; narrow the query for more)` : ''),
			data: { matches: result.matches.length, files: byFile.size, filesScanned: result.filesScanned },
			...(result.truncated || output.length > limit ? { truncated: true } : {})
		};
	}
};

/** Ranks filename matches: exact basename beats prefix, which beats a substring anywhere. */
function scoreFilenameMatch(relativePath: string, query: string): number {
	const lowerPath = relativePath.toLowerCase();
	const lowerQuery = query.toLowerCase();
	const base = basename(lowerPath);
	const baseNoExt = base.slice(0, base.length - extname(base).length);

	if (baseNoExt === lowerQuery) { return 100; }
	if (base === lowerQuery) { return 95; }
	if (baseNoExt.startsWith(lowerQuery)) { return 80; }
	if (base.includes(lowerQuery)) { return 60; }
	if (lowerPath.includes(lowerQuery)) { return 40; }
	// Fuzzy: every character of the query appears in order.
	let cursor = 0;
	for (const char of lowerQuery) {
		cursor = lowerPath.indexOf(char, cursor);
		if (cursor === -1) { return 0; }
		cursor++;
	}
	return 15;
}

export const searchFilesTool: Tool = {
	name: 'search_files',
	description:
		'Find files by name or path fragment. Use when you know roughly what a file is called. '
		+ 'Results are ranked, closest name match first.',
	parameters: objectSchema({
		query: str('Filename or path fragment, e.g. "auth" or "src/api/user".'),
		maxResults: int('Maximum files to return. Default 40.', { minimum: 1, maximum: 300, default: 40 }),
		extensions: arr('Restrict to these extensions, e.g. ["ts", "tsx"].', { type: 'string' })
	}, ['query']),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const query = String(args['query']);
		const maxResults = typeof args['maxResults'] === 'number' ? args['maxResults'] : 40;
		const extensions = ((args['extensions'] as string[]) ?? []).map((ext) => ext.replace(/^\./, '').toLowerCase());

		const scored: { path: string; score: number; size: number }[] = [];
		for await (const entry of walk(context.workspaceRoot, { skipDirs: DEFAULT_SKIP_DIRS, signal: context.signal })) {
			if (extensions.length > 0) {
				const ext = extname(entry.relativePath).replace(/^\./, '').toLowerCase();
				if (!extensions.includes(ext)) {
					continue;
				}
			}
			const score = scoreFilenameMatch(entry.relativePath, query);
			if (score > 0) {
				scored.push({ path: entry.relativePath, score, size: entry.size });
			}
		}
		scored.sort((a, b) => (b.score - a.score) || a.path.length - b.path.length);
		const top = scored.slice(0, maxResults);
		if (top.length === 0) {
			return { output: `No files matching ${JSON.stringify(query)}.`, data: { matches: 0 } };
		}
		return {
			output: `${top.length} file(s) matching ${JSON.stringify(query)}:\n`
				+ top.map((entry) => `  ${entry.path}`).join('\n')
				+ (scored.length > top.length ? `\n… and ${scored.length - top.length} more.` : ''),
			data: { matches: scored.length, files: top.map((entry) => entry.path) }
		};
	}
};

export interface SymbolHit {
	readonly path: string;
	readonly name: string;
	readonly kind: string;
	readonly line: number;
	readonly signature: string;
	readonly container: string | undefined;
	readonly score: number;
}

/** Symbol search over the workspace. Also used by the context engine for retrieval. */
export async function searchSymbols(root: string, options: {
	query: string;
	kinds?: readonly string[];
	maxResults?: number;
	exact?: boolean;
	signal?: AbortSignal;
}): Promise<SymbolHit[]> {
	const query = options.query;
	const lowerQuery = query.toLowerCase();
	const maxResults = options.maxResults ?? 50;
	const hits: SymbolHit[] = [];

	for await (const entry of walk(root, {
		skipDirs: DEFAULT_SKIP_DIRS,
		filter: (candidate) => candidate.isDirectory || candidate.size <= 2_000_000,
		...(options.signal ? { signal: options.signal } : {})
	})) {
		throwIfCancelled(options.signal);
		let buffer: Buffer;
		try {
			buffer = await readFile(entry.path);
		} catch {
			continue;
		}
		if (isProbablyBinary(buffer)) {
			continue;
		}
		const { symbols } = extractSymbols(entry.relativePath, buffer.toString('utf8'));
		for (const symbol of symbols) {
			if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(symbol.kind)) {
				continue;
			}
			const lowerName = symbol.name.toLowerCase();
			let score = 0;
			if (symbol.name === query) {
				score = 100;
			} else if (lowerName === lowerQuery) {
				score = 90;
			} else if (options.exact) {
				continue;
			} else if (lowerName.startsWith(lowerQuery)) {
				score = 70;
			} else if (lowerName.includes(lowerQuery)) {
				score = 50;
			} else {
				continue;
			}
			// Exported symbols are far more likely to be what the caller meant.
			if (symbol.exported) {
				score += 8;
			}
			hits.push({
				path: entry.relativePath,
				name: symbol.name,
				kind: symbolKindLabel(symbol.kind),
				line: symbol.line,
				signature: symbol.signature,
				container: symbol.container,
				score
			});
		}
	}
	hits.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path));
	return hits.slice(0, maxResults);
}

export const searchSymbolTool: Tool = {
	name: 'search_symbol',
	description:
		'Find where a class, function, interface, type or method is *defined*. '
		+ 'Faster and more precise than text search when you are looking for a definition.',
	parameters: objectSchema({
		query: str('Symbol name or partial name.'),
		kinds: arr('Restrict to these kinds: class, interface, function, method, type, enum, constant, variable, struct, trait, module.', { type: 'string' }),
		exact: bool('Only exact name matches. Default false.'),
		maxResults: int('Maximum symbols to return. Default 40.', { minimum: 1, maximum: 200, default: 40 })
	}, ['query']),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const hits = await searchSymbols(context.workspaceRoot, {
			query: String(args['query']),
			kinds: (args['kinds'] as string[]) ?? [],
			exact: args['exact'] === true,
			maxResults: typeof args['maxResults'] === 'number' ? args['maxResults'] : 40,
			signal: context.signal
		});
		if (hits.length === 0) {
			return {
				output: `No symbol definition matching ${JSON.stringify(String(args['query']))}. `
					+ 'Try search_text to find usages instead.',
				data: { matches: 0 }
			};
		}
		const lines = hits.map((hit) =>
			`  ${hit.path}:${hit.line}  ${hit.kind} ${hit.container ? `${hit.container}.` : ''}${hit.name}\n      ${hit.signature}`
		);
		return {
			output: `${hits.length} definition(s):\n${lines.join('\n')}`,
			data: { matches: hits.length, symbols: hits.map((hit) => ({ path: hit.path, line: hit.line, name: hit.name, kind: hit.kind })) }
		};
	}
};

export const listDirectoryTool: Tool = {
	name: 'list_directory',
	description: 'List the contents of a directory. Use depth to see a shallow tree.',
	parameters: objectSchema({
		path: str('Workspace-relative directory. Defaults to the workspace root.', { default: '.' }),
		depth: int('How many levels deep to list. Default 1.', { minimum: 1, maximum: 5, default: 1 }),
		maxEntries: int('Maximum entries to return. Default 200.', { minimum: 1, maximum: 2000, default: 200 })
	}),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const resolved = await context.boundary.resolve(String(args['path'] ?? '.'), 'read');
		const depth = typeof args['depth'] === 'number' ? args['depth'] : 1;
		const maxEntries = typeof args['maxEntries'] === 'number' ? args['maxEntries'] : 200;

		const entries: { path: string; isDirectory: boolean; size: number }[] = [];
		for await (const entry of walk(resolved.absolute, {
			maxDepth: depth,
			includeDirectories: true,
			skipDirs: DEFAULT_SKIP_DIRS,
			maxEntries,
			signal: context.signal
		})) {
			entries.push({ path: entry.relativePath, isDirectory: entry.isDirectory, size: entry.size });
		}
		entries.sort((a, b) => (Number(b.isDirectory) - Number(a.isDirectory)) || a.path.localeCompare(b.path));
		const label = resolved.relative || '.';
		if (entries.length === 0) {
			return { output: `${label} is empty (or everything in it is ignored).`, data: { entries: 0 } };
		}
		return {
			output: `${label} (${entries.length} entries):\n`
				+ entries.map((entry) => `  ${entry.isDirectory ? '📁' : '  '} ${entry.path}${entry.isDirectory ? '/' : ''}`).join('\n'),
			data: { entries: entries.length, items: entries }
		};
	}
};
