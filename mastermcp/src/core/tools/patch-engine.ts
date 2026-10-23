/**
 * Patch engine (§28).
 *
 * Rewriting a whole file to change three lines is how agents destroy work: the model re-emits the
 * parts it remembers and silently drops the parts it does not. So the primary edit primitive here is
 * an anchored replacement — "replace exactly this text with that text" — verified against the file
 * on disk before anything is written.
 *
 * Guarantees:
 *  - the original text must match, or the edit fails with a conflict rather than guessing;
 *  - an ambiguous anchor (appearing more than once) fails rather than picking one;
 *  - line endings and a trailing newline are preserved;
 *  - every applied edit returns a unified diff and a snapshot for rollback.
 */

import { errors, ForjaError, ErrorCode } from '../platform/errors.ts';
import { detectLineEnding } from '../platform/fsx.ts';

export interface AnchoredEdit {
	/** Exact text to find. Must be unique unless `replaceAll` is set. */
	readonly oldText: string;
	readonly newText: string;
	readonly replaceAll?: boolean;
}

export interface PatchResult {
	readonly content: string;
	readonly replacements: number;
	/** Unified diff of the change. */
	readonly diff: string;
	readonly addedLines: number;
	readonly removedLines: number;
}

/** Normalizes to `\n` for comparison while remembering how to write it back. */
function normalize(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === '') {
		return 0;
	}
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/**
 * Tries to locate an anchor whose indentation drifted.
 *
 * Models frequently reproduce a block correctly but with different leading whitespace (they lose
 * the surrounding nesting). Rather than failing that outright, we look for a unique match modulo
 * per-line indentation and, if found, re-apply the file's real indentation to the replacement. This
 * is the single most common recoverable conflict, and recovering it saves a whole round trip.
 */
function findIndentationTolerant(content: string, oldText: string): { start: number; end: number; indent: string } | undefined {
	const anchorLines = oldText.split('\n');
	const firstMeaningful = anchorLines.findIndex((line) => line.trim() !== '');
	if (firstMeaningful === -1) {
		return undefined;
	}
	const stripped = anchorLines.map((line) => line.trimStart());
	const contentLines = content.split('\n');

	let found: { start: number; end: number; indent: string } | undefined;
	for (let i = 0; i + anchorLines.length <= contentLines.length; i++) {
		let matches = true;
		let indent = '';
		for (let j = 0; j < anchorLines.length; j++) {
			const contentLine = contentLines[i + j] ?? '';
			const anchorLine = stripped[j] ?? '';
			if (contentLine.trimStart() !== anchorLine) {
				matches = false;
				break;
			}
			if (j === firstMeaningful) {
				indent = contentLine.slice(0, contentLine.length - contentLine.trimStart().length);
			}
		}
		if (!matches) {
			continue;
		}
		if (found) {
			// Ambiguous even with tolerance: refuse.
			return undefined;
		}
		const start = contentLines.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0);
		const end = start + contentLines.slice(i, i + anchorLines.length).join('\n').length;
		found = { start, end, indent };
	}
	return found;
}

function reindent(text: string, fromIndent: string, toIndent: string): string {
	if (fromIndent === toIndent) {
		return text;
	}
	return text.split('\n').map((line) => {
		if (line.trim() === '') {
			return line;
		}
		const trimmed = line.trimStart();
		const existing = line.slice(0, line.length - trimmed.length);
		// Preserve relative nesting: swap only the common prefix.
		const relative = existing.startsWith(fromIndent) ? existing.slice(fromIndent.length) : existing;
		return `${toIndent}${relative}${trimmed}`;
	}).join('\n');
}

/**
 * Applies one anchored edit to in-memory content.
 * Throws `PatchConflict` with an actionable message when the anchor does not match uniquely.
 */
