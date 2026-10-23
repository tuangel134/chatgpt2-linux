import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '../core/platform/logger.ts';
import type { MasterMcpBridge, MasterMcpScope } from '../master/master-mcp.ts';
import { dispatchAuthorizedMasterTool } from '../master/master-mcp-dispatcher.ts';
import { classifyWebAiCall } from './approval-policy.ts';
import { WebAiGrantStore, type WebAiClient, type WebAiSession } from './grants.ts';
import { WebAiRequestStore, type WebAiRequestRecord } from './request-store.ts';
import {
	WEB_AI_DEFAULT_PORT,
	WEB_AI_EXECUTION_TIMEOUT_MS,
	WEB_AI_MAX_BODY_BYTES,
	WEB_AI_MAX_RUNNING_GLOBAL,
	WEB_AI_PROTOCOL_VERSION,
	boundedPort,
	isLoopbackHost,
	isRecord,
	isValidExtensionOrigin,
	type WebAiProvider
} from './protocol.ts';

export interface LocalWebAiBrokerStatus {
	readonly running: boolean;
	readonly port: number;
	readonly localUrl?: string;
	readonly pairingOpen: boolean;
	readonly pendingPairs: ReturnType<WebAiGrantStore['pendingPairSummaries']>;
	readonly clients: ReturnType<WebAiGrantStore['clientSummaries']>;
	readonly sessions: ReturnType<WebAiGrantStore['sessionSummaries']>;
	readonly pendingApprovals: Array<{ id: string; tool: string; clientId: string; sessionId: string; createdAt: number; expiresAt?: number }>;
	readonly activity: ReturnType<WebAiRequestStore['summaries']>;
}

interface BrokerOptions {
	readonly bridge: MasterMcpBridge;
	readonly grants: WebAiGrantStore;
	readonly requests: WebAiRequestStore;
	readonly logger: Logger;
}

function bearer(request: IncomingMessage): string {
	const header = request.headers.authorization;
	if (typeof header !== 'string') return '';
	const match = /^Bearer\s+(.+)$/i.exec(header);
	return match?.[1] ?? '';
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > WEB_AI_MAX_BODY_BYTES) throw new Error('El cuerpo supera el límite local de 256 KiB.');
		chunks.push(bytes);
	}
	if (chunks.length === 0) return {};
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	if (!isRecord(parsed)) throw new Error('Se esperaba un objeto JSON.');
	return parsed;
}

function responseHeaders(origin?: string): Record<string, string> {
	return {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
		...(origin && isValidExtensionOrigin(origin) ? {
			'access-control-allow-origin': origin,
			'vary': 'Origin',
			'access-control-allow-methods': 'GET, POST, OPTIONS',
			'access-control-allow-headers': 'Authorization, Content-Type, X-Tessarion-Extension-Origin',
			'access-control-max-age': '300'
		} : {})
	};
}

function json(response: ServerResponse, status: number, body: unknown, origin?: string): void {
	response.writeHead(status, responseHeaders(origin));
	response.end(JSON.stringify(body));
}

function publicRequest(request: WebAiRequestRecord): Record<string, unknown> {
	return {
		id: request.id,
		tool: request.tool,
		state: request.state,
		createdAt: request.createdAt,
		updatedAt: request.updatedAt,
		...(request.approvalDeadline ? { approvalDeadline: request.approvalDeadline } : {}),
		...(request.result !== undefined ? { result: request.result, resultTruncated: request.resultTruncated === true } : {}),
		...(request.error ? { error: request.error } : {})
	};
}

function provider(value: unknown): WebAiProvider {
	return value === 'qwen' || value === 'deepseek' || value === 'integrated' ? value : 'unknown';
}

function scopes(input: unknown): MasterMcpScope[] {
	const valid = new Set<MasterMcpScope>(['forja:read','forja:agent','forja:browser','forja:outside-workspace','forja:terminal-network','forja:protected-files','forja:host-terminal','forja:system-write','forja:ssh','forja:docker','forja:mounts','forja:devices','forja:sudo']);
	return Array.isArray(input) ? [...new Set(input.filter((value): value is MasterMcpScope => typeof value === 'string' && valid.has(value as MasterMcpScope)))] : [];
}

