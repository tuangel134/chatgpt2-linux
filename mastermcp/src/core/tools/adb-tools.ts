import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { errors, ForjaError, ErrorCode } from '../platform/errors.ts';
import { RiskClass } from '../security/command-classifier.ts';
import { int, objectSchema, requireValid, str } from './schema.ts';
import type { Tool, ToolContext, ToolResult } from './types.ts';

interface ProgramResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const SAFE_ENDPOINT = /^(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\]):([0-9]{1,5})$/;

function requireDeviceGrant(context: ToolContext): void {
	if (!context.hostTerminalPermissions?.home || !context.hostTerminalPermissions.devices) {
		throw errors.denied('ADB requires both "Terminal del host" and "Dispositivos USB / ADB" permissions.');
	}
}

function safeValue(value: unknown, name: string, pattern = SAFE_ID): string {
	const text = String(value ?? '').trim();
	if (!pattern.test(text)) throw errors.invalidArgument(`${name} is invalid.`);
	return text;
}

function safeRemotePath(value: unknown, name: string): string {
	const text = String(value ?? '').trim();
	if (!text || text.length > 2048 || /[\0\r\n]/.test(text)) throw errors.invalidArgument(`${name} is invalid.`);
	return text;
}

function runProgram(file: string, args: readonly string[], context: ToolContext, timeoutMs = 30_000): Promise<ProgramResult> {
	return new Promise((resolve, reject) => {
		execFile(file, [...args], {
			cwd: context.workspaceRoot,
			env: { ...process.env, HOME: homedir() },
			windowsHide: true,
			timeout: timeoutMs,
			maxBuffer: 2_000_000,
			signal: context.signal
		}, (error, stdout, stderr) => {
			if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(new ForjaError(`${file} is not installed on the host.`, { code: ErrorCode.NotFound }));
				return;
			}
			if (error && error.name === 'AbortError') {
				reject(errors.cancelled());
				return;
			}
			resolve({
				exitCode: typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
					? Number((error as NodeJS.ErrnoException).code)
					: error ? 1 : 0,
				stdout: String(stdout ?? ''),
				stderr: String(stderr ?? '')
			});
		});
	});
}

async function runAdb(args: readonly string[], context: ToolContext, displayArgs: readonly string[] = args, timeoutMs = 30_000): Promise<ToolResult> {
	requireDeviceGrant(context);
	const start = await runProgram('adb', ['start-server'], context, 15_000);
	if (start.exitCode !== 0) {
		return { output: `adb start-server failed\n${start.stderr || start.stdout}`.trim(), isError: true, data: { exitCode: start.exitCode } };
	}
	const result = await runProgram('adb', args, context, timeoutMs);
	const body = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n[stderr]\n');
	return {
		output: `$ adb ${displayArgs.join(' ')}\n${body || '(no output)'}\n[exit code ${result.exitCode}]`,
		isError: result.exitCode !== 0,
		data: { exitCode: result.exitCode }
	};
}

function serialArgs(raw: unknown): string[] {
	return raw === undefined || String(raw).trim() === '' ? [] : ['-s', safeValue(raw, 'serial')];
}

export const adbDevicesTool: Tool = {
	name: 'adb_devices',
	description: 'List Android devices through the persistent ADB server running as the signed-in host user.',
	parameters: objectSchema({}), source: 'builtin', risk: RiskClass.Safe, mutates: false, parallelSafe: true, readOnly: true,
	execute: async (_raw, context) => runAdb(['devices', '-l'], context)
};

export const adbShellTool: Tool = {
	name: 'adb_shell', description: 'Run a command on one authorized Android device. The command runs on the phone, not on the PC shell.',
	parameters: objectSchema({ serial: str('ADB serial. Optional when only one device is connected.'), command: str('Android shell command.') }, ['command']),
	source: 'builtin', risk: RiskClass.Dangerous, mutates: true, parallelSafe: false, readOnly: false,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		const command = safeRemotePath(args['command'], 'command');
		return runAdb([...serialArgs(args['serial']), 'shell', command], context);
	}
};

