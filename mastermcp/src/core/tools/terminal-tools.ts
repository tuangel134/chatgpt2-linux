/**
 * Terminal, test and process tools (§30, §31).
 *
 * Every command passes through the classifier and the approval policy before it runs. The agent gets
 * exit codes and bounded output; long-running things go to the background registry so a dev server
 * can be started in one step and inspected in a later one.
 */

import { errors } from '../platform/errors.ts';
import { execCommand, type ProcessResult } from '../platform/process.ts';
import { pathExists } from '../platform/fsx.ts';
import { join } from 'node:path';
import { detectProject, verificationCommands } from './project-detect.ts';
import { classifyCommand, decideApproval, RiskClass } from '../security/command-classifier.ts';
import type { SandboxOptions } from '../security/sandbox.ts';
import { bool, int, objectSchema, requireValid, str } from './schema.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

function formatResult(result: ProcessResult, limit: number): string {
	const parts: string[] = [];
	parts.push(`$ ${result.command}`);
	if (result.stdout.trim()) {
		parts.push(result.stdout.trimEnd());
	}
	if (result.stderr.trim()) {
		parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
	}
	const status = result.timedOut
		? `timed out after ${result.durationMs}ms`
		: result.signal
			? `killed by ${result.signal}`
			: `exit code ${result.exitCode}`;
	const sandbox = result.sandbox
		? `, ${result.sandbox.execution === 'host-user' ? 'host-user' : `sandbox ${result.sandbox.active ? result.sandbox.profile : `inactive (${result.sandbox.reason ?? result.sandbox.profile})`}`}${result.sandbox.networkIsolated ? ', network disabled' : ''}`
		: '';
	parts.push(`[${status}, ${result.durationMs}ms${sandbox}${result.truncated ? ', output truncated' : ''}]`);
	const text = parts.join('\n');
	return text.length > limit ? `${text.slice(0, limit)}\n… output truncated.` : text;
}

function sandboxOptions(context: ToolContext, cwd: string, execution: 'sandbox' | 'host-user' = 'sandbox'): SandboxOptions {
	return {
		execution,
		profile: execution === 'host-user' ? 'full-access' : context.settings.security.sandboxProfile,
		network: context.settings.security.sandboxNetwork,
		unavailable: context.settings.security.sandboxFallback,
		workspaceRoot: context.workspaceRoot,
		cwd,
		protectedPaths: context.protectedHostPaths,
		// Host mounts are reserved for the explicit host-user tool. A connector may
		// have the host grant and still call terminal_execute; that route must remain
		// inside the workspace sandbox.
		hostAccess: execution === 'host-user' && context.hostTerminalPermissions ? {
			home: context.hostTerminalPermissions.home,
			ssh: context.hostTerminalPermissions.ssh,
			docker: context.hostTerminalPermissions.docker,
			mounts: context.hostTerminalPermissions.mounts,
			systemWrite: context.hostTerminalPermissions.systemWrite,
			devices: context.hostTerminalPermissions.devices,
			sudo: context.hostTerminalPermissions.sudo
		} : undefined
	};
}

