import type { MasterMcpBridge, MasterMcpBrowserRequest, MasterMcpScope } from './master-mcp.ts';

export interface AuthorizedCaller {
	readonly clientId: string;
	readonly workspaceIds: readonly string[];
	readonly scopes: readonly MasterMcpScope[];
	readonly authorizationRevision: number;
}

export interface LocalCall {
	readonly requestId: string;
	readonly tool: string;
	readonly arguments: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function limitText(value: unknown, limit = 60_000): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > limit ? `${text.slice(0, limit)}\n… truncated by Master MCP.` : text;
}

function requireWorkspace(caller: AuthorizedCaller, value: unknown): string {
	if (typeof value !== 'string' || !caller.workspaceIds.includes(value)) throw new Error('This connector is not authorized for the requested workspace.');
	return value;
}

function requireAgent(caller: AuthorizedCaller): void {
	if (!caller.scopes.includes('forja:agent')) throw new Error('The connector grant does not include forja:agent.');
}

function requireScope(caller: AuthorizedCaller, scope: MasterMcpScope): void {
	if (!caller.scopes.includes(scope)) throw new Error(`The connector grant does not include ${scope}.`);
}

function visibleWorkspaceTools(caller: AuthorizedCaller, tools: readonly { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean }[]): readonly { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean }[] {
	const hostTerminal = caller.scopes.includes('forja:host-terminal');
	const devices = caller.scopes.includes('forja:devices');
	return tools.filter((tool) => {
		const hostTool = tool.name === 'host_terminal_execute' || tool.name.startsWith('adb_');
		if (!hostTool) return true;
		return hostTerminal && (tool.name === 'host_terminal_execute' || devices);
	});
}

export function masterCapabilities(caller: AuthorizedCaller): Record<string, unknown> {
	const scopes = new Set(caller.scopes);
	const hostTerminal = scopes.has('forja:host-terminal');
	const windows = process.platform === 'win32';
	return {
		scopes: [...caller.scopes],
		workspaces: [...caller.workspaceIds],
		authorizationRevision: caller.authorizationRevision,
		effectivePermissions: {
			directWorkspaceApi: scopes.has('forja:agent'),
			outsideWorkspaceFiles: scopes.has('forja:outside-workspace'),
			protectedProjectFiles: scopes.has('forja:protected-files'),
			integratedBrowser: scopes.has('forja:browser'),
			browserImplementation: 'isolated Brave/CDP, not Codex GUI',
			terminal: {
				isolation: windows ? 'Windows host compatibility mode' : 'Bubblewrap when available',
				network: scopes.has('forja:terminal-network'),
				host: hostTerminal,
				home: hostTerminal,
				ssh: hostTerminal && scopes.has('forja:ssh'),
				docker: hostTerminal && scopes.has('forja:docker'),
				mounts: hostTerminal && scopes.has('forja:mounts'),
				devices: hostTerminal && scopes.has('forja:devices'),
				systemWrite: hostTerminal && scopes.has('forja:system-write'),
				sudo: hostTerminal && scopes.has('forja:sudo')
			},
			tessarionInstallationAndConfiguration: 'protected'
		},
		notes: [
			'Workspace aliases are project contexts, not a list of every host directory.',
			'Outside-workspace access permits absolute paths through workspace tools; host terminal access permits the user home through host_terminal_execute.',
			'USB/ADB access requires both host terminal and devices permission; terminal_execute remains workspace-sandboxed.',
			windows
				? 'Windows terminal compatibility mode runs with the signed-in user rights; Administrator actions still require UAC.'
				: 'Sudo still asks for the local Linux password when the system requires it.'
		]
	};
}

