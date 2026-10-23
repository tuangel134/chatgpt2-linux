/**
 * Git tools (§72).
 *
 * Safe reads are separated from local state changes. Staging, commits and branches require
 * confirmation; pushing and history rewriting remain terminal-only and never happen implicitly.
 */

import { errors } from '../platform/errors.ts';
import { RiskClass } from '../security/command-classifier.ts';
import { arr, bool, int, objectSchema, requireValid, str } from './schema.ts';
import type { GitService } from '../platform/git.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

function requireGit(context: ToolContext): GitService {
	if (!context.git) {
		throw errors.notFound(
			'This workspace is not a git repository, so git information is unavailable.'
		);
	}
	return context.git;
}

async function confirmGitMutation(context: ToolContext, title: string, detail: string, kind: 'edit' | 'command' = 'edit'): Promise<void> {
	const automatic = kind === 'edit'
		? context.settings.agent.autoApproveEdits
		: context.settings.agent.autoApproveTerminal === 'always';
	if (automatic || !context.confirm) {
		return;
	}
	const approved = await context.confirm({ title, detail, risk: RiskClass.Modify, kind });
	if (!approved) {
		throw errors.denied(`You declined: ${title}`);
	}
}

export const gitStatusTool: Tool = {
	name: 'git_status',
	description:
		'Show the current branch and which files are staged, modified or untracked. '
		+ 'Use it to see what you have changed so far.',
	parameters: objectSchema({}),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(_rawArgs, context): Promise<ToolResult> {
		const git = requireGit(context);
		const status = await git.status();
		if (status.clean) {
			return {
				output: `On ${status.branch}${status.upstream ? ` (tracking ${status.upstream})` : ''}. Working tree clean.`,
				data: { clean: true, branch: status.branch }
			};
		}
		const lines: string[] = [
			`On ${status.branch}${status.upstream ? ` (tracking ${status.upstream})` : ''}`
			+ (status.ahead || status.behind ? ` — ahead ${status.ahead}, behind ${status.behind}` : '')
		];
		const section = (title: string, entries: readonly { path: string; status: string; oldPath?: string }[]) => {
			if (entries.length === 0) {
				return;
			}
			lines.push(`${title}:`);
			for (const entry of entries) {
				lines.push(`  ${entry.status.padEnd(10)} ${entry.oldPath ? `${entry.oldPath} → ` : ''}${entry.path}`);
			}
		};
		section('Staged', status.staged);
		section('Not staged', status.unstaged);
		if (status.untracked.length > 0) {
			lines.push('Untracked:');
			for (const path of status.untracked.slice(0, 50)) {
				lines.push(`  ${path}`);
			}
			if (status.untracked.length > 50) {
				lines.push(`  … and ${status.untracked.length - 50} more`);
			}
		}
		if (status.conflicted.length > 0) {
			lines.push(`Conflicted: ${status.conflicted.join(', ')}`);
		}
		return { output: lines.join('\n'), data: { clean: false, branch: status.branch, status } };
	}
};

export const gitDiffTool: Tool = {
	name: 'git_diff',
	description:
		'Show a unified diff of the working tree. Use it to review what you changed before finishing, '
		+ 'or to understand recent modifications you did not make.',
	parameters: objectSchema({
		staged: bool('Diff the staged changes instead of the working tree.'),
		paths: arr('Limit the diff to these paths.', { type: 'string' }),
		ref: str('Diff against this ref instead of the index, e.g. "HEAD~3" or "main".'),
		contextLines: int('Lines of context around each hunk. Default 3.', { minimum: 0, maximum: 20 })
	}),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const git = requireGit(context);
		// Boundary-check requested paths so a diff cannot be used to read outside the workspace.
		const paths: string[] = [];
		for (const path of (args['paths'] as string[]) ?? []) {
			paths.push((await context.boundary.resolve(path, 'read')).relative);
		}
		const limit = context.settings.tools.maxOutputChars;
		const diff = await git.diff({
			staged: args['staged'] === true,
			...(paths.length > 0 ? { paths } : {}),
			...(args['ref'] ? { ref: String(args['ref']) } : {}),
			...(typeof args['contextLines'] === 'number' ? { contextLines: args['contextLines'] } : {}),
			maxBytes: limit
		});
		if (!diff.trim()) {
			return { output: 'No differences.', data: { empty: true } };
		}
		const stat = await git.diffStat({
			staged: args['staged'] === true,
			...(args['ref'] ? { ref: String(args['ref']) } : {})
		});
		const truncated = diff.length >= limit;
		return {
			output: `${stat.files} file(s) changed, +${stat.insertions}/-${stat.deletions}\n\n`
				+ (truncated ? `${diff.slice(0, limit)}\n… diff truncated. Narrow it with paths.` : diff),
			data: { files: stat.files, insertions: stat.insertions, deletions: stat.deletions },
			...(truncated ? { truncated: true } : {})
		};
	}
};

export const gitLogTool: Tool = {
	name: 'git_log',
	description:
		'Show recent commits, optionally for specific files. Useful for finding when a regression was '
		+ 'introduced or who last touched a piece of code.',
	parameters: objectSchema({
		limit: int('How many commits to return. Default 15.', { minimum: 1, maximum: 200, default: 15 }),
		paths: arr('Only commits touching these paths.', { type: 'string' }),
		since: str('Only commits after this date or relative time, e.g. "2 weeks ago".')
	}),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const git = requireGit(context);
		const paths: string[] = [];
		for (const path of (args['paths'] as string[]) ?? []) {
			paths.push((await context.boundary.resolve(path, 'read')).relative);
		}
		const commits = await git.log({
			limit: typeof args['limit'] === 'number' ? args['limit'] : 15,
			...(paths.length > 0 ? { paths } : {}),
			...(args['since'] ? { since: String(args['since']) } : {})
		});
		if (commits.length === 0) {
			return { output: 'No commits found for that query.', data: { commits: 0 } };
		}
		const lines = commits.map((commit) =>
			`${commit.shortHash}  ${commit.date.slice(0, 10)}  ${commit.author}\n    ${commit.subject}`
			+ (commit.body ? `\n    ${commit.body.split('\n').slice(0, 3).join('\n    ')}` : '')
		);
		return { output: lines.join('\n'), data: { commits: commits.length } };
	}
};

