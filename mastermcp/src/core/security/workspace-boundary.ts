/**
 * Workspace boundary enforcement (§82).
 *
 * Every file path an agent or an MCP server hands us goes through here. The rules:
 *  - resolve symlinks **before** checking containment, otherwise `link -> /etc` defeats the check;
 *  - for paths that do not exist yet, resolve the nearest existing ancestor instead (you cannot
 *    realpath a file you are about to create);
 *  - deny by default outside the workspace, with an explicit allow-list escape hatch;
 *  - block sensitive files by glob even *inside* the workspace (`.env`, keys, credential stores).
 */

import { isAbsolute, join, relative, resolve, sep, dirname, basename } from 'node:path';
import { realpath } from 'node:fs/promises';
import { errors } from '../platform/errors.ts';

export interface BoundaryOptions {
	readonly workspaceRoot: string;
	readonly allowOutsideWorkspace?: boolean;
	/** Absolute paths (or path prefixes) that may be accessed even when outside the workspace. */
	readonly allowedExternalPaths?: readonly string[];
	/** Glob patterns that are never readable, evaluated against the workspace-relative path. */
	readonly blockedPaths?: readonly string[];
	/** Extra roots that are always allowed, e.g. git worktrees created for subagents. */
	readonly additionalRoots?: readonly string[];
}

export type AccessKind = 'read' | 'write' | 'delete' | 'execute';

export interface ResolvedPath {
	/** Absolute, symlink-resolved path. */
	readonly absolute: string;
	/** Path relative to the workspace root, POSIX separators. Empty for the root itself. */
	readonly relative: string;
	readonly insideWorkspace: boolean;
}

/**
 * Minimal glob matcher for the patterns we actually support in `security.blockedPaths`:
 * `*` (not crossing `/`), `**` (crossing `/`), `?`, and character classes. Implemented directly
 * because pulling a glob dependency in for this would be a supply-chain risk for a security control.
 */
export function globToRegExp(pattern: string): RegExp {
	let source = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i] as string;
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				// `**/` should also match zero directories.
				if (pattern[i + 2] === '/') {
					source += '(?:.*/)?';
					i += 2;
				} else {
					source += '.*';
					i++;
				}
			} else {
				source += '[^/]*';
			}
			continue;
		}
		if (char === '?') {
			source += '[^/]';
			continue;
		}
		if (char === '[') {
			const end = pattern.indexOf(']', i);
			if (end > i) {
				source += pattern.slice(i, end + 1);
				i = end;
				continue;
			}
		}
		source += char.replace(/[.+^${}()|\\]/g, '\\$&');
	}
	try {
		return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
	} catch {
		// A workspace setting is untrusted input. An invalid glob must not prevent the
		// daemon from opening the workspace; make that one pattern match nothing.
		return new RegExp('(?!)');
	}
}

