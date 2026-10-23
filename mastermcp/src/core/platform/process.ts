/**
 * Command execution for the terminal tools.
 *
 * Four things make this different from calling `child_process.exec`:
 *  - Output is bounded by a head+tail ring buffer. A `find /` that prints 2 GB must not take the
 *    daemon down, and the model is better served by the beginning and the end than by the middle.
 *  - Timeouts kill the *process group*. `sh -c "npm test"` spawns children; killing only the shell
 *    leaves them running and holding the port.
 *  - Cancellation is first class: the agent loop must be able to stop a build instantly.
 *  - Optional PTY without native modules, by wrapping the command in `script(1)`. Many CLIs only
 *    print progress or colour when they believe they are on a terminal.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ForjaError, ErrorCode, errors } from './errors.ts';
import { type Logger, nullLogger } from './logger.ts';
import { sandboxLaunch, type SandboxOptions, type SandboxStatus } from '../security/sandbox.ts';

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const KILL_ESCALATION_MS = 3_000;
/** Prevent a runaway agent from filling the host with watchers/builds. */
const MAX_BACKGROUND_PROCESSES = 32;
/** Keep concurrent shells bounded so parallel builds cannot starve the IDE or the OS. */
const MAX_ACTIVE_PROCESSES = (() => {
	const configured = Number.parseInt(process.env['FORJA_MAX_ACTIVE_PROCESSES'] ?? '', 10);
	return Number.isFinite(configured) ? Math.max(4, Math.min(64, configured)) : 8;
})();
let activeProcesses = 0;
const TRUNCATION_NOTICE = (dropped: number): string =>
	`\n… [forja: ${dropped} bytes of output dropped from the middle] …\n`;

export interface ProcessOptions {
	readonly cwd: string;
	readonly env?: Record<string, string | undefined>;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly maxOutputBytes?: number;
	/** Ask for a pseudo-terminal. Falls back to pipes when unavailable. */
	readonly pty?: boolean;
	/** Written to stdin, then stdin is closed. */
	readonly input?: string;
	readonly logger?: Logger;
	/** Kernel-enforced boundary for a command. Omit only for host-owned maintenance work. */
	readonly sandbox?: SandboxOptions;
}

export interface ProcessResult {
	readonly command: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly timedOut: boolean;
	readonly truncated: boolean;
	/** False when a PTY was requested but pipes were used instead. */
	readonly usedPty: boolean;
	/** True when the caller's AbortSignal stopped the process. */
	readonly cancelled: boolean;
	/** Whether the command actually ran under a kernel sandbox, never inferred from UI state. */
	readonly sandbox: SandboxStatus | undefined;
}

/**
 * Keeps the first half and the last half of a stream, drops the middle.
 *
 * Decoding happens once at the end so a chunk boundary cannot split a multi-byte character
 * (except exactly at the truncation cut, where a marker is printed anyway).
 */
class BoundedOutput {
	private readonly maxBytes: number;
	private readonly halfBytes: number;
	private readonly head: Buffer[] = [];
	private readonly tail: Buffer[] = [];
	private headBytes = 0;
	private tailBytes = 0;
	private droppedBytes = 0;

	constructor(maxBytes: number) {
		this.maxBytes = Math.max(1024, maxBytes);
		this.halfBytes = Math.floor(this.maxBytes / 2);
	}

	push(chunk: Buffer): void {
		let rest = chunk;
		if (this.headBytes < this.halfBytes) {
			const room = this.halfBytes - this.headBytes;
			const take = rest.subarray(0, room);
			if (take.length > 0) {
				this.head.push(take);
				this.headBytes += take.length;
			}
			rest = rest.subarray(take.length);
		}
		if (rest.length === 0) {
			return;
		}
		this.tail.push(rest);
		this.tailBytes += rest.length;
		while (this.tailBytes > this.halfBytes && this.tail.length > 1) {
			const oldest = this.tail.shift() as Buffer;
			this.tailBytes -= oldest.length;
			this.droppedBytes += oldest.length;
		}
		// A single chunk larger than the tail budget is cut from its front.
		if (this.tailBytes > this.halfBytes && this.tail.length === 1) {
			const only = this.tail[0] as Buffer;
			const keep = only.subarray(only.length - this.halfBytes);
			this.droppedBytes += only.length - keep.length;
			this.tail[0] = keep;
			this.tailBytes = keep.length;
		}
	}