export const gitShowTool: Tool = {
	name: 'git_show',
	description:
		'Inspect one Git object or the contents of a file at a ref without changing the workspace. '
		+ 'Use this for a commit, tag, or historical file version.',
	parameters: objectSchema({
		ref: str('Commit, tag or ref to inspect, for example HEAD or HEAD~1.'),
		path: str('Optional workspace-relative file path to show at that ref.')
	}),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const git = requireGit(context);
		const ref = typeof args['ref'] === 'string' && args['ref'].trim() ? args['ref'].trim() : 'HEAD';
		let path: string | undefined;
		if (typeof args['path'] === 'string' && args['path'].trim()) {
			path = (await context.boundary.resolve(args['path'], 'read')).relative;
		}
		const output = await git.show(ref, path);
		const limit = context.settings.tools.maxOutputChars;
		const truncated = output.length > limit;
		return {
			output: truncated ? `${output.slice(0, limit)}\n… output truncated. Narrow the file or ref.` : output,
			data: { ref, ...(path ? { path } : {}) },
			...(truncated ? { truncated: true } : {})
		};
	}
};

export const gitBlameTool: Tool = {
	name: 'git_blame',
	description: 'Show the commit, author and summary responsible for one line of a workspace file.',
	parameters: objectSchema({
		path: str('Workspace-relative file path.'),
		line: int('One-based line number.', { minimum: 1, maximum: 1_000_000, default: 1 })
	}),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const git = requireGit(context);
		const path = (await context.boundary.resolve(String(args['path'] ?? ''), 'read')).relative;
		const line = typeof args['line'] === 'number' ? args['line'] : 1;
		const blame = await git.blame(path, line);
		if (!blame) {
			return { output: `No blame information is available for ${path}:${line}.`, data: { path, line } };
		}
		return {
			output: `${path}:${line}\n${blame.hash.slice(0, 12)} · ${blame.author} · ${blame.date}\n${blame.summary}`,
			data: { path, line, ...blame }
		};
	}
};

export const gitStageTool: Tool = {
	name: 'git_stage',
	description: 'Stage explicitly named workspace files for a later local commit. This is outside file checkpoint undo and never stages everything implicitly.',
	parameters: objectSchema({ paths: arr('Workspace-relative paths to stage.', { type: 'string' }) }, ['paths']),
	source: 'builtin', risk: RiskClass.Modify, mutates: true, parallelSafe: false, readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const git = requireGit(context);
		const paths: string[] = [];
		for (const path of (args['paths'] as string[]) ?? []) {
			paths.push((await context.boundary.resolve(path, 'read')).relative);
		}
		if (paths.length === 0) {
			return { output: 'No paths were supplied.', isError: true };
		}
		await confirmGitMutation(context, 'Stage Git changes?', paths.join(', '));
		await git.stage(paths);
		return { output: `Staged ${paths.length} path(s): ${paths.join(', ')}`, data: { paths } };
	}
};

export const gitCommitTool: Tool = {
	name: 'git_commit',
	description: 'Create a local commit from the staged index. It never stages or pushes files implicitly; file checkpoint undo does not rewrite this commit.',
	parameters: objectSchema({ message: str('Commit message.') }, ['message']),
	source: 'builtin', risk: RiskClass.Modify, mutates: true, parallelSafe: false, readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const git = requireGit(context);
		const message = String(args['message'] ?? '').trim();
		await confirmGitMutation(context, 'Create a local Git commit?', message, 'command');
		const commit = await git.commit(message);
		return {
			output: commit ? `Created ${commit.shortHash}: ${commit.subject}` : 'Git created the commit, but its details could not be read.',
			data: commit ? { hash: commit.hash, subject: commit.subject } : {}
		};
	}
};

export const gitCreateBranchTool: Tool = {
	name: 'git_create_branch',
	description: 'Create and switch to a new local branch without contacting a remote. Uncommitted work is not discarded.',
	parameters: objectSchema({ name: str('New branch name.'), fromRef: str('Optional existing ref to branch from.') }, ['name']),
	source: 'builtin', risk: RiskClass.Modify, mutates: true, parallelSafe: false, readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const git = requireGit(context);
		const name = String(args['name']);
		await confirmGitMutation(context, `Create branch ${name}?`, args['fromRef'] ? `Starting from ${args['fromRef']}.` : 'Starting from the current commit.');
		await git.createBranch(name, typeof args['fromRef'] === 'string' ? args['fromRef'] : undefined);
		return { output: `Created and switched to ${name}.`, data: { branch: name } };
	}
};

export const gitSwitchBranchTool: Tool = {
	name: 'git_switch_branch',
	description: 'Switch to an existing local branch without discarding uncommitted work.',
	parameters: objectSchema({ name: str('Existing local branch name.') }, ['name']),
	source: 'builtin', risk: RiskClass.Modify, mutates: true, parallelSafe: false, readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const git = requireGit(context);
		const name = String(args['name']);
		await confirmGitMutation(context, `Switch to ${name}?`, 'Git will refuse if this would overwrite uncommitted work.');
		await git.switchBranch(name);
		return { output: `Switched to ${name}.`, data: { branch: name } };
	}
};