/** Runs the approval gate for a command, throwing Denied when the user says no. */
async function gate(command: string, context: ToolContext): Promise<void> {
	if (context.hostTerminalPermissions && /\bmachinectl\s+shell\b|\bsystemd-run\b[^\r\n]*\b(?:-M\s*\.?host|--machine(?:=|\s+)\.?host)\b/iu.test(command)) {
		throw errors.denied('Host terminal already runs as the signed-in user. machinectl/systemd-run host escapes are blocked to prevent repeated Polkit prompts.', { command });
	}
	if (context.hostTerminalPermissions && !context.hostTerminalPermissions.sudo) {
		const unixElevation = /(^|[;&|()\s])(?:\S*\/)?(?:sudo|doas|pkexec)(?=$|[;&|()\s])/u.test(command);
		const windowsElevation = /(^|[;&|()\s])runas(?:\.exe)?(?=$|[;&|()\s])|\bStart-Process\b[^\r\n]*\b-Verb\s+RunAs\b/iu.test(command);
		if (unixElevation || windowsElevation) {
			throw errors.denied('This connector does not have the "Solicitar elevación" permission.', { command });
		}
	}
	const classification = classifyCommand(command);
	const decision = decideApproval(
		classification,
		context.settings.security.terminalPolicy,
		context.settings.agent.autoApproveTerminal,
		{ confirmDependencyInstall: context.settings.security.confirmDependencyInstall }
	);
	if (!decision.needsConfirmation) {
		return;
	}
	if (!context.confirm) {
		throw errors.denied(
			`This command needs confirmation and none is available: ${decision.reason} `
			+ 'Adjust forja.security.terminalPolicy or run it yourself.',
			{ command, risk: classification.risk }
		);
	}
	const approved = await context.confirm({
		title: `Run this command?`,
		detail: decision.reason,
		risk: classification.risk,
		kind: classification.touchesDependencies ? 'dependency' : 'command',
		command
	});
	if (!approved) {
		throw errors.denied(`You declined running: ${command}`, { command });
	}
}

export const terminalExecuteTool: Tool = {
	name: 'terminal_execute',
	description:
		'Run a shell command in the workspace and wait for it to finish. Use for builds, tests, '
		+ 'type checks, linters and git. Do not use it for servers or watchers that never exit — '
		+ 'use terminal_background for those.',
	parameters: objectSchema({
		command: str('The command line to run.'),
		cwd: str('Workspace-relative working directory. Defaults to the workspace root.'),
		timeoutMs: int('Timeout in milliseconds. Defaults to the configured terminal timeout.', { minimum: 1000 }),
		pty: bool('Allocate a pseudo-terminal, for tools that need one to produce output.')
	}, ['command']),
	source: 'builtin',
	// The real risk is decided per command at call time; this is the declared baseline.
	risk: RiskClass.Modify,
	mutates: true,
	parallelSafe: false,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const command = String(args['command']).trim();
		if (!command) {
			throw errors.invalidArgument('A command is required.');
		}
		const cwd = args['cwd']
			? (await context.boundary.resolve(String(args['cwd']), 'execute')).absolute
			: context.workspaceRoot;

		await gate(command, context);
		const result = await execCommand(command, {
			cwd,
			timeoutMs: typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : context.settings.tools.terminalTimeoutMs,
			signal: context.signal,
			pty: args['pty'] === true,
			maxOutputBytes: context.settings.tools.maxOutputChars,
			sandbox: sandboxOptions(context, cwd)
		});
		return {
			output: formatResult(result, context.settings.tools.maxOutputChars),
			isError: result.exitCode !== 0,
			data: {
				command, exitCode: result.exitCode, durationMs: result.durationMs,
				timedOut: result.timedOut, usedPty: result.usedPty, sandbox: result.sandbox
			},
			...(result.truncated ? { truncated: true } : {})
		};
	}
};

export const hostTerminalExecuteTool: Tool = {
	...terminalExecuteTool,
	name: 'host_terminal_execute',
	description: 'Run one command as the signed-in host user. This is separate from terminal_execute, which always remains workspace-sandboxed. Requires the explicit Host terminal permission; the Lite installation and configuration stay hidden.',
	async execute(rawArgs, context): Promise<ToolResult> {
		if (!context.hostTerminalPermissions?.home) throw errors.denied('This connector does not have the "Terminal del host" permission.');
		const args = requireValid(rawArgs, this.parameters, this.name);
		const command = String(args['command']).trim();
		if (!command) throw errors.invalidArgument('A command is required.');
		const cwd = args['cwd']
			? (await context.boundary.resolve(String(args['cwd']), 'execute')).absolute
			: context.workspaceRoot;
		await gate(command, context);
		const result = await execCommand(command, {
			cwd,
			timeoutMs: typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : context.settings.tools.terminalTimeoutMs,
			signal: context.signal,
			pty: args['pty'] === true,
			maxOutputBytes: context.settings.tools.maxOutputChars,
			sandbox: sandboxOptions(context, cwd, 'host-user')
		});
		return {
			output: formatResult(result, context.settings.tools.maxOutputChars),
			isError: result.exitCode !== 0,
			data: { command, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, usedPty: result.usedPty, sandbox: result.sandbox },
			...(result.truncated ? { truncated: true } : {})
		};
	}
};

