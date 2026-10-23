/**
 * Filesystem helpers used by every tool that touches the workspace.
 *
 * Everything here is deliberately boring and safe: atomic writes (so a crash mid-edit cannot
 * truncate a source file), binary sniffing (so we never feed a .png into a prompt), and a
 * cancellable directory walker that honours ignore rules.
 */

import { createHash } from 'node:crypto';
import {
	mkdir, readFile, writeFile, rename, stat, lstat, readdir, unlink, rm, realpath, copyFile, open
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { ForjaError, ErrorCode, errors } from './errors.ts';
import { throwIfCancelled } from './events.ts';

export interface FileStat {
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly isSymbolicLink: boolean;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function statSafe(path: string): Promise<FileStat | undefined> {
	try {
		const s = await lstat(path);
		return {
			path,
			size: s.size,
			mtimeMs: s.mtimeMs,
			isFile: s.isFile(),
			isDirectory: s.isDirectory(),
			isSymbolicLink: s.isSymbolicLink()
		};
	} catch {
		return undefined;
	}
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

/**
 * Atomic write: temp file in the same directory + rename. Same-directory matters because rename is
 * only atomic within a filesystem.
 */
export async function writeFileAtomic(
	path: string,
	content: string | Uint8Array,
	options: { mode?: number } = {}
): Promise<void> {
	await ensureDir(dirname(path));
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temp, content, options.mode !== undefined ? { mode: options.mode } : {});
		await rename(temp, path);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw ForjaError.from(error, ErrorCode.StorageError);
	}
}

export async function readTextFile(path: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
	const info = await statSafe(path);
	if (!info) {
		throw errors.notFound(`File not found: ${path}`, { path });
	}
	if (info.isDirectory) {
		throw errors.invalidArgument(`Path is a directory, not a file: ${path}`, { path });
	}
	if (info.size > maxBytes) {
		throw errors.invalidArgument(
			`File is too large to read as text (${formatBytes(info.size)} > ${formatBytes(maxBytes)}): ${path}`,
			{ path, size: info.size, maxBytes }
		);
	}
	const buffer = await readFile(path);
	if (isProbablyBinary(buffer)) {
		throw errors.invalidArgument(`File appears to be binary: ${path}`, { path });
	}
	return stripBom(buffer.toString('utf8'));
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
	try {
		const text = await readFile(path, 'utf8');
		return JSON.parse(stripBom(text)) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw ForjaError.from(error, ErrorCode.StorageError);
	}
}

export async function writeJsonFile(path: string, value: unknown, pretty = true): Promise<void> {
	await writeFileAtomic(path, `${JSON.stringify(value, undefined, pretty ? '\t' : undefined)}\n`);
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Binary sniffing: a NUL byte in the first 8 KB, or a high ratio of non-text control bytes.
 * Mirrors what git does, which is what users expect.
 */
export function isProbablyBinary(buffer: Uint8Array): boolean {
	const limit = Math.min(buffer.length, 8192);
	if (limit === 0) {
		return false;
	}
	let suspicious = 0;
	for (let i = 0; i < limit; i++) {
		const byte = buffer[i] as number;
		if (byte === 0) {
			return true;
		}
		// Allow tab(9), LF(10), CR(13), FF(12), ESC(27) — reject other C0 controls.
		if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13 && byte !== 27) {
			suspicious++;
		}
	}
	return suspicious / limit > 0.3;
}

export function hashContent(content: string | Uint8Array): string {
	return createHash('sha256').update(content).digest('hex');
}

export function shortHash(content: string | Uint8Array, length = 12): string {
	return hashContent(content).slice(0, length);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function detectLineEnding(text: string): '\n' | '\r\n' {
	const firstLf = text.indexOf('\n');
	if (firstLf > 0 && text.charCodeAt(firstLf - 1) === 13) {
		return '\r\n';
	}
	return '\n';
}

export interface WalkEntry {
	/** Absolute path. */
	readonly path: string;
	/** Path relative to the walk root, always with forward slashes. */
	readonly relativePath: string;
	readonly isDirectory: boolean;
	readonly size: number;
	readonly mtimeMs: number;
}

export interface WalkOptions {
	/** Directory names to skip entirely. */
	readonly skipDirs?: ReadonlySet<string>;
	/** Predicate applied to relative paths; return false to skip. */
	readonly filter?: (entry: WalkEntry) => boolean;
	readonly maxDepth?: number;
	readonly maxEntries?: number;
	readonly includeDirectories?: boolean;
	/** Follow symlinked directories. Off by default: prevents cycles and boundary escapes. */
	readonly followSymlinks?: boolean;
	readonly signal?: AbortSignal;
}

export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
	'.git', 'node_modules', '.svn', '.hg', 'dist', 'out', 'build', 'target', '.next', '.nuxt',
	'.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gradle',
	'.idea', '.vscode-test', 'coverage', '.turbo', '.parcel-cache', '.cache', 'vendor',
	'Pods', '.terraform', '.serverless', '.pnpm-store', '.yarn', 'bower_components', '.forja',
	'.tox', '.eggs', '.dart_tool', '.stack-work', 'bin', 'obj', '.output', '.svelte-kit'
]);

