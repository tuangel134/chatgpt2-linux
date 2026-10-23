/**
 * Git access through the CLI.
 *
 * Deliberately not a library: the CLI is the only implementation that always agrees with what the
 * user sees in their terminal, handles every repo layout, and needs no native build.
 *
 * Safety rule: local index, commit and branch operations are exposed with explicit tool
 * confirmation and remain separate from file checkpoints. Remote operations are fast-forward/no-force
 * variants and are still behind the daemon's explicit confirmation.
 */

import { join } from 'node:path';
import { execCommand, shellQuoteForPlatform as shellQuote, type ProcessResult } from './process.ts';
import { type Logger, nullLogger } from './logger.ts';
import { errors } from './errors.ts';

export type FileChangeStatus =
	| 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';

export interface FileChange {
	readonly path: string;
	readonly status: FileChangeStatus;
	readonly oldPath?: string;
}

export interface GitStatus {
	readonly branch: string;
	readonly upstream?: string;
	readonly ahead: number;
	readonly behind: number;
	readonly staged: FileChange[];
	readonly unstaged: FileChange[];
	readonly untracked: string[];
	readonly conflicted: string[];
	readonly clean: boolean;
	readonly detached: boolean;
}

export interface CommitInfo {
	readonly hash: string;
	readonly shortHash: string;
	readonly author: string;
	readonly email: string;
	readonly date: string;
	readonly subject: string;
	readonly body: string;
}

export interface DiffOptions {
	readonly staged?: boolean;
	readonly paths?: readonly string[];
	readonly contextLines?: number;
	readonly maxBytes?: number;
	/** Compare against a ref instead of the index/working tree. */
	readonly ref?: string;
}

export interface LogOptions {
	readonly limit?: number;
	readonly paths?: readonly string[];
	readonly since?: string;
	readonly ref?: string;
}

export interface WorktreeInfo {
	readonly path: string;
	readonly head: string;
	readonly branch: string | undefined;
	readonly locked: boolean;
}

/** NUL-delimited record separator: safe for multi-line commit bodies. */
const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e';

export class GitService {
	readonly root: string;
	private readonly logger: Logger;
	private readonly timeoutMs: number;

	constructor(root: string, logger: Logger = nullLogger, timeoutMs = 30_000) {
		this.root = root;
		this.logger = logger.child('git');
		this.timeoutMs = timeoutMs;
	}

	/** Returns a service rooted at the repository containing `root`, or undefined if there is none. */
	static async detect(root: string, logger: Logger = nullLogger): Promise<GitService | undefined> {
		const result = await execCommand('git rev-parse --show-toplevel', { cwd: root, timeoutMs: 15_000 });
		if (result.exitCode !== 0) {
			return undefined;
		}
		const top = result.stdout.trim().split('\n')[0]?.trim();
		if (!top) {
			return undefined;
		}
		return new GitService(top, logger);
	}

	static async isAvailable(): Promise<boolean> {
		const result = await execCommand('git --version', { cwd: process.cwd(), timeoutMs: 10_000 });
		return result.exitCode === 0;
	}