/** Resolves the deepest existing ancestor, so paths that do not exist yet can still be checked. */
async function realpathOrNearest(target: string): Promise<string> {
	let current = resolve(target);
	const suffix: string[] = [];
	for (let depth = 0; depth < 64; depth++) {
		try {
			const resolved = await realpath(current);
			return suffix.length > 0 ? join(resolved, ...suffix.reverse()) : resolved;
		} catch {
			const parent = dirname(current);
			if (parent === current) {
				return resolve(target);
			}
			suffix.push(basename(current));
			current = parent;
		}
	}
	return resolve(target);
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	if (rel === '') {
		return true;
	}
	return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export class WorkspaceBoundary {
	readonly workspaceRoot: string;
	private readonly allowOutside: boolean;
	private readonly allowedExternal: string[];
	private readonly blocked: RegExp[];
	private readonly blockedPatterns: string[];
	private readonly additionalRoots: string[];
	private resolvedRoot: string | undefined;

	constructor(options: BoundaryOptions) {
		this.workspaceRoot = resolve(options.workspaceRoot);
		this.allowOutside = options.allowOutsideWorkspace === true;
		this.allowedExternal = (options.allowedExternalPaths ?? []).map((path) => resolve(path));
		this.blockedPatterns = [...(options.blockedPaths ?? [])];
		this.blocked = this.blockedPatterns.map(globToRegExp);
		this.additionalRoots = (options.additionalRoots ?? []).map((path) => resolve(path));
	}

	private async root(): Promise<string> {
		if (!this.resolvedRoot) {
			// The workspace root itself may be behind a symlink (common on macOS /tmp).
			this.resolvedRoot = await realpathOrNearest(this.workspaceRoot);
		}
		return this.resolvedRoot;
	}

	/** Which glob, if any, blocks this workspace-relative path. */
	blockedBy(relativePath: string): string | undefined {
		const normalized = relativePath.split(sep).join('/');
		const index = this.blocked.findIndex((pattern) => pattern.test(normalized));
		if (index >= 0) {
			return this.blockedPatterns[index];
		}
		// Also match on the basename so `.env` blocks `config/.env` without needing `**/.env`.
		const base = normalized.split('/').pop() ?? '';
		const baseIndex = this.blocked.findIndex((pattern) => pattern.test(base));
		return baseIndex >= 0 ? this.blockedPatterns[baseIndex] : undefined;
	}

	/**
	 * Resolves a user- or model-supplied path and throws unless the access is permitted.
	 * `kind` matters: reading `.env` is blocked, but so is writing to it, and the messages differ.
	 */
	async resolve(inputPath: string, kind: AccessKind = 'read'): Promise<ResolvedPath> {
		if (typeof inputPath !== 'string' || inputPath.trim() === '') {
			throw errors.invalidArgument('A path is required');
		}
		// Reject NUL bytes outright: they truncate paths in some syscalls.
		if (inputPath.includes('\0')) {
			throw errors.invalidArgument('Path contains a null byte');
		}
		const root = await this.root();
		const candidate = isAbsolute(inputPath) ? inputPath : join(root, inputPath);
		const absolute = await realpathOrNearest(candidate);
		const insideWorkspace = isWithin(root, absolute)
			|| this.additionalRoots.some((extra) => isWithin(extra, absolute));

		if (!insideWorkspace) {
			const allowed = this.allowOutside
				|| this.allowedExternal.some((prefix) => isWithin(prefix, absolute));
			if (!allowed) {
				throw errors.outsideWorkspace(
					`${kind === 'read' ? 'Reading' : 'Writing'} "${inputPath}" is outside the workspace. `
					+ 'Enable forja.security.allowOutsideWorkspace, or add the path to '
					+ 'forja.security.allowedExternalPaths, to permit it.',
					{ path: inputPath, resolved: absolute, workspaceRoot: root }
				);
			}
		}

		const relativePath = insideWorkspace ? relative(root, absolute).split(sep).join('/') : absolute;
		const blockedBy = this.blockedBy(relativePath);
		if (blockedBy) {
			throw errors.denied(
				`"${relativePath}" is on the protected list (matched "${blockedBy}") and the agent cannot `
				+ `${kind} it. Adjust forja.security.blockedPaths if this is intentional.`,
				{ path: relativePath, pattern: blockedBy, kind }
			);
		}
		return { absolute, relative: relativePath, insideWorkspace };
	}

	/** Non-throwing variant for filtering candidate lists. */
	async allows(inputPath: string, kind: AccessKind = 'read'): Promise<boolean> {
		try {
			await this.resolve(inputPath, kind);
			return true;
		} catch {
			return false;
		}
	}

	withAdditionalRoot(root: string): WorkspaceBoundary {
		return new WorkspaceBoundary({
			workspaceRoot: this.workspaceRoot,
			allowOutsideWorkspace: this.allowOutside,
			allowedExternalPaths: this.allowedExternal,
			blockedPaths: this.blockedPatterns,
			additionalRoots: [...this.additionalRoots, root]
		});
	}
}