	get truncated(): boolean {
		return this.droppedBytes > 0;
	}

	get byteLength(): number {
		return this.headBytes + this.tailBytes;
	}

	toString(): string {
		const head = Buffer.concat(this.head).toString('utf8');
		if (this.droppedBytes === 0) {
			return head + Buffer.concat(this.tail).toString('utf8');
		}
		return head + TRUNCATION_NOTICE(this.droppedBytes) + Buffer.concat(this.tail).toString('utf8');
	}
}

/** Quotes a value for POSIX shells. `'` closes, escapes, and reopens the quote. */
export function shellQuote(value: string): string {
	if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
		return value;
	}
	return `'${value.split("'").join(`'\\''`)}'`;
}

/** Quotes for `cmd.exe`, which has its own rules and no escape character inside quotes. */
export function cmdQuote(value: string): string {
	if (/\0|\r|\n/.test(value)) throw new Error('Windows command arguments cannot contain NUL or line breaks.');
	return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function shellQuoteForPlatform(value: string, platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? cmdQuote(value) : shellQuote(value);
}

export function defaultShell(): { file: string; args: readonly string[] } {
	if (process.platform === 'win32') {
		return { file: process.env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c'] };
	}
	return { file: '/bin/sh', args: ['-lc'] };
}

let scriptAvailable: boolean | undefined;

/** `script(1)` is our PTY: present on virtually every Linux and macOS, absent on Windows. */
export function hasScriptCommand(): boolean {
	if (scriptAvailable !== undefined) {
		return scriptAvailable;
	}
	if (process.platform !== 'linux' && process.platform !== 'darwin') {
		scriptAvailable = false;
		return scriptAvailable;
	}
	scriptAvailable = ['/usr/bin/script', '/bin/script', '/usr/local/bin/script'].some((path) => existsSync(path));
	return scriptAvailable;
}

interface LaunchPlan {
	readonly file: string;
	readonly args: string[];
	readonly usedPty: boolean;
	readonly sandbox: SandboxStatus | undefined;
}

function buildLaunchPlan(command: string, wantPty: boolean, sandbox: SandboxOptions | undefined): LaunchPlan {
	const shell = defaultShell();
	let inner: { file: string; args: string[]; usedPty: boolean };
	if (wantPty && hasScriptCommand()) {
		if (process.platform === 'linux') {
			// util-linux: -q quiet, -f flush, -e return the child's exit status, -c run this command.
			inner = { file: 'script', args: ['-qfec', command, '/dev/null'], usedPty: true };
		} else {
			// BSD/macOS script takes the typescript file first, then the command to run.
			inner = { file: 'script', args: ['-q', '/dev/null', shell.file, '-lc', command], usedPty: true };
		}
	} else {
		inner = { file: shell.file, args: [...shell.args, command], usedPty: false };
	}
	if (!sandbox) {
		return { ...inner, sandbox: undefined };
	}
	const wrapped = sandboxLaunch(inner, sandbox);
	return { file: wrapped.file, args: wrapped.args, usedPty: inner.usedPty, sandbox: wrapped.status };
}

function buildEnv(overrides: Record<string, string | undefined> | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) {
			delete env[key];
		} else {
			env[key] = value;
		}
	}
	return env;
}

/** Kills the whole process group so `sh -c` children do not survive their parent. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals, detached: boolean): void {
	const pid = child.pid;
	if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	if (process.platform === 'win32') {
		try {
			spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
		} catch {
			child.kill(signal);
		}
		return;
	}
	try {
		if (detached) {
			process.kill(-pid, signal);
			return;
		}
	} catch {
		// The group may already be gone; fall through to the direct kill.
	}
	try {
		child.kill(signal);
	} catch {
		// Already dead.
	}
}

export interface StreamingHooks {
	readonly onStdout?: (chunk: string) => void;
	readonly onStderr?: (chunk: string) => void;
}

export interface StreamingHandle {
	readonly pid: number | undefined;
	readonly sandbox: SandboxStatus | undefined;
	readonly done: Promise<ProcessResult>;
	kill(signal?: NodeJS.Signals): void;
	write(data: string): void;
}

function launch(command: string, options: ProcessOptions, hooks: StreamingHooks = {}): StreamingHandle {
	if (typeof command !== 'string' || command.trim().length === 0) {
		throw errors.invalidArgument('A command is required');
	}
	if (!options.cwd) {
		throw errors.invalidArgument('A working directory is required');
	}
	if (options.signal?.aborted) {
		throw errors.cancelled('Command cancelled before it started');
	}
	if (activeProcesses >= MAX_ACTIVE_PROCESSES) {
		throw errors.invalidArgument(
			`Forja limits concurrent commands to ${MAX_ACTIVE_PROCESSES}. `
			+ 'Wait for an existing build or stop an unused watcher before starting another one.'
		);
	}
	const logger = (options.logger ?? nullLogger).child('process');
	const plan = buildLaunchPlan(command, options.pty === true, options.sandbox);
	const detached = process.platform !== 'win32';
	const startedAt = Date.now();
	const stdout = new BoundedOutput(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
	const stderr = new BoundedOutput(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

	let child: ChildProcess;
	try {
		child = spawn(plan.file, plan.args, {
			cwd: options.cwd,
			env: buildEnv(options.env),
			stdio: ['pipe', 'pipe', 'pipe'],
			detached,
			windowsHide: true
		});
	} catch (error) {
		throw ForjaError.from(error, ErrorCode.ToolFailure);
	}
	activeProcesses++;

	let timedOut = false;
	let cancelled = false;
	let escalation: NodeJS.Timeout | undefined;
	let timeoutTimer: NodeJS.Timeout | undefined;

	const terminate = (signal: NodeJS.Signals) => {
		killGroup(child, signal, detached);
		if (escalation === undefined) {
			// If SIGTERM is ignored (common for shells running a stubborn child), escalate.
			escalation = setTimeout(() => killGroup(child, 'SIGKILL', detached), KILL_ESCALATION_MS);
			escalation.unref?.();
		}
	};

	if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
		timeoutTimer = setTimeout(() => {
			timedOut = true;
			logger.debug('Killing a command that exceeded its timeout', { command, timeoutMs: options.timeoutMs });
			terminate('SIGTERM');
		}, options.timeoutMs);
		timeoutTimer.unref?.();
	}

	const onAbort = () => {
		cancelled = true;
		terminate('SIGTERM');
	};
	options.signal?.addEventListener('abort', onAbort, { once: true });
	// The signal may abort in the small window between the initial guard and listener setup.
	// Check again after registration so a just-launched process cannot escape cancellation.
	if (options.signal?.aborted) onAbort();

	child.stdout?.on('data', (chunk: Buffer) => {
		stdout.push(chunk);
		if (hooks.onStdout) {
			hooks.onStdout(chunk.toString('utf8'));
		}
	});
	child.stderr?.on('data', (chunk: Buffer) => {
		stderr.push(chunk);
		if (hooks.onStderr) {
			hooks.onStderr(chunk.toString('utf8'));
		}
	});
	// A closed stdin (the child exited early) must not raise EPIPE into the daemon.
	child.stdin?.on('error', () => undefined);
	if (options.input !== undefined) {
		child.stdin?.end(options.input);
	}

	const done = new Promise<ProcessResult>((resolve, reject) => {
		let settled = false;
		let released = false;
		const cleanup = () => {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			if (escalation) {
				clearTimeout(escalation);
			}
			options.signal?.removeEventListener('abort', onAbort);
			if (!released) {
				released = true;
				activeProcesses = Math.max(0, activeProcesses - 1);
			}
		};
		child.on('error', (error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(ForjaError.from(error, ErrorCode.ToolFailure));
		});
		child.on('close', (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve({
				command,
				exitCode: code,
				signal: signal ?? null,
				stdout: stdout.toString(),
				stderr: stderr.toString(),
				durationMs: Date.now() - startedAt,
				timedOut,
				truncated: stdout.truncated || stderr.truncated,
				usedPty: plan.usedPty,
				cancelled,
				sandbox: plan.sandbox
			});
		});
	});

	return {
		pid: child.pid,
		sandbox: plan.sandbox,
		done,
		kill(signal: NodeJS.Signals = 'SIGTERM') {
			terminate(signal);
		},
		write(data: string) {
			child.stdin?.write(data);
		}
	};
}

/**
 * Runs a command to completion. Resolves even for non-zero exits: a failing build is data the agent
 * needs, not an exception. Only a failure to *start* the process rejects.
 */
export async function execCommand(command: string, options: ProcessOptions): Promise<ProcessResult> {
	if (options.signal?.aborted) {
		throw errors.cancelled('Command cancelled before it started');
	}
	const handle = launch(command, options);
	return handle.done;
}

/** Long-running process with live output. The caller owns the lifetime. */
export function spawnStreaming(
	command: string,
	options: ProcessOptions & StreamingHooks
): StreamingHandle {
	const hooks: StreamingHooks = {
		...(options.onStdout ? { onStdout: options.onStdout } : {}),
		...(options.onStderr ? { onStderr: options.onStderr } : {})
	};
	return launch(command, options, hooks);
}

export type BackgroundStatus = 'running' | 'exited' | 'killed';

export interface BackgroundProcessInfo {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly pid: number | undefined;
	readonly startedAt: number;
	readonly status: BackgroundStatus;
	readonly exitCode: number | null;
	readonly sandbox: SandboxStatus | undefined;
	/** Last lines of combined output, for a quick glance without reading everything. */
	readonly outputTail: string;
}

interface BackgroundEntry {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly handle: StreamingHandle;
	readonly lines: string[];
	pending: string;
	status: BackgroundStatus;
	exitCode: number | null;
	killRequested: boolean;
	result: ProcessResult | undefined;
}

const MAX_KEPT_LINES = 5_000;
const TAIL_LINES = 20;

/**
 * Tracks processes the agent started and left running (dev servers, watchers). The agent can list
 * them, read their output and stop them in a later turn, which is what makes "start the dev server
 * and then check its logs" work at all.
 */
export class BackgroundProcessRegistry {
	private readonly entries = new Map<string, BackgroundEntry>();
	private readonly logger: Logger;
	private counter = 0;

	constructor(logger: Logger = nullLogger) {
		this.logger = logger.child('process.background');
	}

	start(command: string, options: ProcessOptions): BackgroundProcessInfo {
		const running = [...this.entries.values()].filter(entry => entry.status === 'running').length;
		if (running >= MAX_BACKGROUND_PROCESSES) {
			throw errors.invalidArgument(
				`Forja limits concurrent background processes to ${MAX_BACKGROUND_PROCESSES}. `
				+ 'Stop an existing watcher or server before starting another one.'
			);
		}
		const id = `proc_${++this.counter}`;
		const entry: BackgroundEntry = {
			id,
			command,
			cwd: options.cwd,
			startedAt: Date.now(),
			handle: undefined as unknown as StreamingHandle,
			lines: [],
			pending: '',
			status: 'running',
			exitCode: null,
			killRequested: false,
			result: undefined
		};
		const append = (chunk: string) => this.appendOutput(entry, chunk);
		const handle = spawnStreaming(command, { ...options, onStdout: append, onStderr: append });
		(entry as { handle: StreamingHandle }).handle = handle;
		this.entries.set(id, entry);
		handle.done.then(
			(result) => {
				entry.result = result;
				entry.exitCode = result.exitCode;
				entry.status = entry.killRequested || result.signal !== null ? 'killed' : 'exited';
				this.flushPending(entry);
			},
			(error: unknown) => {
				entry.status = 'exited';
				entry.exitCode = null;
				this.appendOutput(entry, `\n[forja] process failed to start: ${ForjaError.from(error).message}\n`);
				this.flushPending(entry);
			}
		);
		this.logger.debug('Started a background process', { id, command, pid: handle.pid });
		return this.toInfo(entry);
	}

	list(): BackgroundProcessInfo[] {
		return [...this.entries.values()].map((entry) => this.toInfo(entry));
	}

	get(id: string): BackgroundProcessInfo | undefined {
		const entry = this.entries.get(id);
		return entry ? this.toInfo(entry) : undefined;
	}

	/** Result of a finished process, or undefined while it is still running. */
	resultOf(id: string): ProcessResult | undefined {
		return this.entries.get(id)?.result;
	}

	/** Resolves when the process exits. Useful in tests and in `wait_for` style tools. */
	wait(id: string): Promise<ProcessResult> {
		const entry = this.entries.get(id);
		if (!entry) {
			throw errors.notFound(`No background process with id ${JSON.stringify(id)}`, { id });
		}
		return entry.handle.done;
	}

	kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
		const entry = this.entries.get(id);
		if (!entry || entry.status !== 'running') {
			return false;
		}
		entry.killRequested = true;
		entry.handle.kill(signal);
		this.logger.debug('Killed a background process', { id, signal });
		return true;
	}

	write(id: string, data: string): boolean {
		const entry = this.entries.get(id);
		if (!entry || entry.status !== 'running') {
			return false;
		}
		entry.handle.write(data);
		return true;
	}

	/** Last `lines` lines of combined output (default 200). */
	readOutput(id: string, lines = 200): string {
		const entry = this.entries.get(id);
		if (!entry) {
			throw errors.notFound(`No background process with id ${JSON.stringify(id)}`, { id });
		}
		const all = entry.pending.length > 0 ? [...entry.lines, entry.pending] : entry.lines;
		const count = Math.max(1, Math.min(lines, MAX_KEPT_LINES));
		return all.slice(-count).join('\n');
	}

	remove(id: string): boolean {
		const entry = this.entries.get(id);
		if (!entry) {
			return false;
		}
		if (entry.status === 'running') {
			entry.killRequested = true;
			entry.handle.kill('SIGKILL');
		}
		return this.entries.delete(id);
	}

	disposeAll(): void {
		for (const entry of this.entries.values()) {
			if (entry.status === 'running') {
				entry.killRequested = true;
				entry.handle.kill('SIGKILL');
			}
		}
		this.entries.clear();
	}

	private appendOutput(entry: BackgroundEntry, chunk: string): void {
		const text = entry.pending + chunk.replace(/\r\n/g, '\n');
		const parts = text.split('\n');
		entry.pending = parts.pop() ?? '';
		for (const line of parts) {
			entry.lines.push(line);
		}
		if (entry.lines.length > MAX_KEPT_LINES) {
			entry.lines.splice(0, entry.lines.length - MAX_KEPT_LINES);
		}
	}

	private flushPending(entry: BackgroundEntry): void {
		if (entry.pending.length > 0) {
			entry.lines.push(entry.pending);
			entry.pending = '';
		}
	}

	private toInfo(entry: BackgroundEntry): BackgroundProcessInfo {
		const all = entry.pending.length > 0 ? [...entry.lines, entry.pending] : entry.lines;
		return {
			id: entry.id,
			command: entry.command,
			cwd: entry.cwd,
			pid: entry.handle?.pid,
			sandbox: entry.handle?.sandbox,
			startedAt: entry.startedAt,
			status: entry.status,
			exitCode: entry.exitCode,
			outputTail: all.slice(-TAIL_LINES).join('\n')
		};
	}
}