export const adbPullTool: Tool = {
	name: 'adb_pull', description: 'Copy a file from an Android device into the authorized workspace.',
	parameters: objectSchema({ serial: str('ADB serial.'), remotePath: str('Path on Android.'), localPath: str('Workspace-relative destination.') }, ['remotePath', 'localPath']),
	source: 'builtin', risk: RiskClass.Modify, mutates: true, parallelSafe: false, readOnly: false,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		const local = await context.boundary.resolve(String(args['localPath']), 'write');
		return runAdb([...serialArgs(args['serial']), 'pull', safeRemotePath(args['remotePath'], 'remotePath'), local.absolute], context);
	}
};

export const adbPushTool: Tool = {
	name: 'adb_push', description: 'Copy a workspace file to an Android device.',
	parameters: objectSchema({ serial: str('ADB serial.'), localPath: str('Workspace-relative source.'), remotePath: str('Destination path on Android.') }, ['localPath', 'remotePath']),
	source: 'builtin', risk: RiskClass.Dangerous, mutates: true, parallelSafe: false, readOnly: false,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		const local = await context.boundary.resolve(String(args['localPath']), 'read');
		return runAdb([...serialArgs(args['serial']), 'push', local.absolute, safeRemotePath(args['remotePath'], 'remotePath')], context);
	}
};

export const adbInstallTool: Tool = {
	name: 'adb_install', description: 'Install an APK from the authorized workspace on an Android device.',
	parameters: objectSchema({ serial: str('ADB serial.'), apkPath: str('Workspace-relative APK path.') }, ['apkPath']),
	source: 'builtin', risk: RiskClass.Dangerous, mutates: true, parallelSafe: false, readOnly: false,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		const apk = await context.boundary.resolve(String(args['apkPath']), 'read');
		return runAdb([...serialArgs(args['serial']), 'install', '-r', apk.absolute], context, undefined, 180_000);
	}
};

export const adbUninstallTool: Tool = {
	name: 'adb_uninstall', description: 'Uninstall one Android package from the selected device.',
	parameters: objectSchema({ serial: str('ADB serial.'), packageName: str('Android package name.') }, ['packageName']),
	source: 'builtin', risk: RiskClass.Dangerous, mutates: true, parallelSafe: false, readOnly: false,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		return runAdb([...serialArgs(args['serial']), 'uninstall', safeValue(args['packageName'], 'packageName', SAFE_PACKAGE)], context);
	}
};

export const adbPackagesTool: Tool = {
	name: 'adb_packages', description: 'List package names installed on an Android device.',
	parameters: objectSchema({ serial: str('ADB serial.') }), source: 'builtin', risk: RiskClass.Safe, mutates: false, parallelSafe: true, readOnly: true,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		return runAdb([...serialArgs(args['serial']), 'shell', 'pm list packages'], context);
	}
};

export const adbPackagePathsTool: Tool = {
	name: 'adb_package_paths', description: 'Show APK paths for one Android package.',
	parameters: objectSchema({ serial: str('ADB serial.'), packageName: str('Android package name.') }, ['packageName']),
	source: 'builtin', risk: RiskClass.Safe, mutates: false, parallelSafe: true, readOnly: true,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		const name = safeValue(args['packageName'], 'packageName', SAFE_PACKAGE);
		return runAdb([...serialArgs(args['serial']), 'shell', `pm path ${name}`], context);
	}
};

export const adbLogcatTool: Tool = {
	name: 'adb_logcat', description: 'Read a bounded snapshot of Android logcat.',
	parameters: objectSchema({ serial: str('ADB serial.'), lines: int('Maximum recent lines.', { minimum: 1, maximum: 5000, default: 300 }) }),
	source: 'builtin', risk: RiskClass.Safe, mutates: false, parallelSafe: true, readOnly: true,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		return runAdb([...serialArgs(args['serial']), 'logcat', '-d', '-t', String(args['lines'] ?? 300)], context);
	}
};

