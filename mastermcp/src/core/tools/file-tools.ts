/**
 * File tools.
 *
 * Every one of these goes through the workspace boundary, records a reviewable diff, and keeps the
 * content it replaced so a checkpoint can undo it. `patch_file` is the primary editing tool;
 * `write_file` exists for genuine rewrites and says so in its description, because a model given an
 * easy full-rewrite tool will use it for three-line changes and lose the rest of the file.
 */

import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errors, ForjaError, ErrorCode } from '../platform/errors.ts';
import {
	countLines, ensureDir, movePath, readTextFile, removePath, splitLines, statSafe, writeFileAtomic
} from '../platform/fsx.ts';
import { applyEdits, unifiedDiff, wholeFileDiff, type AnchoredEdit } from './patch-engine.ts';
import { arr, bool, int, objectSchema, requireValid, str } from './schema.ts';
import { RiskClass } from '../security/command-classifier.ts';
import type { FileChangeRecord, Tool, ToolContext, ToolResult } from './types.ts';

/** Reads a file for the model, with line numbers so it can cite and patch precisely. */
function withLineNumbers(content: string, startLine: number): string {
	const lines = content.split('\n');
	const width = String(startLine + lines.length - 1).length;
	return lines
		.map((line, index) => `${String(startLine + index).padStart(width, ' ')}\t${line}`)
		.join('\n');
}

function record(context: ToolContext, change: FileChangeRecord): void {
	context.onFileChange?.(change);
}

async function readExisting(absolute: string): Promise<string | undefined> {
	try {
		return await readFile(absolute, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw ForjaError.from(error);
	}
}

async function confirmEdit(context: ToolContext, kind: 'edit' | 'delete', paths: string[], detail: string): Promise<void> {
	const autoApproved = context.settings.agent.autoApproveEdits && kind === 'edit';
	if (autoApproved || !context.confirm) {
		return;
	}
	const approved = await context.confirm({
		title: kind === 'delete' ? `Delete ${paths.join(', ')}?` : `Apply changes to ${paths.join(', ')}?`,
		detail,
		risk: kind === 'delete' ? RiskClass.Dangerous : RiskClass.Modify,
		kind,
		paths
	});
	if (!approved) {
		throw errors.denied(`You declined the change to ${paths.join(', ')}.`, { paths });
	}
}

export const readFileTool: Tool = {
	name: 'read_file',
	description:
		'Read a text file from the workspace. Returns the content with line numbers. '
		+ 'Always read a file before editing it. Use startLine/endLine for large files.',
	parameters: objectSchema({
		path: str('Workspace-relative path to the file.'),
		startLine: int('First line to return, 1-based. Omit to start at the beginning.', { minimum: 1 }),
		endLine: int('Last line to return, inclusive. Omit to read to the end.', { minimum: 1 })
	}, ['path']),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const resolved = await context.boundary.resolve(String(args['path']), 'read');
		const content = await readTextFile(resolved.absolute, context.settings.tools.maxFileReadBytes);
		const total = countLines(content);

		const startLine = typeof args['startLine'] === 'number' ? Math.max(1, args['startLine']) : 1;
		const endLine = typeof args['endLine'] === 'number' ? Math.min(total, args['endLine']) : total;
		const lines = splitLines(content);
		const slice = lines.slice(startLine - 1, endLine).join('\n');

		// Budget guard: a single huge file must not eat the whole context.
		const limit = context.settings.tools.maxOutputChars;
		const truncated = slice.length > limit;
		const body = truncated ? slice.slice(0, limit) : slice;

		const header = `${resolved.relative} (${total} lines`
			+ (startLine > 1 || endLine < total ? `, showing ${startLine}-${endLine}` : '')
			+ ')';
		return {
			output: `${header}\n${withLineNumbers(body, startLine)}`
				+ (truncated ? `\n… output truncated. Read a narrower line range to see the rest.` : ''),
			data: { path: resolved.relative, totalLines: total, startLine, endLine },
			...(truncated ? { truncated: true } : {})
		};
	}
};