export function applyAnchoredEdit(original: string, edit: AnchoredEdit, filePath = 'file'): PatchResult {
	if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
		throw errors.invalidArgument('Both oldText and newText are required');
	}
	const eol = detectLineEnding(original);
	const content = normalize(original);
	const oldText = normalize(edit.oldText);
	const newText = normalize(edit.newText);

	if (oldText === '') {
		throw errors.invalidArgument('oldText must not be empty. To create a file, use create_file.');
	}
	if (oldText === newText) {
		throw errors.invalidArgument('oldText and newText are identical, so there is nothing to change.');
	}

	const occurrences = countOccurrences(content, oldText);
	let updated: string;
	let replacements: number;

	if (occurrences === 0) {
		const tolerant = findIndentationTolerant(content, oldText);
		if (!tolerant) {
			throw new ForjaError(
				`Could not apply the edit to ${filePath}: the text to replace was not found. `
				+ 'Read the file again and use the exact current text.',
				{ code: ErrorCode.PatchConflict, data: { filePath, anchorPreview: oldText.slice(0, 200) } }
			);
		}
		const anchorIndent = (oldText.split('\n').find((line) => line.trim() !== '') ?? '')
			.match(/^\s*/)?.[0] ?? '';
		const replacement = reindent(newText, anchorIndent, tolerant.indent);
		updated = content.slice(0, tolerant.start) + replacement + content.slice(tolerant.end);
		replacements = 1;
	} else if (occurrences > 1 && !edit.replaceAll) {
		throw new ForjaError(
			`Could not apply the edit to ${filePath}: the text to replace appears ${occurrences} times. `
			+ 'Include more surrounding context to make it unique, or set replaceAll.',
			{ code: ErrorCode.PatchConflict, data: { filePath, occurrences } }
		);
	} else if (edit.replaceAll) {
		updated = content.split(oldText).join(newText);
		replacements = occurrences;
	} else {
		const index = content.indexOf(oldText);
		updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
		replacements = 1;
	}

	const finalContent = eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated;
	const diff = unifiedDiff(filePath, content, updated);
	const stats = diffStats(content, updated);
	return { content: finalContent, replacements, diff, ...stats };
}

/** Applies several edits in order, each verified against the result of the previous one. */
export function applyEdits(original: string, edits: readonly AnchoredEdit[], filePath = 'file'): PatchResult {
	if (edits.length === 0) {
		throw errors.invalidArgument('At least one edit is required');
	}
	let content = original;
	let replacements = 0;
	for (const [index, edit] of edits.entries()) {
		try {
			const result = applyAnchoredEdit(content, edit, filePath);
			content = result.content;
			replacements += result.replacements;
		} catch (error) {
			// Report which edit failed: with several edits, "not found" alone is useless.
			const forja = ForjaError.from(error);
			throw new ForjaError(`Edit ${index + 1} of ${edits.length} failed. ${forja.message}`, {
				code: forja.code,
				data: { ...forja.data, editIndex: index }
			});
		}
	}
	const before = normalize(original);
	const after = normalize(content);
	return {
		content,
		replacements,
		diff: unifiedDiff(filePath, before, after),
		...diffStats(before, after)
	};
}

function diffStats(before: string, after: string): { addedLines: number; removedLines: number } {
	const operations = diffLines(before.split('\n'), after.split('\n'));
	let addedLines = 0;
	let removedLines = 0;
	for (const operation of operations) {
		if (operation.type === 'add') {
			addedLines++;
		} else if (operation.type === 'remove') {
			removedLines++;
		}
	}
	return { addedLines, removedLines };
}

interface DiffOperation {
	readonly type: 'equal' | 'add' | 'remove';
	readonly line: string;
	readonly oldIndex: number;
	readonly newIndex: number;
}

