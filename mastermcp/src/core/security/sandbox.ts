/**
 * Linux command sandboxing.
 *
 * Bubblewrap gives terminal commands a real kernel boundary instead of relying only on a prompt or
 * a command classifier. The sandbox intentionally has two honest network states: disabled via a
 * network namespace, or enabled. Domain allowlists need an audited proxy and must not be pretended
 * with DNS filtering, so they belong to the future web-tool layer.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve, sep } from 'node:path';
import { errors } from '../platform/errors.ts';

export type SandboxProfile = 'read-only' | 'workspace-write' | 'full-access';
export type SandboxNetwork = 'disabled' | 'enabled';
export type SandboxFallback = 'deny' | 'allow';
export type SandboxExecution = 'sandbox' | 'host-user';

export interface SandboxOptions {
	readonly execution?: SandboxExecution;
	readonly profile: SandboxProfile;
	readonly network: SandboxNetwork;
	readonly unavailable: SandboxFallback;
	readonly workspaceRoot: string;
	readonly cwd: string;
	readonly protectedPaths?: readonly string[];
	readonly hostAccess?: Readonly<{
		readonly home: boolean;
		readonly ssh: boolean;
		readonly docker: boolean;
		readonly mounts: boolean;
		readonly systemWrite: boolean;
		readonly devices: boolean;
		readonly sudo: boolean;
	}>;
}

export interface SandboxStatus {
	readonly execution: SandboxExecution;
	readonly profile: SandboxProfile;
	readonly active: boolean;
	readonly networkIsolated: boolean;
	readonly reason?: string;
}

export interface SandboxLaunch {
	readonly file: string;
	readonly args: string[];
	readonly status: SandboxStatus;
}

const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap'];
const SYSTEM_READ_ONLY_PATHS = ['/usr', '/bin', '/lib', '/lib64', '/etc'];
let runtimeProbe: { executable: string; available: boolean; reason?: string } | undefined;

function bubblewrapPath(): string | undefined {
	return BWRAP_PATHS.find((path) => existsSync(path));
}

function inside(path: string, root: string): boolean {
	const resolvedPath = resolve(path);
	const resolvedRoot = resolve(root);
	return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

/** A small runtime allowance keeps common Node tooling usable without exposing the whole home. */
function userRuntimePaths(): string[] {
	const home = homedir();
	return [
		resolve(home, '.local', 'bin'),
		resolve(home, '.local', 'lib', 'node_modules')
	].filter((path) => existsSync(path));
}