/** Async generator walk: streams entries so callers can stop early on huge repos. */
export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
	const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
	const maxDepth = options.maxDepth ?? 32;
	const maxEntries = options.maxEntries ?? 200_000;
	const seenRealPaths = new Set<string>();
	let emitted = 0;

	const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			break;
		}
		throwIfCancelled(options.signal);
		let dirents;
		try {
			dirents = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const dirent of dirents) {
			if (emitted >= maxEntries) {
				return;
			}
			const absolute = join(current.dir, dirent.name);
			let isDirectory = dirent.isDirectory();
			let isSymlink = dirent.isSymbolicLink();

			if (isSymlink) {
				if (!options.followSymlinks) {
					continue;
				}
				const resolved = await realpath(absolute).catch(() => undefined);
				if (!resolved || seenRealPaths.has(resolved)) {
					continue;
				}
				seenRealPaths.add(resolved);
				const info = await statSafe(resolved);
				if (!info) {
					continue;
				}
				isDirectory = info.isDirectory;
			}

			if (isDirectory && skipDirs.has(dirent.name)) {
				continue;
			}

			const info = await statSafe(absolute);
			const entry: WalkEntry = {
				path: absolute,
				relativePath: toPosix(relative(root, absolute)),
				isDirectory,
				size: info?.size ?? 0,
				mtimeMs: info?.mtimeMs ?? 0
			};

			if (options.filter && !options.filter(entry)) {
				continue;
			}

			if (isDirectory) {
				if (options.includeDirectories) {
					emitted++;
					yield entry;
				}
				if (current.depth + 1 <= maxDepth) {
					stack.push({ dir: absolute, depth: current.depth + 1 });
				}
			} else {
				emitted++;
				yield entry;
			}
		}
	}
}

export function toPosix(path: string): string {
	return sep === '/' ? path : path.split(sep).join('/');
}

export function fromPosix(path: string): string {
	return sep === '/' ? path : path.split('/').join(sep);
}

export async function removePath(path: string, recursive = false): Promise<void> {
	if (recursive) {
		await rm(path, { recursive: true, force: true });
		return;
	}
	await unlink(path);
}

export async function movePath(from: string, to: string): Promise<void> {
	await ensureDir(dirname(to));
	try {
		await rename(from, to);
	} catch (error) {
		// Cross-device rename fails with EXDEV: fall back to copy + delete.
		if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
			throw ForjaError.from(error, ErrorCode.StorageError);
		}
		await copyFile(from, to);
		await unlink(from);
	}
}

/** Reads at most `maxBytes` from the head of a file without loading the whole thing. */
export async function readHead(path: string, maxBytes: number): Promise<Buffer> {
	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Number of lines, using the convention every editor and `wc -l` agrees on: a trailing newline
 * terminates the last line rather than starting a new empty one. `"a\n"` is one line, not two.
 */
export function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	let newlines = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			newlines++;
		}
	}
	return text.charCodeAt(text.length - 1) === 10 ? newlines : newlines + 1;
}

/** Splits into lines without the phantom empty entry a trailing newline would produce. */
export function splitLines(text: string): string[] {
	const lines = text.split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}