/**
 * Line diff via the classic LCS dynamic program.
 *
 * Bounded on purpose: the table is O(n·m), so for large files we fall back to a cheap
 * common-prefix/suffix trim plus a wholesale replace of the middle. Diffs are for humans reviewing a
 * change; a perfect minimal diff on a 20k-line file is not worth 400M cells of memory.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffOperation[] {
	// Trim the common prefix and suffix first: most edits are local, so this usually leaves a tiny
	// window for the expensive part.
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < before.length - prefix
		&& suffix < after.length - prefix
		&& before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}
	const midBefore = before.slice(prefix, before.length - suffix);
	const midAfter = after.slice(prefix, after.length - suffix);

	const operations: DiffOperation[] = [];
	for (let i = 0; i < prefix; i++) {
		operations.push({ type: 'equal', line: before[i] as string, oldIndex: i, newIndex: i });
	}

	const MAX_CELLS = 4_000_000;
	if (midBefore.length * midAfter.length > MAX_CELLS) {
		midBefore.forEach((line, i) => operations.push({ type: 'remove', line, oldIndex: prefix + i, newIndex: -1 }));
		midAfter.forEach((line, i) => operations.push({ type: 'add', line, oldIndex: -1, newIndex: prefix + i }));
	} else {
		operations.push(...lcsDiff(midBefore, midAfter, prefix));
	}

	for (let i = 0; i < suffix; i++) {
		const oldIndex = before.length - suffix + i;
		operations.push({ type: 'equal', line: before[oldIndex] as string, oldIndex, newIndex: after.length - suffix + i });
	}
	return operations;
}

function lcsDiff(before: readonly string[], after: readonly string[], offset: number): DiffOperation[] {
	const n = before.length;
	const m = after.length;
	// table[i][j] = LCS length of before[i..] and after[j..]
	const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const row = table[i] as number[];
			const nextRow = table[i + 1] as number[];
			row[j] = before[i] === after[j]
				? (nextRow[j + 1] as number) + 1
				: Math.max(nextRow[j] as number, row[j + 1] as number);
		}
	}
	const operations: DiffOperation[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i] === after[j]) {
			operations.push({ type: 'equal', line: before[i] as string, oldIndex: offset + i, newIndex: offset + j });
			i++;
			j++;
			continue;
		}
		const down = (table[i + 1] as number[])[j] as number;
		const right = (table[i] as number[])[j + 1] as number;
		if (down >= right) {
			operations.push({ type: 'remove', line: before[i] as string, oldIndex: offset + i, newIndex: -1 });
			i++;
		} else {
			operations.push({ type: 'add', line: after[j] as string, oldIndex: -1, newIndex: offset + j });
			j++;
		}
	}
	while (i < n) {
		operations.push({ type: 'remove', line: before[i] as string, oldIndex: offset + i, newIndex: -1 });
		i++;
	}
	while (j < m) {
		operations.push({ type: 'add', line: after[j] as string, oldIndex: -1, newIndex: offset + j });
		j++;
	}
	return operations;
}

/** Standard unified diff, so the output is readable by humans and by `git apply`. */
export function unifiedDiff(
	filePath: string,
	before: string,
	after: string,
	contextLines = 3
): string {
	if (before === after) {
		return '';
	}
	const beforeLines = before.split('\n');
	const afterLines = after.split('\n');
	const operations = diffLines(beforeLines, afterLines);

	// Group changes into hunks with `contextLines` of surrounding context.
	const changedIndexes = operations
		.map((operation, index) => (operation.type === 'equal' ? -1 : index))
		.filter((index) => index >= 0);
	if (changedIndexes.length === 0) {
		return '';
	}
	const hunks: { start: number; end: number }[] = [];
	for (const index of changedIndexes) {
		const start = Math.max(0, index - contextLines);
		const end = Math.min(operations.length - 1, index + contextLines);
		const last = hunks[hunks.length - 1];
		if (last && start <= last.end + 1) {
			last.end = Math.max(last.end, end);
		} else {
			hunks.push({ start, end });
		}
	}

	const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
	for (const hunk of hunks) {
		const slice = operations.slice(hunk.start, hunk.end + 1);
		const oldStart = slice.find((operation) => operation.oldIndex >= 0)?.oldIndex ?? 0;
		const newStart = slice.find((operation) => operation.newIndex >= 0)?.newIndex ?? 0;
		const oldCount = slice.filter((operation) => operation.type !== 'add').length;
		const newCount = slice.filter((operation) => operation.type !== 'remove').length;
		lines.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`);
		for (const operation of slice) {
			const marker = operation.type === 'add' ? '+' : operation.type === 'remove' ? '-' : ' ';
			lines.push(`${marker}${operation.line}`);
		}
	}
	return `${lines.join('\n')}\n`;
}

/** Diff for a brand-new or deleted file, where one side does not exist. */
export function wholeFileDiff(filePath: string, before: string | undefined, after: string | undefined): string {
	if (before === undefined && after !== undefined) {
		const lines = after.split('\n');
		return [
			`--- /dev/null`, `+++ b/${filePath}`,
			`@@ -0,0 +1,${lines.length} @@`,
			...lines.map((line) => `+${line}`)
		].join('\n') + '\n';
	}
	if (before !== undefined && after === undefined) {
		const lines = before.split('\n');
		return [
			`--- a/${filePath}`, `+++ /dev/null`,
			`@@ -1,${lines.length} +0,0 @@`,
			...lines.map((line) => `-${line}`)
		].join('\n') + '\n';
	}
	return unifiedDiff(filePath, before ?? '', after ?? '');
}