function sandboxPath(path: string): string | undefined {
	if (!isAbsolute(path) || !existsSync(path)) {
		return undefined;
	}
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function safePath(): string {
	const parts = [
		...userRuntimePaths().filter((path) => path.endsWith(`${sep}bin`)),
		'/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'
	].filter((path, index, all) => existsSync(path) && all.indexOf(path) === index);
	return parts.join(delimiter);
}

function bindIfPresent(args: string[], mode: '--bind' | '--ro-bind', path: string): void {
	if (existsSync(path)) args.push(mode, path, path);
}

/**
 * Electron patches fs so an ASAR archive can look like a virtual directory. Bubblewrap is a native
 * process and only sees the real host filesystem, where app.asar is a file. Never hand bwrap a
 * virtual path below an ASAR archive, and treat the archive itself as a file even when Electron's
 * statSync reports it as a directory.
 */
function asarBoundary(path: string): string {
	const resolved = resolve(path);
	const parts = resolved.split(sep);
	const index = parts.findIndex((part) => part.toLowerCase().endsWith('.asar'));
	return index >= 0 ? parts.slice(0, index + 1).join(sep) || sep : resolved;
}

/** Keep only the broadest protected roots so nested mounts cannot invalidate later mount targets. */
export function normalizeProtectedPaths(paths: readonly string[]): string[] {
	const ordered = [...new Set(paths.map((path) => asarBoundary(path)))].sort((left, right) => left.length - right.length);
	const kept: string[] = [];
	for (const path of ordered) {
		if (kept.some((root) => inside(path, root))) continue;
		kept.push(path);
	}
	return kept;
}

/** Hide host content entirely while keeping the destination usable inside Bubblewrap. */
function hideIfPresent(args: string[], path: string): void {
	if (!existsSync(path)) return;
	try {
		if (path.toLowerCase().endsWith('.asar')) {
			args.push('--ro-bind', '/dev/null', path);
		} else if (statSync(path).isDirectory()) {
			args.push('--tmpfs', path);
		} else {
			args.push('--ro-bind', '/dev/null', path);
		}
	} catch {
		// A path that vanished between existsSync and statSync needs no mount.
	}
}

/**
 * Wraps an already-built executable invocation. Throws when the configured safety profile cannot
 * be enforced; callers may choose the explicit compatibility fallback in settings.
 */
export function sandboxLaunch(inner: { file: string; args: readonly string[] }, options: SandboxOptions): SandboxLaunch {
	const execution = options.execution ?? 'sandbox';
	const protectedPaths = normalizeProtectedPaths(options.protectedPaths ?? []);
	if (execution === 'sandbox' && options.profile === 'full-access' && protectedPaths.length === 0) {
		return {
			file: inner.file,
			args: [...inner.args],
			status: { execution, profile: options.profile, active: false, networkIsolated: false, reason: 'full access selected' }
		};
	}
	const executable = bubblewrapPath();
	// The host-user route relies on Bubblewrap to hide Lite's installation and
	// configuration. Never turn a missing/native-incompatible boundary into an
	// unwrapped host process, even when the general sandbox fallback is allowed.
	if (execution === 'host-user' && (!executable || process.platform !== 'linux')) {
		throw errors.unsupported(
			process.platform === 'linux'
				? 'Host-user execution requires Bubblewrap; the command was not executed because the protected host boundary is unavailable.'
				: 'Host-user execution is not available on this platform yet; the command was not executed because a native protected boundary is unavailable.',
			{ profile: options.profile, platform: process.platform, execution }
		);
	}
	if (!executable || process.platform !== 'linux') {
		const reason = process.platform === 'linux'
			? 'Bubblewrap is not installed'
			: `The ${options.profile} sandbox is currently available on Linux only`;
		if (options.unavailable === 'deny') {
			throw errors.unsupported(`${reason}. Install bubblewrap or explicitly select full-access.`, {
				profile: options.profile, platform: process.platform
			});
		}
		return {
			file: inner.file,
			args: [...inner.args],
			status: { execution, profile: options.profile, active: false, networkIsolated: false, reason: `${reason}; compatibility fallback allowed` }
		};
	}

	if (execution === 'host-user') {
		if (!options.hostAccess?.home) {
			throw errors.denied('Host-user execution requires an explicit host terminal grant.');
		}
		if (process.platform !== 'linux') {
			throw errors.unsupported('Host-user isolation requires Linux Bubblewrap; the command was not executed because a native protected Windows boundary is not available yet.', {
				profile: options.profile, platform: process.platform
			});
		}
		const runtimeDir = process.env['XDG_RUNTIME_DIR']
			?? (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : undefined);
		const args = [
			// Host-user is an explicitly granted host terminal. Keep filesystem/IPC/UTS
			// isolation around Tessarion itself, but share the host PID namespace so
			// process inspection and control refer to the user's real host processes.
			'--die-with-parent', '--new-session', '--unshare-ipc', '--unshare-uts',
			'--clearenv', '--ro-bind', '/', '/', '--proc', '/proc',
			'--setenv', 'HOME', homedir(), '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TEMP', '/tmp',
			'--setenv', 'PATH', safePath(),
			'--setenv', 'FORJA_EXECUTION_MODE', 'host-user',
			'--setenv', 'FORJA_SANDBOX', 'full-access',
			'--setenv', 'FORJA_SANDBOX_NETWORK', options.network
		];
		for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'USER', 'LOGNAME', 'SHELL'] as const) {
			const value = process.env[key];
			if (value) args.push('--setenv', key, value);
		}
		bindIfPresent(args, '--bind', homedir());
		if (runtimeDir) {
			bindIfPresent(args, '--bind', runtimeDir);
			args.push('--setenv', 'XDG_RUNTIME_DIR', runtimeDir);
		}
		bindIfPresent(args, '--bind', '/tmp');
		const sshAgentSocket = process.env['SSH_AUTH_SOCK'];
		const sshAgentIsBound = sshAgentSocket !== undefined
			&& ((runtimeDir !== undefined && inside(sshAgentSocket, runtimeDir)) || inside(sshAgentSocket, homedir()));
		if (options.hostAccess.ssh && sshAgentIsBound && sshAgentSocket) {
			args.push('--setenv', 'SSH_AUTH_SOCK', sshAgentSocket);
		}
		args.push('--dev', '/dev');
		if (options.hostAccess.devices) {
			// Expose only device classes useful to development/compute. Do not bind the
			// complete host /dev tree or raw block devices.
			for (const path of ['/dev/bus/usb', '/dev/dri', '/dev/kvm', '/dev/vfio']) {
				if (existsSync(path)) args.push('--dev-bind', path, path);
			}
			try {
				for (const name of readdirSync('/dev')) {
					if (/^nvidia(?:\d+|ctl|modeset|uvm(?:-tools)?|caps)$/u.test(name)) {
						const path = resolve('/dev', name);
						if (existsSync(path)) args.push('--dev-bind', path, path);
					}
				}
			} catch {
				// /dev may change while devices are hot-plugged; missing entries are fine.
			}
		}
		if (options.network === 'disabled') args.push('--unshare-net');
		if (options.hostAccess.systemWrite) {
			for (const path of ['/usr', '/etc', '/var']) bindIfPresent(args, '--bind', path);
		}
		if (options.hostAccess.mounts) {
			for (const path of ['/mnt', '/media']) bindIfPresent(args, '--bind', path);
		} else {
			for (const path of ['/mnt', '/media']) hideIfPresent(args, path);
		}
		if (!options.hostAccess.ssh) hideIfPresent(args, resolve(homedir(), '.ssh'));
		if (!options.hostAccess.docker) {
			for (const path of [
				'/run/docker.sock', '/var/run/docker.sock',
				...(runtimeDir ? [resolve(runtimeDir, 'docker.sock'), resolve(runtimeDir, 'podman', 'podman.sock')] : [])
			]) hideIfPresent(args, path);
		}
		if (options.hostAccess.sudo) {
			for (const path of ['/run/sudo', '/var/db/sudo']) bindIfPresent(args, '--bind', path);
		}
		for (const path of protectedPaths) hideIfPresent(args, path);
		args.push('--chdir', options.cwd, inner.file, ...inner.args);
		return {
			file: executable,
			args,
			status: {
				execution,
				profile: 'full-access',
				active: true,
				networkIsolated: options.network === 'disabled',
				reason: 'host-user process with host PID visibility and Tessarion protected paths hidden'
			}
		};
	}

	const workspace = sandboxPath(options.workspaceRoot);
	const cwd = sandboxPath(options.cwd);
	if (!workspace || !cwd || !inside(cwd, workspace)) {
		throw errors.denied('A restricted sandbox may only execute inside the current workspace.', {
			workspaceRoot: options.workspaceRoot, cwd: options.cwd
		});
	}

	const args: string[] = [
		'--die-with-parent', '--new-session', '--unshare-user', '--uid', '0', '--gid', '0',
		'--unshare-pid', '--unshare-ipc', '--unshare-uts',
		'--clearenv', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/forja-home',
		'--setenv', 'HOME', '/tmp/forja-home', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'TEMP', '/tmp',
		'--setenv', 'PATH', safePath(), '--setenv', 'FORJA_SANDBOX', options.profile,
		'--setenv', 'FORJA_SANDBOX_NETWORK', options.network
	];
	if (options.profile === 'full-access' && !options.hostAccess) {
		args.push('--bind', '/', '/');
		for (const path of protectedPaths) hideIfPresent(args, path);
		args.push('--chdir', options.cwd, inner.file, ...inner.args);
		return { file: executable, args, status: { execution, profile: options.profile, active: true, networkIsolated: false } };
	}
	// Do not pass the daemon's credentials into an isolated command. Locale and terminal hints are
	// explicitly preserved because they have no authority and keep CLI output usable.
	for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR'] as const) {
		const value = process.env[key];
		if (value) {
			args.push('--setenv', key, value);
		}
	}
	if (options.network === 'disabled') {
		args.push('--unshare-net');
	}
	for (const path of SYSTEM_READ_ONLY_PATHS) {
		// Preserve the destination spelling: on modern Linux `/bin` is usually a symlink to
		// `/usr/bin`; mounting its realpath at `/usr/bin` would leave `/bin/sh` absent.
		if (existsSync(path)) {
			args.push('--ro-bind', path, path);
		}
	}
	for (const path of userRuntimePaths()) {
		const resolved = sandboxPath(path);
		if (resolved) {
			args.push('--ro-bind', resolved, resolved);
		}
	}
	if (options.hostAccess) {
		const access = options.hostAccess;
		if (access.home) bindIfPresent(args, '--bind', homedir());
		if (!access.ssh) bindIfPresent(args, '--ro-bind', resolve(homedir(), '.ssh'));
		if (access.systemWrite) {
			for (const path of ['/usr', '/etc', '/var']) bindIfPresent(args, '--bind', path);
		}
		if (access.docker) {
			// On Debian-derived systems /var/run is already a symlink to /run. Mounting a
			// second symlink there makes Bubblewrap fail before the command starts. Binding
			// /run preserves that native relationship and exposes Docker's socket reliably.
			bindIfPresent(args, '--bind', '/run');
		}
		if (access.mounts) {
			for (const path of ['/mnt', '/media']) bindIfPresent(args, '--bind', path);
		}
		for (const path of protectedPaths) hideIfPresent(args, path);
	}
	args.push(options.profile === 'read-only' ? '--ro-bind' : '--bind', workspace, workspace);
	args.push('--chdir', cwd, inner.file, ...inner.args);
	return {
		file: executable,
		args,
		status: { execution, profile: options.profile, active: true, networkIsolated: options.network === 'disabled' }
	};
}