export const adbRebootTool: Tool = {
	name: 'adb_reboot', description: 'Reboot an Android device into system, recovery or bootloader.',
	parameters: objectSchema({ serial: str('ADB serial.'), target: str('Reboot target.', { enum: ['system', 'recovery', 'bootloader'], default: 'system' }) }),
	source: 'builtin', risk: RiskClass.Dangerous, mutates: true, parallelSafe: false, readOnly: false,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		const target = String(args['target'] ?? 'system');
		return runAdb([...serialArgs(args['serial']), 'reboot', ...(target === 'system' ? [] : [target])], context);
	}
};

export const adbConnectTool: Tool = {
	name: 'adb_connect', description: 'Connect the persistent host ADB server to an Android wireless-debugging endpoint.',
	parameters: objectSchema({ endpoint: str('Host or IP and port, for example 192.168.1.20:37099.') }, ['endpoint']),
	source: 'builtin', risk: RiskClass.Modify, mutates: true, parallelSafe: false, readOnly: false,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		return runAdb(['connect', safeValue(args['endpoint'], 'endpoint', SAFE_ENDPOINT)], context);
	}
};

export const adbPairTool: Tool = {
	name: 'adb_pair', description: 'Pair the persistent host ADB server using the endpoint and six-digit code shown by Android. The pairing code is redacted from output.',
	parameters: objectSchema({ endpoint: str('Pairing host or IP and port.'), pairingCode: str('Six-digit pairing code.') }, ['endpoint', 'pairingCode']),
	source: 'builtin', risk: RiskClass.Dangerous, mutates: true, parallelSafe: false, readOnly: false,
	async execute(raw, context) {
		const args = requireValid(raw, this.parameters, this.name);
		const endpoint = safeValue(args['endpoint'], 'endpoint', SAFE_ENDPOINT);
		const code = safeValue(args['pairingCode'], 'pairingCode', /^[0-9]{6}$/);
		return runAdb(['pair', endpoint, code], context, ['pair', endpoint, '[redacted]'], 120_000);
	}
};

export const adbMdnsServicesTool: Tool = {
	name: 'adb_mdns_services', description: 'Discover Android wireless-debugging pairing and connection services. Falls back to Avahi when the installed ADB lacks mDNS support.',
	parameters: objectSchema({}), source: 'builtin', risk: RiskClass.Safe, mutates: false, parallelSafe: true, readOnly: true,
	async execute(_raw, context) {
		requireDeviceGrant(context);
		const start = await runProgram('adb', ['start-server'], context, 15_000);
		if (start.exitCode !== 0) {
			return { output: `adb start-server failed\n${start.stderr || start.stdout}`.trim(), isError: true, data: { exitCode: start.exitCode } };
		}
		const native = await runProgram('adb', ['mdns', 'services'], context, 8_000);
		if (native.exitCode === 0 && !/not supported/i.test(`${native.stdout}\n${native.stderr}`)) {
			return { output: native.stdout.trim() || '(no ADB mDNS services found)', data: { backend: 'adb' } };
		}
		const discovered: string[] = [];
		for (const service of ['_adb-tls-pairing._tcp', '_adb-tls-connect._tcp']) {
			const result = await runProgram('avahi-browse', ['-rtp', service], context, 5_000);
			if (result.exitCode === 0 && result.stdout.trim()) discovered.push(result.stdout.trim());
		}
		return {
			output: discovered.join('\n') || 'No Android wireless-debugging services were found through Avahi.',
			data: { backend: 'avahi', adbMdnsSupported: false }
		};
	}
};

export const MASTER_MCP_ADB_TOOLS: readonly Tool[] = [
	adbDevicesTool, adbShellTool, adbPullTool, adbPushTool, adbInstallTool, adbUninstallTool,
	adbPackagesTool, adbPackagePathsTool, adbLogcatTool, adbRebootTool, adbConnectTool, adbPairTool,
	adbMdnsServicesTool
];