	private async run(args: string, options: { maxOutputBytes?: number; allowFailure?: boolean } = {}): Promise<ProcessResult> {
		// `-c core.quotepath=false` keeps non-ASCII paths readable instead of octal-escaped.
		const result = await execCommand(`git -c core.quotepath=false ${args}`, {
			cwd: this.root,
			timeoutMs: this.timeoutMs,
			...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {})
		});
		if (result.exitCode !== 0 && !options.allowFailure) {
			this.logger.debug('git command failed', { args, exitCode: result.exitCode, stderr: result.stderr.slice(0, 400) });
		}
		return result;
	}

	async status(): Promise<GitStatus> {
		const result = await this.run('status --porcelain=v2 --branch -z --untracked-files=all');
		if (result.exitCode !== 0) {
			throw errors.internal(`git status failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
		return parseStatusV2(result.stdout);
	}

	async diff(options: DiffOptions = {}): Promise<string> {
		const parts = ['diff', '--no-color', '--no-ext-diff'];
		if (options.staged) {
			parts.push('--cached');
		}
		if (options.contextLines !== undefined) {
			parts.push(`--unified=${Math.max(0, Math.min(options.contextLines, 50))}`);
		}
		if (options.ref) {
			parts.push(shellQuote(options.ref));
		}
		if (options.paths && options.paths.length > 0) {
			parts.push('--', ...options.paths.map((path) => shellQuote(path)));
		}
		const maxBytes = options.maxBytes ?? 400_000;
		const result = await this.run(parts.join(' '), { maxOutputBytes: maxBytes });
		if (result.exitCode !== 0) {
			throw errors.internal(`git diff failed: ${result.stderr.trim()}`);
		}
		return result.stdout;
	}

	async diffStat(options: DiffOptions = {}): Promise<{ files: number; insertions: number; deletions: number; perFile: { path: string; insertions: number; deletions: number }[] }> {
		const parts = ['diff', '--numstat', '--no-color'];
		if (options.staged) {
			parts.push('--cached');
		}
		if (options.ref) {
			parts.push(shellQuote(options.ref));
		}
		const result = await this.run(parts.join(' '));
		return parseNumstat(result.stdout);
	}

	async log(options: LogOptions = {}): Promise<CommitInfo[]> {
		const parts = ['log', `--pretty=format:${LOG_FORMAT}`, '--no-color'];
		parts.push(`-n ${Math.max(1, Math.min(options.limit ?? 20, 1000))}`);
		if (options.since) {
			parts.push(`--since=${shellQuote(options.since)}`);
		}
		if (options.ref) {
			parts.push(shellQuote(options.ref));
		}
		if (options.paths && options.paths.length > 0) {
			parts.push('--', ...options.paths.map((path) => shellQuote(path)));
		}
		const result = await this.run(parts.join(' '), { maxOutputBytes: 500_000, allowFailure: true });
		if (result.exitCode !== 0) {
			// A repository with no commits yet is a normal state, not an error.
			return [];
		}
		return parseLog(result.stdout);
	}

	async show(ref: string, path?: string): Promise<string> {
		const target = path ? `${shellQuote(`${ref}:${path}`)}` : shellQuote(ref);
		const result = await this.run(`show --no-color ${target}`, { maxOutputBytes: 500_000, allowFailure: true });
		if (result.exitCode !== 0) {
			throw errors.notFound(`git show failed for ${ref}${path ? `:${path}` : ''}`, { ref, path });
		}
		return result.stdout;
	}

	async blame(path: string, line: number): Promise<{ hash: string; author: string; date: string; summary: string } | undefined> {
		const result = await this.run(
			`blame --line-porcelain -L ${Math.max(1, line)},${Math.max(1, line)} -- ${shellQuote(path)}`,
			{ allowFailure: true }
		);
		if (result.exitCode !== 0) {
			return undefined;
		}
		const lines = result.stdout.split('\n');
		const hash = lines[0]?.split(' ')[0] ?? '';
		const field = (name: string): string => lines.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1) ?? '';
		if (!hash) {
			return undefined;
		}
		return { hash, author: field('author'), date: field('author-time'), summary: field('summary') };
	}

	async currentCommit(): Promise<string | undefined> {
		const result = await this.run('rev-parse HEAD', { allowFailure: true });
		return result.exitCode === 0 ? result.stdout.trim() : undefined;
	}

	async currentBranch(): Promise<string | undefined> {
		const result = await this.run('rev-parse --abbrev-ref HEAD', { allowFailure: true });
		const value = result.stdout.trim();
		return result.exitCode === 0 && value && value !== 'HEAD' ? value : undefined;
	}

	async listTrackedFiles(limit = 100_000): Promise<string[]> {
		const result = await this.run('ls-files -z', { maxOutputBytes: 8_000_000, allowFailure: true });
		if (result.exitCode !== 0) {
			return [];
		}
		return result.stdout.split('\0').filter((entry) => entry.length > 0).slice(0, limit);
	}

	async isIgnored(path: string): Promise<boolean> {
		const result = await this.run(`check-ignore -q ${shellQuote(path)}`, { allowFailure: true });
		return result.exitCode === 0;
	}

	async revisionExists(ref: string): Promise<boolean> {
		const result = await this.run(`rev-parse --verify --quiet ${shellQuote(ref)}`, { allowFailure: true });
		return result.exitCode === 0;
	}

	async fileHistory(path: string, limit = 10): Promise<CommitInfo[]> {
		return this.log({ paths: [path], limit });
	}

	async changedFilesBetween(from: string, to = 'HEAD'): Promise<FileChange[]> {
		const result = await this.run(
			`diff --name-status -z ${shellQuote(from)} ${shellQuote(to)}`,
			{ maxOutputBytes: 2_000_000, allowFailure: true }
		);
		if (result.exitCode !== 0) {
			return [];
		}
		return parseNameStatusZ(result.stdout);
	}

	/** Files touched in the working tree, staged or not — the agent's "what did we change" view. */
	async modifiedFiles(): Promise<string[]> {
		const status = await this.status();
		const paths = new Set<string>();
		for (const change of [...status.staged, ...status.unstaged]) {
			paths.add(change.path);
		}
		for (const path of status.untracked) {
			paths.add(path);
		}
		return [...paths].sort();
	}

	/** Stages only the explicitly supplied workspace-relative paths. */
	async stage(paths: readonly string[]): Promise<void> {
		if (paths.length === 0) {
			throw errors.invalidArgument('At least one path is required to stage Git changes.');
		}
		const result = await this.run(`add -- ${paths.map(path => shellQuote(path)).join(' ')}`, { allowFailure: true });
		if (result.exitCode !== 0) {
			throw errors.internal(`git add failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
	}

	/** Creates a local commit from the already staged index. It never stages implicitly. */
	async commit(message: string): Promise<CommitInfo | undefined> {
		const text = message.trim();
		if (!text) {
			throw errors.invalidArgument('A non-empty commit message is required.');
		}
		// Keep project hooks enabled: a local agent commit must not bypass the repository's own checks.
		const result = await this.run(`commit -m ${shellQuote(text)}`, { allowFailure: true, maxOutputBytes: 20_000 });
		if (result.exitCode !== 0) {
			throw errors.internal(`git commit failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
		return (await this.log({ limit: 1 }))[0];
	}

	/** Creates a local branch without checking out a remote or rewriting history. */
	async createBranch(name: string, fromRef?: string): Promise<void> {
		const branch = name.trim();
		if (!branch || branch.startsWith('-') || branch.includes('..') || branch.includes('\\') || branch.includes(' ')) {
			throw errors.invalidArgument('The branch name is invalid.');
		}
		const check = await this.run(`check-ref-format --branch ${shellQuote(branch)}`, { allowFailure: true });
		if (check.exitCode !== 0) {
			throw errors.invalidArgument(`The branch name is invalid: ${branch}`);
		}
		const result = await this.run(`switch -c ${shellQuote(branch)}${fromRef ? ` ${shellQuote(fromRef)}` : ''}`, { allowFailure: true });
		if (result.exitCode !== 0) {
			throw errors.internal(`git switch failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
	}

	/** Switches to an existing local branch; uncommitted work is never discarded. */
	async switchBranch(name: string): Promise<void> {
		const branch = name.trim();
		if (!branch || branch.startsWith('-')) {
			throw errors.invalidArgument('A branch name is required.');
		}
		const result = await this.run(`switch ${shellQuote(branch)}`, { allowFailure: true });
		if (result.exitCode !== 0) {
			throw errors.internal(`git switch failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
	}

	async lastCommitMessage(): Promise<string | undefined> {
		const commits = await this.log({ limit: 1 });
		const first = commits[0];
		if (!first) {
			return undefined;
		}
		return first.body ? `${first.subject}\n\n${first.body}` : first.subject;
	}

	// -----------------------------------------------------------------------
	// Worktrees — the isolation mechanism for parallel subagents (§44).
	// -----------------------------------------------------------------------

	async worktreeList(): Promise<WorktreeInfo[]> {
		const result = await this.run('worktree list --porcelain', { allowFailure: true });
		if (result.exitCode !== 0) {
			return [];
		}
		const out: WorktreeInfo[] = [];
		let path = '';
		let head = '';
		let branch: string | undefined;
		let locked = false;
		const flush = () => {
			if (path) {
				out.push({ path, head, branch, locked });
			}
			path = '';
			head = '';
			branch = undefined;
			locked = false;
		};
		for (const line of result.stdout.split('\n')) {
			if (line.startsWith('worktree ')) {
				flush();
				path = line.slice('worktree '.length).trim();
			} else if (line.startsWith('HEAD ')) {
				head = line.slice('HEAD '.length).trim();
			} else if (line.startsWith('branch ')) {
				branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
			} else if (line.trim() === 'locked') {
				locked = true;
			}
		}
		flush();
		return out;
	}

	async worktreeAdd(path: string, branch: string, options: { fromRef?: string } = {}): Promise<void> {
		const from = options.fromRef ? ` ${shellQuote(options.fromRef)}` : '';
		const result = await this.run(`worktree add -b ${shellQuote(branch)} ${shellQuote(path)}${from}`, { allowFailure: true });
		if (result.exitCode !== 0) {
			throw errors.internal(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
	}

	async worktreeRemove(path: string, force = false): Promise<void> {
		const result = await this.run(`worktree remove${force ? ' --force' : ''} ${shellQuote(path)}`, { allowFailure: true });
		if (result.exitCode !== 0) {
			throw errors.internal(`git worktree remove failed: ${result.stderr.trim()}`);
		}
	}

	/** Fetches refs without changing the working tree. */
	async fetch(remote?: string): Promise<{ stdout: string; stderr: string }> {
		const value = remote?.trim();
		if (value && (value.startsWith('-') || /[\s\0]/.test(value))) throw errors.invalidArgument('The Git remote name is invalid.');
		const result = await this.run(`fetch --prune${value ? ` ${shellQuote(value)}` : ' --all'}`, { allowFailure: true, maxOutputBytes: 40_000 });
		if (result.exitCode !== 0) throw errors.internal(`git fetch failed: ${result.stderr.trim() || result.stdout.trim()}`);
		return { stdout: result.stdout, stderr: result.stderr };
	}

	/** Pulls only by fast-forward; it never creates an implicit merge commit. */
	async pull(remote?: string, branch?: string): Promise<{ stdout: string; stderr: string }> {
		const args = ['pull', '--ff-only'];
		for (const value of [remote, branch]) {
			const trimmed = value?.trim();
			if (trimmed) {
				if (trimmed.startsWith('-') || /[\s\0]/.test(trimmed)) throw errors.invalidArgument('The Git remote or branch name is invalid.');
				args.push(shellQuote(trimmed));
			}
		}
		const result = await this.run(args.join(' '), { allowFailure: true, maxOutputBytes: 40_000 });
		if (result.exitCode !== 0) throw errors.internal(`git pull failed: ${result.stderr.trim() || result.stdout.trim()}`);
		return { stdout: result.stdout, stderr: result.stderr };
	}

	/** Pushes the current branch without force or refspec rewriting. */
	async push(remote?: string, branch?: string): Promise<{ stdout: string; stderr: string }> {
		const args = ['push'];
		for (const value of [remote, branch]) {
			const trimmed = value?.trim();
			if (trimmed) {
				if (trimmed.startsWith('-') || /[\s\0]/.test(trimmed)) throw errors.invalidArgument('The Git remote or branch name is invalid.');
				args.push(shellQuote(trimmed));
			}
		}
		const result = await this.run(args.join(' '), { allowFailure: true, maxOutputBytes: 40_000 });
		if (result.exitCode !== 0) throw errors.internal(`git push failed: ${result.stderr.trim() || result.stdout.trim()}`);
		return { stdout: result.stdout, stderr: result.stderr };
	}

	async stashPush(message = 'Tessarion checkpoint'): Promise<{ stdout: string; stderr: string }> {
		const text = message.trim();
		if (!text || text.length > 200) throw errors.invalidArgument('A stash message is required and must be under 200 characters.');
		const result = await this.run(`stash push --include-untracked -m ${shellQuote(text)}`, { allowFailure: true, maxOutputBytes: 20_000 });
		if (result.exitCode !== 0) throw errors.internal(`git stash failed: ${result.stderr.trim() || result.stdout.trim()}`);
		return { stdout: result.stdout, stderr: result.stderr };
	}

	async stashList(): Promise<string[]> {
		const result = await this.run('stash list --format=%gd%x1f%gs', { allowFailure: true, maxOutputBytes: 40_000 });
		if (result.exitCode !== 0) return [];
		return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
	}

	async stashPop(ref = 'stash@{0}'): Promise<{ stdout: string; stderr: string }> {
		if (!/^stash@\{\d+\}$/.test(ref)) throw errors.invalidArgument('The stash reference is invalid.');
		const result = await this.run(`stash pop ${shellQuote(ref)}`, { allowFailure: true, maxOutputBytes: 40_000 });
		if (result.exitCode !== 0) throw errors.internal(`git stash pop failed: ${result.stderr.trim() || result.stdout.trim()}`);
		return { stdout: result.stdout, stderr: result.stderr };
	}
}

// ---------------------------------------------------------------------------
// Parsers. Kept as free functions so they can be unit tested without a repo.
// ---------------------------------------------------------------------------

function statusFromXY(code: string): FileChangeStatus {
	switch (code) {
		case 'A': return 'added';
		case 'M': return 'modified';
		case 'D': return 'deleted';
		case 'R': return 'renamed';
		case 'C': return 'copied';
		case 'U': return 'conflicted';
		case 'T': return 'modified';
		default: return 'modified';
	}
}

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 * In `-z` mode records are NUL separated, and renames put the original path in its own field.
 */
export function parseStatusV2(raw: string): GitStatus {
	const records = raw.split('\0');
	let branch = '';
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	let detached = false;
	const staged: FileChange[] = [];
	const unstaged: FileChange[] = [];
	const untracked: string[] = [];
	const conflicted: string[] = [];

	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) {
			continue;
		}
		if (record.startsWith('# branch.head ')) {
			branch = record.slice('# branch.head '.length).trim();
			detached = branch === '(detached)';
			continue;
		}
		if (record.startsWith('# branch.upstream ')) {
			upstream = record.slice('# branch.upstream '.length).trim();
			continue;
		}
		if (record.startsWith('# branch.ab ')) {
			const match = /\+(\d+)\s+-(\d+)/.exec(record);
			ahead = Number(match?.[1] ?? 0);
			behind = Number(match?.[2] ?? 0);
			continue;
		}
		if (record.startsWith('# ')) {
			continue;
		}
		const kind = record[0];
		if (kind === '?') {
			untracked.push(record.slice(2));
			continue;
		}
		if (kind === '!') {
			continue;
		}
		if (kind === 'u') {
			// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
			const fields = record.split(' ');
			const path = fields.slice(10).join(' ');
			if (path) {
				conflicted.push(path);
				unstaged.push({ path, status: 'conflicted' });
			}
			continue;
		}
		if (kind !== '1' && kind !== '2') {
			continue;
		}
		// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
		// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
		const fields = record.split(' ');
		const xy = fields[1] ?? '..';
		const pathStart = kind === '1' ? 8 : 9;
		const path = fields.slice(pathStart).join(' ');
		if (!path) {
			continue;
		}
		let oldPath: string | undefined;
		if (kind === '2') {
			oldPath = records[i + 1] ?? undefined;
			i++;
		}
		const indexCode = xy[0] ?? '.';
		const treeCode = xy[1] ?? '.';
		if (indexCode !== '.' && indexCode !== ' ') {
			staged.push({ path, status: statusFromXY(indexCode), ...(oldPath ? { oldPath } : {}) });
		}
		if (treeCode !== '.' && treeCode !== ' ') {
			unstaged.push({ path, status: statusFromXY(treeCode), ...(oldPath ? { oldPath } : {}) });
		}
	}

	return {
		branch, ...(upstream ? { upstream } : {}), ahead, behind, staged, unstaged, untracked, conflicted,
		clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
		detached
	};
}

export function parseLog(raw: string): CommitInfo[] {
	const out: CommitInfo[] = [];
	for (const record of raw.split('\x1e')) {
		const trimmed = record.replace(/^\n+/, '');
		if (!trimmed.trim()) {
			continue;
		}
		const fields = trimmed.split('\x1f');
		const hash = fields[0]?.trim();
		if (!hash) {
			continue;
		}
		out.push({
			hash,
			shortHash: fields[1]?.trim() ?? hash.slice(0, 7),
			author: fields[2] ?? '',
			email: fields[3] ?? '',
			date: fields[4] ?? '',
			subject: fields[5] ?? '',
			body: (fields[6] ?? '').trim()
		});
	}
	return out;
}

export function parseNumstat(raw: string): { files: number; insertions: number; deletions: number; perFile: { path: string; insertions: number; deletions: number }[] } {
	const perFile: { path: string; insertions: number; deletions: number }[] = [];
	let insertions = 0;
	let deletions = 0;
	for (const line of raw.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		const [addedRaw, removedRaw, ...pathParts] = line.split('\t');
		const path = pathParts.join('\t');
		if (!path) {
			continue;
		}
		// Binary files report "-" instead of a count.
		const added = addedRaw === '-' ? 0 : Number(addedRaw ?? 0);
		const removed = removedRaw === '-' ? 0 : Number(removedRaw ?? 0);
		insertions += Number.isFinite(added) ? added : 0;
		deletions += Number.isFinite(removed) ? removed : 0;
		perFile.push({ path, insertions: added, deletions: removed });
	}
	return { files: perFile.length, insertions, deletions, perFile };
}

export function parseNameStatusZ(raw: string): FileChange[] {
	const fields = raw.split('\0').filter((field) => field.length > 0);
	const out: FileChange[] = [];
	for (let i = 0; i < fields.length; i++) {
		const code = fields[i];
		if (!code) {
			continue;
		}
		const letter = code[0] ?? 'M';
		if (letter === 'R' || letter === 'C') {
			// Rename/copy records carry two paths.
			const oldPath = fields[++i] ?? '';
			const newPath = fields[++i] ?? '';
			if (newPath) {
				out.push({ path: newPath, status: statusFromXY(letter), oldPath });
			}
			continue;
		}
		const path = fields[++i] ?? '';
		if (path) {
			out.push({ path, status: statusFromXY(letter) });
		}
	}
	return out;
}

/** Where a worktree for a subagent should live: outside the repo, so it never self-indexes. */
export function worktreePathFor(repoRoot: string, label: string): string {
	const safe = label.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
	return join(repoRoot, '..', `.forja-worktrees`, `${safe}-${Date.now().toString(36)}`);
}