export async function dispatchAuthorizedMasterTool(input: {
	readonly bridge: MasterMcpBridge;
	readonly caller: AuthorizedCaller;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly includeSessions?: boolean;
}): Promise<unknown> {
	const { bridge, caller, name, args } = input;
	if (name === 'forja_get_capabilities') {
		return { content: [{ type: 'text', text: limitText(masterCapabilities(caller)) }] };
	}
	if (name === 'forja_list_workspaces') {
		requireScope(caller, 'forja:read');
		const all = await bridge.listWorkspaces();
		return { content: [{ type: 'text', text: limitText({ workspaces: all.filter((workspace) => caller.workspaceIds.includes(workspace.id)), capabilities: masterCapabilities(caller) }) }] };
	}
	const workspaceId = requireWorkspace(caller, args['workspaceId']);
	if (name === 'forja_list_workspace_tools') {
		requireScope(caller, 'forja:read');
		const tools = visibleWorkspaceTools(caller, await bridge.listWorkspaceTools({ workspaceId }));
		return { content: [{ type: 'text', text: limitText(tools) }] };
	}
	if (name.startsWith('forja_browser_')) {
		requireScope(caller, 'forja:read');
		requireScope(caller, 'forja:browser');
		const pageId = typeof args['pageId'] === 'string' ? args['pageId'] : undefined;
		const requirePage = (): string => {
			if (!pageId) throw new Error('pageId is required for this browser operation.');
			return pageId;
		};
		let request: MasterMcpBrowserRequest;
		switch (name) {
			case 'forja_browser_list_pages': request = { action: 'list' }; break;
			case 'forja_browser_open':
				requireAgent(caller);
				if (typeof args['url'] !== 'string' || args['url'].length === 0 || args['url'].length > 4096) throw new Error('A URL up to 4096 characters is required.');
				request = { action: 'open', url: args['url'] };
				break;
			case 'forja_browser_summary': request = { action: 'summary', pageId: requirePage() }; break;
			case 'forja_browser_execute': {
				requireAgent(caller);
				const code = typeof args['code'] === 'string' ? args['code'] : '';
				if (!code || code.length > 40_000) throw new Error('A browser function definition up to 40,000 characters is required.');
				const rawArgs = Array.isArray(args['args']) ? args['args'].slice(0, 20) : [];
				const timeoutMs = typeof args['timeoutMs'] === 'number' ? Math.max(1_000, Math.min(120_000, Math.floor(args['timeoutMs']))) : undefined;
				request = { action: 'execute', pageId: requirePage(), code, args: rawArgs, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
				break;
			}
			case 'forja_browser_screenshot': request = { action: 'screenshot', pageId: requirePage(), ...(args['fullPage'] === true ? { fullPage: true } : {}) }; break;
			case 'forja_browser_share_page': requireAgent(caller); request = { action: 'share', pageId: requirePage() }; break;
			case 'forja_browser_unshare_page': requireAgent(caller); request = { action: 'unshare', pageId: requirePage() }; break;
			default: throw new Error(`Unknown browser tool: ${name}`);
		}
		const browserData = await bridge.browserRequest({ workspaceId, request });
		return { content: [{ type: 'text', text: limitText(browserData, name === 'forja_browser_screenshot' ? 5_000_000 : 60_000) }] };
	}
	if (name === 'forja_call_workspace_tool') {
		requireScope(caller, 'forja:read');
		const tool = typeof args['tool'] === 'string' ? args['tool'] : '';
		const toolArgs = asRecord(args['arguments']);
		if (!tool || !toolArgs) throw new Error('tool and an arguments object are required.');
		const data = await bridge.callWorkspaceTool({ workspaceId, name: tool, args: toolArgs, scopes: caller.scopes });
		return { content: [{ type: 'text', text: limitText(data) }] };
	}
	if (input.includeSessions !== true) throw new Error(`Unknown Master MCP tool: ${name}`);
	const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'] : '';
	const mode = args['mode'] === 'ask' || args['mode'] === 'plan' || args['mode'] === 'agent' ? args['mode'] : undefined;
	let data: unknown;
	if (name === 'forja_start_session') { requireAgent(caller); data = await bridge.startSession({ workspaceId, ...(typeof args['title'] === 'string' ? { title: args['title'].slice(0, 160) } : {}), ...(mode ? { mode } : {}) }); }
	else if (name === 'forja_send_task') { requireAgent(caller); if (!sessionId || typeof args['text'] !== 'string' || args['text'].length > 20_000) throw new Error('sessionId and a task up to 20,000 characters are required.'); data = await bridge.sendTask({ workspaceId, sessionId, text: args['text'], ...(mode ? { mode } : {}) }); }
	else if (name === 'forja_session_status') data = await bridge.sessionStatus({ workspaceId, sessionId });
	else if (name === 'forja_read_transcript') data = await bridge.readTranscript({ workspaceId, sessionId, limit: typeof args['limit'] === 'number' ? Math.max(1, Math.min(100, Math.floor(args['limit']))) : 30 });
	else if (name === 'forja_get_changes') data = await bridge.getChanges({ workspaceId, sessionId });
	else if (name === 'forja_cancel_turn') { requireAgent(caller); data = await bridge.cancelTurn({ workspaceId, sessionId }); }
	else throw new Error(`Unknown Master MCP tool: ${name}`);
	return { content: [{ type: 'text', text: limitText(data) }] };
}