export const terminalBackgroundTool: Tool = {
	name: 'terminal_background',
	description:
		'Start a long-running command in the background (dev server, watcher, tunnel) and return its '
		+ 'process id immediately. Read its output later with process_status, stop it with kill_process.',
	parameters: objectSchema({
		command: str('The command line to run.'),
		cwd: str('Workspace-relative working directory.')
	}, ['command']),
	source: 'builtin',
	risk: RiskClass.Modify,
	mutates: true,
	parallelSafe: true,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const command = String(args['command']).trim();
		const cwd = args['cwd']
			? (await context.boundary.resolve(String(args['cwd']), 'execute')).absolute
			: context.workspaceRoot;
		await gate(command, context);
		const info = context.processes.start(command, { cwd, sandbox: sandboxOptions(context, cwd) });
		return {
			output: `Started ${info.id} (pid ${info.pid ?? 'unknown'}${info.sandbox ? `, sandbox ${info.sandbox.active ? info.sandbox.profile : 'inactive'}` : ''}): ${command}\n`
				+ 'Use process_status to read its output.',
			data: { id: info.id, pid: info.pid, command, sandbox: info.sandbox }
		};
	}
};

export const processStatusTool: Tool = {
	name: 'process_status',
	description: 'List background processes, or read the recent output of one of them.',
	parameters: objectSchema({
		id: str('Process id from terminal_background. Omit to list all processes.'),
		lines: int('How many recent output lines to return. Default 100.', { minimum: 1, maximum: 5000, default: 100 })
	}),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		if (!args['id']) {
			const all = context.processes.list();
			if (all.length === 0) {
				return { output: 'No background processes are running.', data: { processes: [] } };
			}
			return {
				output: all.map((info) =>
					`${info.id}  ${info.status}${info.exitCode !== null ? ` (exit ${info.exitCode})` : ''}  ${info.command}`
				).join('\n'),
				data: { processes: all }
			};
		}
		const id = String(args['id']);
		const info = context.processes.get(id);
		if (!info) {
			throw errors.notFound(`No background process with id ${id}.`, { id });
		}
		const lines = typeof args['lines'] === 'number' ? args['lines'] : 100;
		const output = context.processes.readOutput(id, lines);
		return {
			output: `${info.id} is ${info.status}${info.exitCode !== null ? ` (exit ${info.exitCode})` : ''}: ${info.command}\n\n${output}`,
			data: { id, status: info.status, exitCode: info.exitCode, sandbox: info.sandbox }
		};
	}
};

export const killProcessTool: Tool = {
	name: 'kill_process',
	description: 'Stop a background process started with terminal_background.',
	parameters: objectSchema({
		id: str('Process id to stop.'),
		force: bool('Send SIGKILL instead of SIGTERM.')
	}, ['id']),
	source: 'builtin',
	risk: RiskClass.Modify,
	mutates: false,
	parallelSafe: true,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const id = String(args['id']);
		const killed = context.processes.kill(id, args['force'] === true ? 'SIGKILL' : 'SIGTERM');
		if (!killed) {
			const info = context.processes.get(id);
			if (!info) {
				throw errors.notFound(`No background process with id ${id}.`, { id });
			}
			return { output: `${id} was already ${info.status}.`, data: { id, status: info.status } };
		}
		return { output: `Stopped ${id}.`, data: { id } };
	}
};