export const readFilesTool: Tool = {
	name: 'read_files',
	description:
		'Read several files at once. Prefer this over repeated read_file calls when exploring: '
		+ 'it costs one round trip instead of many.',
	parameters: objectSchema({
		paths: arr('Workspace-relative paths to read.', { type: 'string' }),
		maxLinesPerFile: int('Cap on lines returned per file. Defaults to 400.', { minimum: 1, default: 400 })
	}, ['paths']),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const paths = (args['paths'] as string[]).slice(0, context.settings.context.maxFilesPerQuery);
		const maxLines = typeof args['maxLinesPerFile'] === 'number' ? args['maxLinesPerFile'] : 400;
		const budget = context.settings.tools.maxOutputChars;

		const sections: string[] = [];
		const results: { path: string; lines?: number; error?: string }[] = [];
		let used = 0;
		let truncated = false;

		for (const path of paths) {
			if (used >= budget) {
				truncated = true;
				sections.push(`--- (remaining files omitted: output budget reached) ---`);
				break;
			}
			try {
				const resolved = await context.boundary.resolve(path, 'read');
				const content = await readTextFile(resolved.absolute, context.settings.tools.maxFileReadBytes);
				const lines = splitLines(content);
				const shown = lines.slice(0, maxLines).join('\n');
				const section = `--- ${resolved.relative} (${lines.length} lines`
					+ (lines.length > maxLines ? `, first ${maxLines}` : '') + ') ---\n'
					+ withLineNumbers(shown.slice(0, Math.max(0, budget - used)), 1);
				sections.push(section);
				used += section.length;
				results.push({ path: resolved.relative, lines: lines.length });
			} catch (error) {
				const message = ForjaError.from(error).message;
				sections.push(`--- ${path} ---\n(could not read: ${message})`);
				results.push({ path, error: message });
			}
		}
		return {
			output: sections.join('\n\n'),
			data: { files: results },
			...(truncated ? { truncated: true } : {})
		};
	}
};

export const patchFileTool: Tool = {
	name: 'patch_file',
	description:
		'Edit an existing file by replacing exact text. This is the preferred way to change code: '
		+ 'it only touches what you name, so the rest of the file cannot be lost. '
		+ 'oldText must match the current file exactly and be unique unless replaceAll is true. '
		+ 'You can pass several edits; they are applied in order.',
	parameters: objectSchema({
		path: str('Workspace-relative path to the file to edit.'),
		edits: {
			type: 'array',
			description: 'Edits to apply in order.',
			items: {
				type: 'object',
				properties: {
					oldText: str('Exact text to replace, including indentation.'),
					newText: str('Replacement text.'),
					replaceAll: bool('Replace every occurrence instead of requiring uniqueness.')
				},
				required: ['oldText', 'newText']
			}
		}
	}, ['path', 'edits']),
	source: 'builtin',
	risk: RiskClass.Modify,
	mutates: true,
	parallelSafe: false,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const resolved = await context.boundary.resolve(String(args['path']), 'write');
		const before = await readExisting(resolved.absolute);
		if (before === undefined) {
			throw errors.notFound(
				`${resolved.relative} does not exist. Use create_file to make a new file.`,
				{ path: resolved.relative }
			);
		}
		const edits = (args['edits'] as AnchoredEdit[]) ?? [];
		if (edits.length === 0) {
			throw errors.invalidArgument('At least one edit is required.');
		}
		const result = applyEdits(before, edits, resolved.relative);
		await confirmEdit(context, 'edit', [resolved.relative], result.diff);
		await writeFileAtomic(resolved.absolute, result.content);

		record(context, {
			path: resolved.relative, kind: 'modify', diff: result.diff,
			addedLines: result.addedLines, removedLines: result.removedLines,
			contentBefore: before, contentAfter: result.content
		});
		return {
			output: `Edited ${resolved.relative}: ${result.replacements} replacement(s), `
				+ `+${result.addedLines}/-${result.removedLines} lines.\n${result.diff}`,
			data: { path: resolved.relative, replacements: result.replacements },
			changes: [{
				path: resolved.relative, kind: 'modify', diff: result.diff,
				addedLines: result.addedLines, removedLines: result.removedLines,
				contentBefore: before, contentAfter: result.content
			}]
		};
	}
};

export const createFileTool: Tool = {
	name: 'create_file',
	description:
		'Create a new file with the given content. Fails if the file already exists, '
		+ 'so it can never silently overwrite work. Parent directories are created as needed.',
	parameters: objectSchema({
		path: str('Workspace-relative path for the new file.'),
		content: str('Full content of the new file.')
	}, ['path', 'content']),
	source: 'builtin',
	risk: RiskClass.Modify,
	mutates: true,
	parallelSafe: false,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const resolved = await context.boundary.resolve(String(args['path']), 'write');
		const existing = await statSafe(resolved.absolute);
		if (existing) {
			throw new ForjaError(
				`${resolved.relative} already exists. Use patch_file to change it, or write_file to replace it.`,
				{ code: ErrorCode.PatchConflict, data: { path: resolved.relative } }
			);
		}
		const content = String(args['content']);
		const diff = wholeFileDiff(resolved.relative, undefined, content);
		await confirmEdit(context, 'edit', [resolved.relative], diff);
		await ensureDir(dirname(resolved.absolute));
		await writeFileAtomic(resolved.absolute, content);

		const change: FileChangeRecord = {
			path: resolved.relative, kind: 'create', diff,
			addedLines: countLines(content), removedLines: 0,
			contentBefore: undefined, contentAfter: content
		};
		record(context, change);
		return {
			output: `Created ${resolved.relative} (${countLines(content)} lines).`,
			data: { path: resolved.relative },
			changes: [change]
		};
	}
};