const WEB_AI_MASTER_TOOL_NAMES = new Set([
	'forja_get_capabilities',
	'forja_list_workspaces',
	'forja_list_workspace_tools',
	'forja_call_workspace_tool',
	'forja_browser_list_pages',
	'forja_browser_open',
	'forja_browser_summary',
	'forja_browser_execute',
	'forja_browser_screenshot',
	'forja_browser_share_page',
	'forja_browser_unshare_page',
	'forja_start_session',
	'forja_send_task',
	'forja_session_status',
	'forja_read_transcript',
	'forja_get_changes',
	'forja_cancel_turn'
]);

async function resolveWebAiToolAlias(input: {
	readonly bridge: MasterMcpBridge;
	readonly session: WebAiSession;
	readonly tool: string;
	readonly args: Record<string, unknown>;
}): Promise<{ tool: string; args: Record<string, unknown> }> {
	if (WEB_AI_MASTER_TOOL_NAMES.has(input.tool)) return { tool: input.tool, args: input.args };
	const tools = await input.bridge.listWorkspaceTools({ workspaceId: input.session.workspaceId });
	const requested = input.tool.startsWith('forja_') ? input.tool.slice('forja_'.length) : input.tool;
	const inner = tools.find((tool) => tool.name === requested);
	if (!inner) return { tool: input.tool, args: input.args };
	return {
		tool: 'forja_call_workspace_tool',
		args: { workspaceId: input.session.workspaceId, tool: inner.name, arguments: input.args }
	};
}

export class LocalWebAiBroker {
	private readonly bridge: MasterMcpBridge;
	private readonly grants: WebAiGrantStore;
	private readonly requests: WebAiRequestStore;
	private readonly logger: Logger;
	private server: Server | undefined;
	private port = WEB_AI_DEFAULT_PORT;
	private accepting = false;
	private runningGlobal = 0;
	private readonly runningSessions = new Set<string>();
	private readonly rateByClient = new Map<string, number[]>();

	constructor(options: BrokerOptions) {
		this.bridge = options.bridge;
		this.grants = options.grants;
		this.requests = options.requests;
		this.logger = options.logger.child('web-ai-local');
	}

	status(): LocalWebAiBrokerStatus {
		return {
			running: Boolean(this.server),
			port: this.port,
			...(this.server ? { localUrl: `http://127.0.0.1:${this.port}` } : {}),
			pairingOpen: this.grants.pairingOpen(),
			pendingPairs: this.grants.pendingPairSummaries(),
			clients: this.grants.clientSummaries(),
			sessions: this.grants.sessionSummaries(),
			pendingApprovals: this.requests.pendingApprovals().map((request) => ({ id: request.id, tool: request.tool, clientId: request.clientId, sessionId: request.sessionId, createdAt: request.createdAt, ...(request.approvalDeadline ? { expiresAt: request.approvalDeadline } : {}) })),
			activity: this.requests.summaries()
		};
	}