/** Exposed to the doctor command and tests without spawning a process. */
export function sandboxAvailability(): { available: boolean; executable?: string; platform: string } {
	const executable = process.platform === 'linux' ? bubblewrapPath() : undefined;
	return { available: executable !== undefined, executable, platform: process.platform };
}

/**
 * Checks whether the current Linux runtime can actually create the namespaces required by the
 * restricted sandbox. Some hosted CI kernels ship Bubblewrap but deny unprivileged network
 * namespaces; treating the binary's presence as sufficient would make those checks fail with a
 * misleading `RTM_NEWADDR` error. This probe is intentionally separate from sandboxLaunch: the
 * production path still fails closed when a configured sandbox cannot be enforced.
 */
export function sandboxRuntimeAvailability(): {
	available: boolean;
	executable?: string;
	platform: string;
	reason?: string;
} {
	const executable = process.platform === 'linux' ? bubblewrapPath() : undefined;
	if (!executable) {
		return {
			available: false,
			executable,
			platform: process.platform,
			reason: process.platform === 'linux' ? 'Bubblewrap is not installed' : 'Linux is required'
		};
	}
	if (runtimeProbe?.executable === executable) {
		return { available: runtimeProbe.available, executable, platform: process.platform, reason: runtimeProbe.reason };
	}

	const args = [
		'--die-with-parent', '--new-session', '--unshare-user', '--uid', '0', '--gid', '0',
		'--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--clearenv',
		'--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'
	];
	for (const path of SYSTEM_READ_ONLY_PATHS) {
		if (existsSync(path)) args.push('--ro-bind', path, path);
	}
	args.push('/usr/bin/true');

	try {
		const result = spawnSync(executable, args, { stdio: 'ignore', timeout: 3_000 });
		const available = result.status === 0 && !result.error;
		runtimeProbe = {
			executable,
			available,
			...(available ? {} : { reason: 'Bubblewrap cannot create the required user and network namespaces' })
		};
	} catch {
		runtimeProbe = {
			executable,
			available: false,
			reason: 'Bubblewrap runtime probe failed'
		};
	}
	return { available: runtimeProbe.available, executable, platform: process.platform, reason: runtimeProbe.reason };
}
