import type { MasterMcpBridge } from '../master/master-mcp.ts';
import type { AuthorizedCaller } from '../master/master-mcp-dispatcher.ts';

export interface WebAiApprovalDecision {
	readonly requiresApproval: boolean;
	readonly readOnly: boolean;
	readonly reason: string;
	readonly effectiveTool: string;
}

const readOnlyMasterTools = new Set([
	'forja_get_capabilities',
	'forja_list_workspaces',
	'forja_list_workspace_tools',
	'forja_browser_list_pages',
	'forja_browser_summary',
	'forja_browser_screenshot'
]);

const mutationMasterTools = new Set([
	'forja_browser_open',
	'forja_browser_execute',
	'forja_browser_share_page',
	'forja_browser_unshare_page',
	'forja_start_session',
	'forja_send_task',
	'forja_cancel_turn'
]);

export async function classifyWebAiCall(input: {
	readonly bridge: MasterMcpBridge;
	readonly caller: AuthorizedCaller;
	readonly name: string;
	readonly args: Record<string, unknown>;
}): Promise<WebAiApprovalDecision> {
	if (readOnlyMasterTools.has(input.name)) {
		return { requiresApproval: false, readOnly: true, reason: 'Lectura directa del host Master MCP.', effectiveTool: input.name };
	}
	if (mutationMasterTools.has(input.name)) {
		return { requiresApproval: true, readOnly: false, reason: 'La herramienta puede modificar estado o interactuar con el navegador.', effectiveTool: input.name };
	}
	if (input.name === 'forja_call_workspace_tool') {
		const workspaceId = typeof input.args['workspaceId'] === 'string' ? input.args['workspaceId'] : '';
		const innerName = typeof input.args['tool'] === 'string' ? input.args['tool'] : '';
		if (!workspaceId || !innerName || !input.caller.workspaceIds.includes(workspaceId)) {
			return { requiresApproval: true, readOnly: false, reason: 'No se pudo verificar el workspace o la herramienta interior.', effectiveTool: innerName || input.name };
		}
		const tools = await input.bridge.listWorkspaceTools({ workspaceId });
		const inner = tools.find((tool) => tool.name === innerName);
		if (!inner) return { requiresApproval: true, readOnly: false, reason: 'Herramienta interior desconocida; requiere revisión local.', effectiveTool: innerName };
		const readOnly = inner.readOnly === true;
		const trustedWorkspaceMutation = !readOnly && input.caller.scopes.includes('forja:agent');
		return {
			requiresApproval: false,
			readOnly,
			reason: readOnly
				? 'La herramienta interior está marcada como solo lectura.'
				: trustedWorkspaceMutation
					? 'El navegador ya tiene forja:agent para este workspace; la modificación no requiere una segunda aprobación.'
					: 'La herramienta modifica el workspace pero el grant no incluye forja:agent; el dispatcher la rechazará sin abrir una aprobación por operación.',
			effectiveTool: innerName
		};
	}
	return { requiresApproval: true, readOnly: false, reason: 'Herramienta no clasificada para IA web local; se requiere revisión explícita.', effectiveTool: input.name };
}