	async start(requestedPort = WEB_AI_DEFAULT_PORT): Promise<LocalWebAiBrokerStatus> {
		if (this.server) return this.status();
		await Promise.all([this.grants.initialize(), this.requests.initialize()]);
		const port = boundedPort(requestedPort);
		const server = createServer((request, response) => void this.handle(request, response));
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: NodeJS.ErrnoException): void => reject(error);
				server.once('error', onError);
				server.listen(port, '127.0.0.1', () => {
					server.removeListener('error', onError);
					resolve();
				});
			});
		} catch (error) {
			server.removeAllListeners('error');
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code === 'EADDRINUSE') throw new Error(`El puerto local ${port} ya está ocupado. IA web local no detendrá ni reemplazará ese proceso.`);
			throw error;
		}
		this.server = server;
		this.port = port;
		this.accepting = true;
		this.logger.info('IA web local listening on loopback', { port });
		return this.status();
	}

	async stop(): Promise<void> {
		this.accepting = false;
		const server = this.server;
		this.server = undefined;
		this.grants.closeAllSessions();
		await this.requests.stopPending();
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	beginPairing(): { code: string; expiresAt: number } {
		if (!this.server) throw new Error('Enciende IA web local antes de vincular una extensión.');
		return this.grants.beginPairing();
	}

	async approvePair(id: string, workspaceIds: readonly string[], approvedScopes: readonly MasterMcpScope[]): Promise<LocalWebAiBrokerStatus> {
		await this.grants.approvePair(id, workspaceIds, approvedScopes);
		return this.status();
	}

	denyPair(id: string): LocalWebAiBrokerStatus {
		this.grants.denyPair(id);
		return this.status();
	}

	async updateClient(id: string, workspaceIds: readonly string[], approvedScopes: readonly MasterMcpScope[]): Promise<LocalWebAiBrokerStatus> {
		await this.grants.updateClient(id, workspaceIds, approvedScopes);
		return this.status();
	}

	async revokeClient(id: string): Promise<LocalWebAiBrokerStatus> {
		await this.grants.revokeClient(id);
		return this.status();
	}

	pauseSession(id: string, paused: boolean): LocalWebAiBrokerStatus {
		this.grants.pauseSession(id, paused);
		return this.status();
	}

	async approveRequest(id: string): Promise<LocalWebAiBrokerStatus> {
		const request = this.requests.get(id);
		if (!request || request.state !== 'pending-approval') throw new Error('La operación ya no espera aprobación.');
		const caller = this.grants.callerForSession(request.sessionId);
		const decision = await classifyWebAiCall({ bridge: this.bridge, caller, name: request.tool, args: request.arguments });
		if (!decision.requiresApproval) {
			await this.requests.approve(id, caller.authorizationRevision);
		} else {
			await this.requests.approve(id, caller.authorizationRevision);
		}
		this.scheduleDrain();
		return this.status();
	}

	async denyRequest(id: string): Promise<LocalWebAiBrokerStatus> {
		await this.requests.deny(id);
		return this.status();
	}

	private origin(request: IncomingMessage): string | undefined {
		if (typeof request.headers.origin === 'string') return request.headers.origin;
		const fallback = request.headers['x-tessarion-extension-origin'];
		return typeof fallback === 'string' ? fallback : undefined;
	}

	private validateTransport(request: IncomingMessage, requireOrigin: boolean): string | undefined {
		if (!isLoopbackHost(request.headers.host, this.port)) throw new Error('Host local no permitido.');
		const origin = this.origin(request);
		if (requireOrigin && !isValidExtensionOrigin(origin)) throw new Error('Origen de extensión no permitido.');
		if (origin && !isValidExtensionOrigin(origin)) throw new Error('Origen no permitido.');
		return origin;
	}

	private rateLimit(clientId: string): void {
		const now = Date.now();
		const recent = (this.rateByClient.get(clientId) ?? []).filter((time) => time >= now - 60_000);
		if (recent.length >= 60) throw new Error('Límite local temporal alcanzado para este navegador.');
		recent.push(now);
		this.rateByClient.set(clientId, recent);
	}

	private authenticateClient(request: IncomingMessage, origin: string): WebAiClient {
		const token = bearer(request);
		if (!token) throw new Error('Falta la credencial del navegador vinculado.');
		return this.grants.authenticateClient(token, origin);
	}

	private authenticateSession(request: IncomingMessage, origin: string): WebAiSession {
		const token = bearer(request);
		if (!token) throw new Error('Falta el token de sesión de IA web local.');
		return this.grants.authenticateSession(token, origin);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		let origin: string | undefined;
		try {
			const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`).pathname;
			origin = this.validateTransport(request, pathname !== '/v1/health');
			if (request.method === 'OPTIONS') {
				if (!origin) throw new Error('Origen requerido para preflight.');
				response.writeHead(204, responseHeaders(origin));
				response.end();
				return;
			}
			if (request.method === 'GET' && pathname === '/v1/health') {
				return json(response, 200, { v: WEB_AI_PROTOCOL_VERSION, available: this.accepting, service: 'tessarion-web-ai-local' }, origin);
			}
			if (!this.accepting) return json(response, 503, { error: 'IA web local está detenida.' }, origin);
			if (!origin) throw new Error('Origen de extensión requerido.');
			if (request.method === 'POST' && pathname === '/v1/pair') {
				if (!this.grants.pairingOpen()) return json(response, 403, { error: 'Abre una ventana de vinculación desde Tessarion.' }, origin);
				const body = await readJson(request);
				const result = this.grants.requestPair({
					code: typeof body['code'] === 'string' ? body['code'] : '',
					origin,
					browserName: typeof body['browserName'] === 'string' ? body['browserName'] : undefined,
					installationId: typeof body['installationId'] === 'string' ? body['installationId'] : undefined,
					requestedWorkspaceIds: Array.isArray(body['workspaceIds']) ? body['workspaceIds'].filter((entry): entry is string => typeof entry === 'string') : []
				});
				return json(response, 202, result, origin);
			}
			if (request.method === 'POST' && pathname === '/v1/pair/status') {
				const body = await readJson(request);
				const result = this.grants.pairStatus(typeof body['requestId'] === 'string' ? body['requestId'] : '', typeof body['tempSecret'] === 'string' ? body['tempSecret'] : '');
				return json(response, 200, result, origin);
			}
			if (request.method === 'POST' && pathname === '/v1/sessions') {
				const client = this.authenticateClient(request, origin);
				const body = await readJson(request);
				const result = this.grants.createSession(client, origin, {
					provider: provider(body['provider']),
					tabId: typeof body['tabId'] === 'number' ? body['tabId'] : -1,
					documentGeneration: typeof body['documentGeneration'] === 'string' ? body['documentGeneration'].slice(0, 200) : '',
					conversationId: typeof body['conversationId'] === 'string' ? body['conversationId'].slice(0, 500) : '',
					workspaceId: typeof body['workspaceId'] === 'string' ? body['workspaceId'] : '',
					autoSend: body['autoSend'] === true
				});
				return json(response, 201, { sessionId: result.session.id, sessionToken: result.token, expiresAt: result.session.expiresAt }, origin);
			}
			if (request.method === 'POST' && pathname === '/v1/requests') {
				const session = this.authenticateSession(request, origin);
				const caller = this.grants.callerForSession(session.id);
				this.rateLimit(caller.clientId);
				const body = await readJson(request);
				const requestedTool = typeof body['tool'] === 'string' ? body['tool'].slice(0, 160) : '';
				const requestedArgs = isRecord(body['arguments']) ? body['arguments'] : {};
				const messageId = typeof body['messageId'] === 'string' ? body['messageId'].slice(0, 300) : '';
				const callId = typeof body['callId'] === 'string' ? body['callId'].slice(0, 200) : '';
				if (!requestedTool || !messageId || !callId) throw new Error('La solicitud necesita tool, messageId y callId.');
				const resolved = await resolveWebAiToolAlias({ bridge: this.bridge, session, tool: requestedTool, args: requestedArgs });
				const decision = await classifyWebAiCall({ bridge: this.bridge, caller, name: resolved.tool, args: resolved.args });
				const idempotencyKey = `${caller.clientId}:${session.id}:${session.documentGeneration}:${messageId}:${callId}`;
				const record = await this.requests.register({ clientId: caller.clientId, sessionId: session.id, idempotencyKey, tool: resolved.tool, arguments: resolved.args, authorizationRevision: caller.authorizationRevision, requiresApproval: decision.requiresApproval });
				if (record.state === 'queued') this.scheduleDrain();
				return json(response, 202, publicRequest(record), origin);
			}
			const requestMatch = /^\/v1\/requests\/([^/]+)$/.exec(pathname);
			if (request.method === 'GET' && requestMatch) {
				const session = this.authenticateSession(request, origin);
				const caller = this.grants.callerForSession(session.id);
				const record = this.requests.getOwned(decodeURIComponent(requestMatch[1]!), caller.clientId, session.id);
				return json(response, 200, publicRequest(record), origin);
			}
			const cancelMatch = /^\/v1\/requests\/([^/]+)\/cancel$/.exec(pathname);
			if (request.method === 'POST' && cancelMatch) {
				const session = this.authenticateSession(request, origin);
				const caller = this.grants.callerForSession(session.id);
				const record = this.requests.getOwned(decodeURIComponent(cancelMatch[1]!), caller.clientId, session.id);
				const cancelled = await this.requests.cancel(record.id);
				return json(response, 200, { ...publicRequest(cancelled.request), interrupted: cancelled.interrupted, note: cancelled.interrupted ? 'Cancelada antes de ejecución.' : 'La operación ya había iniciado; no se afirma cancelación del efecto.' }, origin);
			}
			const closeMatch = /^\/v1\/sessions\/([^/]+)\/close$/.exec(pathname);
			if (request.method === 'POST' && closeMatch) {
				const session = this.authenticateSession(request, origin);
				const id = decodeURIComponent(closeMatch[1]!);
				if (session.id !== id) throw new Error('La sesión no coincide con el token presentado.');
				this.grants.closeSession(id);
				return json(response, 200, { closed: true }, origin);
			}
			return json(response, 404, { error: 'Ruta local no encontrada.' }, origin);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn('IA web local request rejected', { path: request.url, error: message });
			if (!response.headersSent) json(response, 400, { error: message }, origin);
		}
	}

	private scheduleDrain(): void {
		queueMicrotask(() => void this.drain());
	}

	private async drain(): Promise<void> {
		if (!this.accepting) return;
		while (this.runningGlobal < WEB_AI_MAX_RUNNING_GLOBAL) {
			const next = this.requests.queued().find((request) => !this.runningSessions.has(request.sessionId));
			if (!next) break;
			this.runningGlobal += 1;
			this.runningSessions.add(next.sessionId);
			void this.execute(next).finally(() => {
				this.runningGlobal -= 1;
				this.runningSessions.delete(next.sessionId);
				this.scheduleDrain();
			});
		}
	}

	private async execute(request: WebAiRequestRecord): Promise<void> {
		try {
			const caller = this.grants.callerForSession(request.sessionId);
			if (request.requiresApproval && request.approvedRevision !== caller.authorizationRevision) {
				await this.requests.fail(request.id, new Error('Los permisos cambiaron después de la aprobación; revisa la operación de nuevo.'));
				return;
			}
			await this.requests.markRunning(request.id);
			const execution = dispatchAuthorizedMasterTool({ bridge: this.bridge, caller, name: request.tool, args: request.arguments, includeSessions: false });
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					execution,
					new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('WEB_AI_EXECUTION_TIMEOUT')), WEB_AI_EXECUTION_TIMEOUT_MS); timer.unref?.(); })
				]);
				if (this.requests.get(request.id)?.state === 'running') await this.requests.succeed(request.id, result);
			} catch (error) {
				if (this.requests.get(request.id)?.state !== 'running') return;
				const uncertain = error instanceof Error && error.message === 'WEB_AI_EXECUTION_TIMEOUT';
				const message = uncertain
					? 'Tiempo de ejecución agotado; el efecto puede haberse aplicado. Verifica antes de repetir.'
					: error instanceof Error ? error.message : String(error);
				this.logger.warn('IA web local tool execution failed', { requestId: request.id, tool: request.tool, error: message, uncertain });
				await this.requests.fail(request.id, new Error(message), uncertain);
			} finally {
				if (timer) clearTimeout(timer);
			}
		} catch (error) {
			const current = this.requests.get(request.id);
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn('IA web local request execution setup failed', { requestId: request.id, tool: request.tool, error: message });
			if (current && (current.state === 'pending-approval' || current.state === 'queued' || current.state === 'running')) await this.requests.fail(request.id, error).catch(() => undefined);
		}
	}
}