export const writeFileTool: Tool = {
	name: 'write_file',
	description:
		'Replace a file\'s entire content. Only use this for a genuine full rewrite or for generated '
		+ 'files; for ordinary edits use patch_file, which cannot accidentally drop the parts of the '
		+ 'file you did not mention.',
	parameters: objectSchema({
		path: str('Workspace-relative path to write.'),
		content: str('New full content of the file.')
	}, ['path', 'content']),
	source: 'builtin',
	risk: RiskClass.Modify,
	mutates: true,
	parallelSafe: false,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const resolved = await context.boundary.resolve(String(args['path']), 'write');
		const before = await readExisting(resolved.absolute);
		const content = String(args['content']);
		if (before === content) {
			return { output: `${resolved.relative} already has that exact content; nothing changed.` };
		}
		const diff = before === undefined
			? wholeFileDiff(resolved.relative, undefined, content)
			: unifiedDiff(resolved.relative, before, content);
		await confirmEdit(context, 'edit', [resolved.relative], diff);
		await ensureDir(dirname(resolved.absolute));
		await writeFileAtomic(resolved.absolute, content);

		const change: FileChangeRecord = {
			path: resolved.relative,
			kind: before === undefined ? 'create' : 'modify',
			diff,
			addedLines: countLines(content),
			removedLines: before ? countLines(before) : 0,
			contentBefore: before,
			contentAfter: content
		};
		record(context, change);
		return {
			output: `${before === undefined ? 'Created' : 'Rewrote'} ${resolved.relative} (${countLines(content)} lines).\n${diff}`,
			data: { path: resolved.relative },
			changes: [change]
		};
	}
};

export const deleteFileTool: Tool = {
	name: 'delete_file',
	description:
		'Delete a file from the workspace. Requires confirmation unless the user has trusted the agent. '
		+ 'The content is snapshotted first so the step can be undone.',
	parameters: objectSchema({
		path: str('Workspace-relative path to delete.'),
		reason: str('Why this file should be deleted. Shown to the user in the confirmation.')
	}, ['path']),
	source: 'builtin',
	risk: RiskClass.Dangerous,
	mutates: true,
	parallelSafe: false,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const resolved = await context.boundary.resolve(String(args['path']), 'delete');
		const info = await statSafe(resolved.absolute);
		if (!info) {
			return { output: `${resolved.relative} does not exist; nothing to delete.` };
		}
		if (info.isDirectory) {
			throw errors.invalidArgument(
				`${resolved.relative} is a directory. Deleting directories is not available to the agent; `
				+ 'ask the user, or remove the files individually.'
			);
		}
		const before = await readExisting(resolved.absolute);
		const diff = wholeFileDiff(resolved.relative, before ?? '', undefined);
		// Deletion always asks, regardless of autoApproveEdits: it is not reversible from the editor.
		if (context.confirm) {
			const approved = await context.confirm({
				title: `Delete ${resolved.relative}?`,
				detail: String(args['reason'] ?? 'The agent wants to remove this file.'),
				risk: RiskClass.Dangerous,
				kind: 'delete',
				paths: [resolved.relative]
			});
			if (!approved) {
				throw errors.denied(`You declined deleting ${resolved.relative}.`);
			}
		}
		await removePath(resolved.absolute);
		const change: FileChangeRecord = {
			path: resolved.relative, kind: 'delete', diff,
			addedLines: 0, removedLines: before ? countLines(before) : 0,
			contentBefore: before, contentAfter: undefined
		};
		record(context, change);
		return { output: `Deleted ${resolved.relative}.`, data: { path: resolved.relative }, changes: [change] };
	}
};

export const moveFileTool: Tool = {
	name: 'move_file',
	description: 'Move or rename a file within the workspace. Both paths are boundary checked.',
	parameters: objectSchema({
		from: str('Current workspace-relative path.'),
		to: str('New workspace-relative path.')
	}, ['from', 'to']),
	source: 'builtin',
	risk: RiskClass.Modify,
	mutates: true,
	parallelSafe: false,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const from = await context.boundary.resolve(String(args['from']), 'write');
		const to = await context.boundary.resolve(String(args['to']), 'write');
		const info = await statSafe(from.absolute);
		if (!info) {
			throw errors.notFound(`${from.relative} does not exist.`);
		}
		if (await statSafe(to.absolute)) {
			throw new ForjaError(`${to.relative} already exists.`, { code: ErrorCode.PatchConflict });
		}
		const content = info.isFile ? await readExisting(from.absolute) : undefined;
		await confirmEdit(context, 'edit', [from.relative, to.relative], `Move ${from.relative} → ${to.relative}`);
		await movePath(from.absolute, to.absolute);

		const change: FileChangeRecord = {
			path: to.relative, kind: 'move', oldPath: from.relative,
			diff: `--- a/${from.relative}\n+++ b/${to.relative}\n@@ file moved @@\n`,
			addedLines: 0, removedLines: 0, contentBefore: content, contentAfter: content
		};
		record(context, change);
		return {
			output: `Moved ${from.relative} → ${to.relative}.`,
			data: { from: from.relative, to: to.relative },
			changes: [change]
		};
	}
};
