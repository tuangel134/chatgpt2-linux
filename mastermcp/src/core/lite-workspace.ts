import { basename, isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { GitService } from './platform/git.ts';
import { BackgroundProcessRegistry } from './platform/process.ts';
import { DEFAULT_SETTINGS, type ForjaSettings } from './platform/config/schema.ts';
import { WorkspaceBoundary } from './security/workspace-boundary.ts';
import type { Logger } from './platform/logger.ts';
import type { MasterMcpScope } from '../master/master-mcp.ts';
import { LITE_HOST_TOOL_MAP, LITE_TOOL_MAP } from './lite-tools.ts';
import type { Tool, ToolContext } from './tools/types.ts';
import { isPathWithin } from './platform/path-safety.ts';

export const MASTER_MCP_SCOPES: readonly MasterMcpScope[] = [
	'forja:read', 'forja:agent', 'forja:browser', 'forja:outside-workspace', 'forja:terminal-network',
	'forja:protected-files', 'forja:host-terminal', 'forja:system-write', 'forja:ssh', 'forja:docker',
	'forja:mounts', 'forja:devices', 'forja:sudo'
];

export interface LiteWorkspaceInfo {
	readonly id: string;
	readonly name: string;
	readonly root: string;
}

function pathArguments(args: Record<string, unknown>): string[] {
	const values: string[] = [];
	for (const key of ['path', 'paths', 'from', 'to', 'cwd', 'localPath', 'apkPath']) {
		const value = args[key];
		if (typeof value === 'string') values.push(value);
		else if (Array.isArray(value)) values.push(...value.filter((entry): entry is string => typeof entry === 'string'));
	}
	return values;
}

/**
 * Lite has no native protected process boundary on Windows yet. Never fall back
 * to an unwrapped host process: that could expose or modify Lite itself.
 */
export function terminalSandboxFallback(_scopes: readonly MasterMcpScope[], _platform: NodeJS.Platform = process.platform): 'allow' | 'deny' {
	return 'deny';
}

function copySettings(): ForjaSettings {
	return structuredClone(DEFAULT_SETTINGS) as ForjaSettings;
}

/**
 * A workspace-scoped direct API host. It deliberately has no model registry or agent runtime:
 * Master MCP Lite is a controller for external assistants, not another assistant hidden in the app.
 */
export class LiteWorkspace {
	readonly info: LiteWorkspaceInfo;
	readonly root: string;
	private readonly protectedRoots: readonly string[];
	private readonly processes: BackgroundProcessRegistry;
	private readonly logger: Logger;
	git: GitService | undefined;

	constructor(input: { id: string; name: string; root: string; protectedRoots: readonly string[]; processes: BackgroundProcessRegistry; logger: Logger }) {
		this.info = { id: input.id, name: input.name, root: resolve(input.root) };
		this.root = this.info.root;
		this.protectedRoots = input.protectedRoots.map((path) => resolve(path));
		this.processes = input.processes;
		this.logger = input.logger.child(`workspace.${this.info.id}`);
	}

	async initialize(): Promise<void> {
		this.git = await GitService.detect(this.root, this.logger);
	}

	listTools(): readonly { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean }[] {
		return [...LITE_TOOL_MAP.values(), ...LITE_HOST_TOOL_MAP.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, readOnly: tool.readOnly }));
	}

	async call(name: string, args: Record<string, unknown>, scopes: readonly MasterMcpScope[]): Promise<unknown> {
		const hostTool = LITE_HOST_TOOL_MAP.get(name);
		const tool = hostTool ?? LITE_TOOL_MAP.get(name);
		if (!tool) throw new Error(`The Lite workspace tool "${name}" is unavailable.`);
		if (!scopes.includes('forja:read')) throw new Error('The connector grant does not include forja:read.');
		if (hostTool && !scopes.includes('forja:host-terminal')) throw new Error(`The connector grant does not include forja:host-terminal for ${name}.`);
		if (name.startsWith('adb_') && !scopes.includes('forja:devices')) throw new Error(`The connector grant does not include forja:devices for ${name}.`);
		if (!tool.readOnly && !scopes.includes('forja:agent')) throw new Error(`The connector grant does not include forja:agent for ${name}.`);
		for (const value of pathArguments(args)) {
			if (await this.isProtected(value)) throw new Error('Master MCP Lite cannot read or modify its own installation or configuration.');
		}

		const settings = copySettings();
		settings.agent.autoApproveEdits = false;
		settings.agent.autoApproveTerminal = 'never';
		settings.security.allowOutsideWorkspace = scopes.includes('forja:outside-workspace');
		settings.security.allowedExternalPaths = [];
		settings.security.sandboxProfile = 'workspace-write';
		settings.security.sandboxNetwork = scopes.includes('forja:terminal-network') ? 'enabled' : 'disabled';
		settings.security.sandboxFallback = terminalSandboxFallback(scopes);
		if (scopes.includes('forja:protected-files')) settings.security.blockedPaths = [];
		const boundary = new WorkspaceBoundary({
			workspaceRoot: this.root,
			allowOutsideWorkspace: settings.security.allowOutsideWorkspace,
			allowedExternalPaths: settings.security.allowedExternalPaths,
			blockedPaths: settings.security.blockedPaths
		});
		const changes: unknown[] = [];
		const context: ToolContext = {
			workspaceRoot: this.root,
			boundary,
			settings,
			logger: this.logger,
			git: this.git,
			processes: this.processes,
			signal: new AbortController().signal,
			sessionId: `master-mcp-lite:${this.info.id}`,
			stepIndex: 0,
			confirm: async () => false,
			diagnostics: undefined,
			editor: undefined,
			onFileChange: (change) => changes.push(change),
			protectedHostPaths: this.protectedRoots,
			hostTerminalPermissions: scopes.includes('forja:host-terminal') ? {
				home: true,
				ssh: scopes.includes('forja:ssh'),
				docker: scopes.includes('forja:docker'),
				mounts: scopes.includes('forja:mounts'),
				systemWrite: scopes.includes('forja:system-write'),
				devices: scopes.includes('forja:devices'),
				sudo: scopes.includes('forja:sudo')
			} : undefined
		};
		const result = await tool.execute(args, context);
		const output = result.output.length > settings.tools.maxOutputChars ? `${result.output.slice(0, settings.tools.maxOutputChars)}\n… output truncated.` : result.output;
		return {
			tool: name,
			output,
			isError: result.isError === true,
			...(result.data ? { data: result.data } : {}),
			...(result.truncated ? { truncated: true } : {}),
			...(changes.length ? { changes } : {})
		};
	}

	private async isProtected(input: string): Promise<boolean> {
		const candidate = isAbsolute(input) ? input : resolve(this.root, input);
		const resolvedCandidate = await realpath(candidate).catch(() => candidate);
		return this.protectedRoots.some((root) => isPathWithin(root, resolvedCandidate));
	}
}

export function workspaceName(root: string): string {
	return basename(resolve(root)) || resolve(root);
}