export const runTestsTool: Tool = {
	name: 'run_tests',
	description:
		'Run the project\'s checks. With no arguments it detects and runs them in order '
		+ '(type check, lint, tests). Use this to verify a change instead of guessing a command.',
	parameters: objectSchema({
		kind: str('Which check to run: typecheck, lint, test, build, or all. Default all.', {
			enum: ['typecheck', 'lint', 'test', 'build', 'all'], default: 'all'
		}),
		pattern: str('Only run tests matching this name or path, when the runner supports it.'),
		stopOnFirstFailure: bool('Stop after the first failing check. Default true.', { default: true })
	}),
	source: 'builtin',
	risk: RiskClass.Modify,
	mutates: false,
	parallelSafe: false,
	readOnly: false,

	async execute(rawArgs, context): Promise<ToolResult> {
		const args = requireValid(rawArgs, this.parameters, this.name);
		const wanted = String(args['kind'] ?? 'all');
		const stopOnFailure = args['stopOnFirstFailure'] !== false;
		const all = await verificationCommands(context.workspaceRoot, context.settings.agent.verifyCommands);
		const selected = wanted === 'all' ? all : all.filter((command) => command.kind === wanted);

		if (selected.length === 0) {
			const detected = all.map((command) => command.kind).join(', ') || 'none';
			return {
				output: wanted === 'all'
					? 'No verification commands were detected for this project. '
						+ 'Set forja.agent.verifyCommands, or run a command directly with terminal_execute.'
					: `No ${wanted} command was detected. Detected checks: ${detected}.`,
				// This is informational for a human, but it is never a successful verification.
				// Otherwise an agent can request a missing check kind and finish after an edit.
				isError: true,
				data: { ran: 0, allPassed: false }
			};
		}

		const sections: string[] = [];
		const results: { kind: string; command: string; exitCode: number | null; ok: boolean }[] = [];
		let failed = false;

		for (const command of selected) {
			const line = args['pattern'] && command.kind === 'test'
				? `${command.command} ${String(args['pattern'])}`
				: command.command;
			await gate(line, context);
			const result = await execCommand(line, {
				cwd: context.workspaceRoot,
				timeoutMs: Math.max(context.settings.tools.terminalTimeoutMs, 180_000),
				signal: context.signal,
				maxOutputBytes: Math.floor(context.settings.tools.maxOutputChars / selected.length),
				sandbox: sandboxOptions(context, context.workspaceRoot)
			});
			const ok = result.exitCode === 0;
			results.push({ kind: command.kind, command: line, exitCode: result.exitCode, ok });
			sections.push(`### ${command.kind} (${command.source})\n${formatResult(result, 12_000)}`);
			if (!ok) {
				failed = true;
				if (stopOnFailure) {
					break;
				}
			}
		}
		const summary = results.map((result) => `${result.ok ? 'PASS' : 'FAIL'} ${result.kind}`).join('  ');
		return {
			output: `${summary}\n\n${sections.join('\n\n')}`,
			isError: failed,
			data: { results, allPassed: !failed }
		};
	}
};

export const detectProjectTool: Tool = {
	name: 'project_info',
	description:
		'Report what kind of project this is and which commands verify it. '
		+ 'Call this once before verifying, instead of guessing build or test commands.',
	parameters: objectSchema({}),
	source: 'builtin',
	risk: RiskClass.Safe,
	mutates: false,
	parallelSafe: true,
	readOnly: true,

	async execute(_rawArgs, context): Promise<ToolResult> {
		const profile = await detectProject(context.workspaceRoot);
		const manifests: string[] = [];
		for (const file of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json']) {
			if (await pathExists(join(context.workspaceRoot, file))) {
				manifests.push(file);
			}
		}
		const lines = [
			`Ecosystems: ${profile.ecosystems.join(', ') || 'unknown'}`,
			`Package manager: ${profile.packageManager ?? 'n/a'}`,
			`Manifests: ${manifests.join(', ') || 'none found'}`,
			'Verification commands:'
		];
		for (const command of profile.commands) {
			lines.push(`  ${command.kind.padEnd(10)} ${command.command}   (${command.source})`);
		}
		if (profile.commands.length === 0) {
			lines.push('  (none detected)');
		}
		return { output: lines.join('\n'), data: { profile } };
	}
};
