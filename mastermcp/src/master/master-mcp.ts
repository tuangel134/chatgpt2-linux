/**
 * Master MCP: an optional, loopback-only MCP server for external clients.
 *
 * This is deliberately separate from core/mcp, which is Forja acting as an MCP
 * client. Here Forja is the server. The daemon remains the only component that
 * can reach workspaces and the agent runtime.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '../core/platform/logger.ts';
import { dispatchAuthorizedMasterTool } from './master-mcp-dispatcher.ts';

const MAX_BODY_BYTES = 1_000_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const AUTH_CODE_TTL_MS = 5 * 60_000;
const AUTH_REQUEST_TTL_MS = 10 * 60_000;
// A provider can retry a refresh after a network timeout, or send two refreshes
// concurrently from separate browser processes. Retaining the old credential for
// a short replay window prevents a healthy connector from being forced through
// OAuth again simply because it did not receive the first response.
const REFRESH_REPLAY_GRACE_MS = 10 * 60_000;
const MCP_VERSION = '2025-06-18';
const MCP_PROTOCOL_HEADER = 'mcp-protocol-version';

export type MasterMcpMode = 'off' | 'local' | 'public';
export type MasterMcpScope = 'forja:read' | 'forja:agent' | 'forja:browser' | 'forja:outside-workspace' | 'forja:terminal-network' | 'forja:protected-files' | 'forja:host-terminal' | 'forja:system-write' | 'forja:ssh' | 'forja:docker' | 'forja:mounts' | 'forja:devices' | 'forja:sudo';

/** Operations that an approved connector may request from ChatGPT 2's separate Brave/CDP browser. */
export type MasterMcpBrowserAction = 'list' | 'open' | 'summary' | 'execute' | 'screenshot' | 'share' | 'unshare';

export interface MasterMcpBrowserRequest {
	readonly action: MasterMcpBrowserAction;
	readonly pageId?: string;
	readonly url?: string;
	/** A function definition accepted by the native Playwright browser service. */
	readonly code?: string;
	readonly args?: readonly unknown[];
	readonly timeoutMs?: number;
	readonly fullPage?: boolean;
}

export interface MasterMcpWorkspace {
	readonly id: string;
	readonly name: string;
}

export interface MasterMcpBridge {
	listWorkspaces(): Promise<readonly MasterMcpWorkspace[]>;
	/** Built-in workspace tools exposed directly to an approved MCP connector. */
	listWorkspaceTools(input: { workspaceId: string }): Promise<readonly { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean }[]>;
	callWorkspaceTool(input: { workspaceId: string; name: string; args: Record<string, unknown>; scopes: readonly MasterMcpScope[] }): Promise<unknown>;
	/** Route browser control to the independent Brave/CDP browser managed by ChatGPT 2. */
	browserRequest(input: { workspaceId: string; request: MasterMcpBrowserRequest }): Promise<unknown>;
	startSession(input: { workspaceId: string; title?: string; mode?: 'ask' | 'plan' | 'agent' }): Promise<unknown>;
	sendTask(input: { workspaceId: string; sessionId: string; text: string; mode?: 'ask' | 'plan' | 'agent' }): Promise<unknown>;
	sessionStatus(input: { workspaceId: string; sessionId: string }): Promise<unknown>;
	readTranscript(input: { workspaceId: string; sessionId: string; limit: number }): Promise<unknown>;
	getChanges(input: { workspaceId: string; sessionId: string }): Promise<unknown>;
	cancelTurn(input: { workspaceId: string; sessionId: string }): Promise<unknown>;
}

export interface MasterMcpStatus {
	readonly mode: MasterMcpMode;
	readonly running: boolean;
	readonly localUrl?: string;
	readonly publicUrl?: string;
	readonly clients: number;
	readonly grants: number;
	readonly pendingAuthorizations: number;
}

export interface MasterMcpStartInput {
	readonly port?: number;
	readonly publicUrl?: string;
}

export interface MasterMcpPersistence {
	load(): Promise<string | undefined>;
	save(value: string): Promise<void>;
}

export interface MasterMcpServiceOptions {
	readonly bridge: MasterMcpBridge;
	readonly logger: Logger;
	readonly persistence?: MasterMcpPersistence;
	/** Lite deliberately does not ship a local AI/session runtime. */
	readonly includeSessions?: boolean;
}

interface ClientRegistration {
	readonly id: string;
	readonly name: string;
	readonly redirectUris: readonly string[];
	readonly createdAt: number;
}

interface AuthorizationRequest {
	readonly id: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly state: string;
	readonly codeChallenge: string;
	readonly scopes: readonly MasterMcpScope[];
	readonly offlineAccess: boolean;
	readonly createdAt: number;
	resolve: (value: AuthorizationGrant) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface AuthorizationGrant {
	readonly clientId: string;
	readonly workspaceIds: readonly string[];
	readonly scopes: readonly MasterMcpScope[];
	readonly offlineAccess: boolean;
}

interface AuthorizationCode extends AuthorizationGrant {
	readonly value: string;
	readonly redirectUri: string;
	readonly codeChallenge: string;
	readonly expiresAt: number;
}

interface AccessToken extends AuthorizationGrant {
	readonly value: string;
	readonly expiresAt: number;
}

interface RefreshToken extends AuthorizationGrant {
	readonly value: string;
	readonly expiresAt: number;
	/** Rotated refresh credentials stay replayable briefly for retry safety. */
	readonly replacedBy?: string;
	readonly replayUntil?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function randomValue(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function parseScopes(raw: unknown): MasterMcpScope[] {
	const values = typeof raw === 'string' ? raw.split(/\s+/) : [];
	const valid = values.filter((value): value is MasterMcpScope => ['forja:read','forja:agent','forja:browser','forja:outside-workspace','forja:terminal-network','forja:protected-files','forja:host-terminal','forja:system-write','forja:ssh','forja:docker','forja:mounts','forja:devices','forja:sudo'].includes(value));
	return [...new Set<MasterMcpScope>(valid.length > 0 ? valid : ['forja:read'])];
}

function callbackAllowed(uri: string): boolean {
	try {
		const parsed = new URL(uri);
		if (parsed.username || parsed.password || !parsed.hostname) return false;
		if (parsed.protocol === 'https:') return true;
		return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]');
	} catch {
		return false;
	}
}

function recoverableClientId(value: string): boolean {
	// Dynamic OAuth clients are public: their identifiers are not credentials.
	// Restrict recovery to IDs that this gateway issues so a stale local record can
	// be reconstructed without turning arbitrary unknown client IDs into grants.
	return /^forja_[A-Za-z0-9_-]{16,128}$/.test(value);
}

function recoveredClientName(redirectUri: string): string {
	const host = new URL(redirectUri).hostname.toLowerCase();
	if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) return 'ChatGPT';
	if (host === 'perplexity.ai' || host.endsWith('.perplexity.ai')) return 'Perplexity';
	return `Recovered MCP client (${host})`;
}

function limitText(value: unknown, limit = 60_000): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > limit ? `${text.slice(0, limit)}\n… truncated by Master MCP.` : text;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > MAX_BODY_BYTES) throw new Error('Request body exceeds the Master MCP limit.');
		chunks.push(bytes);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	if ((request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
		return Object.fromEntries(new URLSearchParams(text));
	}
	const parsed = asRecord(JSON.parse(text));
	if (!parsed) throw new Error('Expected a JSON object.');
	return parsed;
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	response.end(JSON.stringify(body));
}

function mcpJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		[MCP_PROTOCOL_HEADER]: MCP_VERSION
	});
	response.end(JSON.stringify(body));
}

/**
 * A Streamable HTTP server without server-sent events must reject GET at the
 * MCP endpoint with 405. Returning an empty response is intentional: clients
 * use the Allow header to select POST, and no JSON body can be mistaken for an
 * MCP response.
 */
function methodNotAllowed(response: ServerResponse, allow: string): void {
	response.writeHead(405, { allow, 'cache-control': 'no-store' });
	response.end();
}

/** Notifications never receive a JSON-RPC response body over Streamable HTTP. */
function mcpAccepted(response: ServerResponse): void {
	response.writeHead(202, { 'cache-control': 'no-store', [MCP_PROTOCOL_HEADER]: MCP_VERSION });
	response.end();
}

function oauthChallenge(response: ServerResponse, origin: string, error?: 'invalid_token' | 'insufficient_scope'): void {
	const metadata = `${origin}/.well-known/oauth-protected-resource`;
	response.setHeader('www-authenticate', `Bearer resource_metadata="${metadata}", scope="forja:read"${error ? `, error="${error}"` : ''}`);
}

function redirect(response: ServerResponse, target: string): void {
	response.writeHead(302, { location: target, 'cache-control': 'no-store' });
	response.end();
}

export class MasterMcpService {
	private readonly bridge: MasterMcpBridge;
	private readonly logger: Logger;
	private readonly includeSessions: boolean;
	private server: Server | undefined;
	private port: number | undefined;
	private publicUrl: string | undefined;
	private readonly clients = new Map<string, ClientRegistration>();
	private readonly pending = new Map<string, AuthorizationRequest>();
	private readonly codes = new Map<string, AuthorizationCode>();
	private readonly tokens = new Map<string, AccessToken>();
	private readonly refreshTokens = new Map<string, RefreshToken>();
	private readonly persistence: MasterMcpPersistence | undefined;
	private hydrated = false;
	private hydratePromise: Promise<void> | undefined;
	private persistQueue: Promise<void> = Promise.resolve();

	constructor(options: MasterMcpServiceOptions) {
		this.bridge = options.bridge;
		this.logger = options.logger.child('master-mcp');
		this.persistence = options.persistence;
		this.includeSessions = options.includeSessions === true;
	}

	status(): MasterMcpStatus {
		const activeClientIds = new Set(this.activeGrants().map((grant) => grant.clientId));
		return {
			mode: this.server ? (this.publicUrl ? 'public' : 'local') : 'off',
			running: this.server !== undefined,
			...(this.port ? { localUrl: `http://127.0.0.1:${this.port}` } : {}),
			...(this.publicUrl ? { publicUrl: this.publicUrl } : {}),
			clients: this.clients.size,
			grants: activeClientIds.size,
			pendingAuthorizations: this.pending.size
		};
	}

	async start(input: MasterMcpStartInput = {}): Promise<MasterMcpStatus> {
		if (this.server) return this.status();
		await this.initialize();
		const requestedPort = Number.isInteger(input.port) && input.port! >= 0 && input.port! <= 65535 ? input.port! : 0;
		if (input.publicUrl && !/^https:\/\//i.test(input.publicUrl)) throw new Error('Master MCP publicUrl must use HTTPS.');
		const server = createServer((request, response) => void this.handle(request, response));
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => reject(error);
				server.once('error', onError);
				server.listen(requestedPort, '127.0.0.1', () => {
					server.removeListener('error', onError);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Master MCP did not receive a TCP address.');
			this.server = server;
			this.port = address.port;
			this.publicUrl = input.publicUrl?.replace(/\/$/, '');
		} catch (error) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			throw error;
		}
		this.logger.info('Master MCP listening on loopback', { port: this.port, public: Boolean(this.publicUrl) });
		return this.status();
	}

	setPublicUrl(publicUrl: string | undefined): MasterMcpStatus {
		if (!this.server) throw new Error('Master MCP must be running before a public URL can be configured.');
		if (publicUrl && !/^https:\/\//i.test(publicUrl)) throw new Error('Master MCP publicUrl must use HTTPS.');
		this.publicUrl = publicUrl?.replace(/\/$/, '');
		return this.status();
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.port = undefined;
		this.publicUrl = undefined;
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error('Master MCP stopped before authorization completed.'));
		}
		this.pending.clear();
		this.codes.clear();
		// Connector credentials survive a stopped gateway and a daemon restart. Do not
		// persist an unhydrated service: a daemon can shut down before Master MCP was
		// started, and writing the still-empty maps here would erase the saved OAuth
		// clients and refresh tokens.
		let persistenceError: unknown;
		if (this.hydrated) {
			try {
				await this.persist();
			} catch (error) {
				persistenceError = error;
			}
		}
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (persistenceError) throw persistenceError;
	}

	pendingAuthorizations(): Array<{ id: string; clientId: string; clientName: string; scopes: readonly MasterMcpScope[]; createdAt: number }> {
		return [...this.pending.values()].map((request) => ({
			id: request.id, clientId: request.clientId, clientName: this.clients.get(request.clientId)?.name ?? request.clientId,
			scopes: request.scopes, createdAt: request.createdAt
		}));
	}

	/** Renderer-safe summary of live connector access. Token values never leave this service. */
	authorizations(): Array<{ clientId: string; clientName: string; scopes: readonly MasterMcpScope[]; workspaceIds: readonly string[]; expiresAt: number }> {
		const byClient = new Map<string, { clientId: string; clientName: string; scopes: readonly MasterMcpScope[]; workspaceIds: readonly string[]; expiresAt: number }>();
		for (const token of this.activeGrants()) {
			const current = byClient.get(token.clientId);
			if (!current || current.expiresAt < token.expiresAt) {
				byClient.set(token.clientId, {
					clientId: token.clientId,
					clientName: this.clients.get(token.clientId)?.name ?? token.clientId,
					scopes: token.scopes,
					workspaceIds: token.workspaceIds,
					expiresAt: token.expiresAt
				});
			}
		}
		return [...byClient.values()].sort((left, right) => left.clientName.localeCompare(right.clientName));
	}

	/** Revocation is immediate for access and refresh tokens. A client must complete OAuth again to return. */
	async revokeAuthorization(clientId: string): Promise<boolean> {
		let revoked = false;
		for (const [value, token] of this.tokens) {
			if (token.clientId === clientId) { this.tokens.delete(value); revoked = true; }
		}
		for (const [value, token] of this.refreshTokens) {
			if (token.clientId === clientId) { this.refreshTokens.delete(value); revoked = true; }
		}
		if (revoked) await this.persist();
		return revoked;
	}

	/** Changes a live connector's permissions without forcing a new OAuth login. */
	async updateAuthorization(clientId: string, scopes: readonly MasterMcpScope[], workspaceIds?: readonly string[]): Promise<boolean> {
		let updated = false;
		for (const [value, token] of this.tokens) {
			if (token.clientId === clientId) {
				this.tokens.set(value, { ...token, scopes: [...new Set(scopes)],
					...(workspaceIds ? { workspaceIds: [...new Set(workspaceIds)] } : {}) });
				updated = true;
			}
		}
		for (const [value, token] of this.refreshTokens) {
			if (token.clientId === clientId) {
				this.refreshTokens.set(value, { ...token, scopes: [...new Set(scopes)],
					...(workspaceIds ? { workspaceIds: [...new Set(workspaceIds)] } : {}) });
				updated = true;
			}
		}
		if (updated) await this.persist();
		return updated;
	}

	/** Restores saved OAuth clients and grants before any renderer reads their state. */
	initialize(): Promise<void> {
		this.hydratePromise ??= this.hydrate();
		return this.hydratePromise;
	}

	private activeGrants(): Array<AccessToken | RefreshToken> {
		const now = Date.now();
		return [...this.refreshTokens.values(), ...this.tokens.values()].filter((grant) => grant.expiresAt >= now);
	}

	private async hydrate(): Promise<void> {
		if (!this.persistence) {
			this.hydrated = true;
			return;
		}
		try {
			const raw = await this.persistence.load();
			if (!raw) return;
			const state = asRecord(JSON.parse(raw));
			for (const value of Array.isArray(state?.['clients']) ? state['clients'] : []) {
				const client = asRecord(value);
				if (!client || typeof client['id'] !== 'string' || typeof client['name'] !== 'string' || !Array.isArray(client['redirectUris'])) continue;
				this.clients.set(client['id'], { id: client['id'], name: client['name'], redirectUris: client['redirectUris'].filter((uri): uri is string => typeof uri === 'string' && callbackAllowed(uri)), createdAt: typeof client['createdAt'] === 'number' ? client['createdAt'] : Date.now() });
			}
			for (const value of Array.isArray(state?.['refreshTokens']) ? state['refreshTokens'] : []) {
				const token = asRecord(value);
				if (!token || typeof token['value'] !== 'string' || typeof token['clientId'] !== 'string' || typeof token['expiresAt'] !== 'number' || token['expiresAt'] < Date.now() || (typeof token['replayUntil'] === 'number' && token['replayUntil'] < Date.now()) || !Array.isArray(token['workspaceIds']) || !Array.isArray(token['scopes'])) continue;
				this.refreshTokens.set(token['value'], {
					value: token['value'], clientId: token['clientId'], workspaceIds: token['workspaceIds'].filter((id): id is string => typeof id === 'string'),
					scopes: token['scopes'].filter((scope): scope is MasterMcpScope => typeof scope === 'string' && parseScopes(scope).some((valid) => valid === scope)),
					offlineAccess: true, expiresAt: token['expiresAt'],
					...(typeof token['replacedBy'] === 'string' ? { replacedBy: token['replacedBy'] } : {}),
					...(typeof token['replayUntil'] === 'number' ? { replayUntil: token['replayUntil'] } : {})
				});
			}
			for (const value of Array.isArray(state?.['accessTokens']) ? state['accessTokens'] : []) {
				const token = asRecord(value);
				if (!token || typeof token['value'] !== 'string' || typeof token['clientId'] !== 'string' || typeof token['expiresAt'] !== 'number' || token['expiresAt'] < Date.now() || !Array.isArray(token['workspaceIds']) || !Array.isArray(token['scopes'])) continue;
				this.tokens.set(token['value'], { value: token['value'], clientId: token['clientId'], workspaceIds: token['workspaceIds'].filter((id): id is string => typeof id === 'string'), scopes: token['scopes'].filter((scope): scope is MasterMcpScope => typeof scope === 'string' && parseScopes(scope).some((valid) => valid === scope)), offlineAccess: token['offlineAccess'] === true, expiresAt: token['expiresAt'] });
			}
		} catch (error) {
			this.logger.warn('Could not restore Master MCP connector credentials', { error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.hydrated = true;
		}
	}

	private persist(): Promise<void> {
		if (!this.persistence) return Promise.resolve();
		const now = Date.now();
		const snapshot = JSON.stringify({
			version: 1,
			clients: [...this.clients.values()],
			accessTokens: [...this.tokens.values()].filter((token) => token.expiresAt >= now),
			refreshTokens: [...this.refreshTokens.values()].filter((token) => token.expiresAt >= now && (token.replayUntil === undefined || token.replayUntil >= now))
		});
		const save = async (): Promise<void> => {
			try {
				await this.persistence!.save(snapshot);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.warn('Could not persist Master MCP connector credentials', { error: message });
				throw new Error(`Could not persist Master MCP connector credentials: ${message}`);
			}
		};
		this.persistQueue = this.persistQueue.then(save, save);
		return this.persistQueue;
	}

	approveAuthorization(id: string, input: { workspaceIds: readonly string[]; scopes?: readonly MasterMcpScope[] }): void {
		const request = this.pending.get(id);
		if (!request) throw new Error('Master MCP authorization request was not found or expired.');
		this.pending.delete(id);
		clearTimeout(request.timer);
		request.resolve({ clientId: request.clientId, workspaceIds: [...new Set(input.workspaceIds)], scopes: input.scopes?.length ? [...input.scopes] : request.scopes, offlineAccess: request.offlineAccess });
	}

	denyAuthorization(id: string): void {
		const request = this.pending.get(id);
		if (!request) return;
		this.pending.delete(id);
		clearTimeout(request.timer);
		request.reject(new Error('The local ChatGPT 2 user denied this connector.'));
	}

	private baseUrl(request?: IncomingMessage): string {
		if (this.publicUrl) return this.publicUrl;
		const host = request?.headers.host ?? `127.0.0.1:${this.port ?? 0}`;
		return `http://${host}`;
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const url = new URL(request.url ?? '/', this.baseUrl(request));
			if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { service: 'forja-master-mcp', status: 'ok', protocol: MCP_VERSION, loopback: true });
			const advertisedBase = this.baseUrl(request);
			if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json(response, 200, this.authorizationMetadata(advertisedBase));
			if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) return json(response, 200, { resource: `${advertisedBase}/mcp`, authorization_servers: [advertisedBase], scopes_supported: ['forja:read', 'forja:agent', 'forja:browser', 'forja:outside-workspace', 'forja:terminal-network', 'forja:protected-files', 'forja:host-terminal', 'forja:system-write', 'forja:ssh', 'forja:docker', 'forja:mounts', 'forja:devices', 'forja:sudo', 'offline_access'] });
			if (request.method === 'POST' && url.pathname === '/oauth/register') return void this.registerClient(request, response);
			if (request.method === 'GET' && url.pathname === '/oauth/authorize') return void await this.authorize(url, response);
			if (request.method === 'POST' && url.pathname === '/oauth/token') return void await this.exchangeToken(request, response);
			if (request.method === 'GET' && url.pathname === '/mcp') return methodNotAllowed(response, 'POST');
			if (request.method === 'DELETE' && url.pathname === '/mcp') return methodNotAllowed(response, 'POST');
			if (request.method === 'POST' && url.pathname === '/mcp') return void await this.handleMcp(request, response);
			return json(response, 404, { error: 'Not found.' });
		} catch (error) {
			this.logger.warn('Master MCP request failed', { error: error instanceof Error ? error.message : String(error) });
			if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : 'Invalid request.' });
		}
	}

	private authorizationMetadata(baseUrl: string): Record<string, unknown> {
		return { issuer: baseUrl, authorization_endpoint: `${baseUrl}/oauth/authorize`, token_endpoint: `${baseUrl}/oauth/token`, registration_endpoint: `${baseUrl}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['forja:read', 'forja:agent', 'forja:browser', 'forja:outside-workspace', 'forja:terminal-network', 'forja:protected-files', 'forja:host-terminal', 'forja:system-write', 'forja:ssh', 'forja:docker', 'forja:mounts', 'forja:devices', 'forja:sudo', 'offline_access'] };
	}

	private async registerClient(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const input = await readJson(request);
		if (input['token_endpoint_auth_method'] !== undefined && input['token_endpoint_auth_method'] !== 'none') {
			return json(response, 400, { error: 'invalid_client_metadata', error_description: 'Only public OAuth clients with token_endpoint_auth_method=none are supported.' });
		}
		const redirects = Array.isArray(input['redirect_uris']) ? input['redirect_uris'].filter((value): value is string => typeof value === 'string' && callbackAllowed(value)) : [];
		if (redirects.length === 0) return json(response, 400, { error: 'invalid_redirect_uri', error_description: 'A permitted HTTPS redirect URI is required.' });
		const id = `forja_${randomValue(18)}`;
		this.clients.set(id, { id, name: typeof input['client_name'] === 'string' ? input['client_name'].slice(0, 120) : 'MCP connector', redirectUris: redirects, createdAt: Date.now() });
		await this.persist();
		json(response, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: 'none', redirect_uris: redirects });
	}

	private async authorize(url: URL, response: ServerResponse): Promise<void> {
		const responseType = url.searchParams.get('response_type') ?? '';
		const clientId = url.searchParams.get('client_id') ?? '';
		const redirectUri = url.searchParams.get('redirect_uri') ?? '';
		const state = url.searchParams.get('state') ?? '';
		const challenge = url.searchParams.get('code_challenge') ?? '';
		const method = url.searchParams.get('code_challenge_method') ?? '';
		if (responseType !== 'code') return json(response, 400, { error: 'unsupported_response_type', error_description: 'Only response_type=code is supported.' });
		if (!state) return json(response, 400, { error: 'invalid_request', error_description: 'The OAuth state parameter is required.' });
		if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || method !== 'S256') return json(response, 400, { error: 'invalid_request', error_description: 'A PKCE S256 code_challenge and code_challenge_method=S256 are required.' });
		let client = this.clients.get(clientId);
		if (!client && recoverableClientId(clientId) && callbackAllowed(redirectUri)) {
			// A public client can outlive a keyring migration, reinstall, or a prior
			// gateway bug. Recover its registration, but still require local approval
			// before issuing any new code or tokens.
			client = { id: clientId, name: recoveredClientName(redirectUri), redirectUris: [redirectUri], createdAt: Date.now() };
			this.clients.set(clientId, client);
			await this.persist();
		}
		if (!client) return json(response, 400, { error: 'invalid_client', error_description: 'This public client is not registered. Add the connector again or complete local approval.' });
		if (!client.redirectUris.includes(redirectUri)) return json(response, 400, { error: 'invalid_redirect_uri', error_description: 'The redirect URI is not registered for this connector.' });
		const requestedScope = url.searchParams.get('scope') ?? '';
		const restored = this.restoredGrant(clientId);
		let grant: AuthorizationGrant;
		try {
			grant = restored
				? { ...restored, offlineAccess: true }
				: await this.requestAuthorization(clientId, redirectUri, state, challenge, requestedScope);
		} catch {
			const target = new URL(redirectUri);
			target.searchParams.set('error', 'access_denied');
			target.searchParams.set('error_description', 'The connector was not approved in ChatGPT 2.');
			target.searchParams.set('state', state);
			redirect(response, target.toString());
			return;
		}
		const code = randomValue();
		this.codes.set(code, { ...grant, value: code, redirectUri, codeChallenge: challenge, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
		const target = new URL(redirectUri);
		target.searchParams.set('code', code);
		target.searchParams.set('state', state);
		redirect(response, target.toString());
	}

	/** A connector the user already approved can reconnect without another modal. */
	private restoredGrant(clientId: string): AuthorizationGrant | undefined {
		const saved = [...this.refreshTokens.values(), ...this.tokens.values()]
			.find((grant) => grant.clientId === clientId && grant.expiresAt >= Date.now());
		return saved ? { clientId: saved.clientId, workspaceIds: saved.workspaceIds, scopes: saved.scopes, offlineAccess: saved.offlineAccess } : undefined;
	}

	private async requestAuthorization(clientId: string, redirectUri: string, state: string, challenge: string, requestedScope: string): Promise<AuthorizationGrant> {
		const requestId = randomUUID();
		return new Promise<AuthorizationGrant>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.delete(requestId)) reject(new Error('The local approval expired.'));
			}, AUTH_REQUEST_TTL_MS);
			timer.unref?.();
			const pending: AuthorizationRequest = { id: requestId, clientId, redirectUri, state, codeChallenge: challenge, scopes: parseScopes(requestedScope), offlineAccess: requestedScope.split(/\s+/).includes('offline_access'), createdAt: Date.now(), resolve, reject, timer };
			this.pending.set(requestId, pending);
		});
	}

	private async exchangeToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const input = await readJson(request);
		if (input['grant_type'] === 'refresh_token') return void await this.refreshToken(input, response);
		if (input['grant_type'] !== 'authorization_code') return json(response, 400, { error: 'unsupported_grant_type' });
		const codeValue = typeof input['code'] === 'string' ? input['code'] : '';
		const verifier = typeof input['code_verifier'] === 'string' ? input['code_verifier'] : '';
		const redirectUri = typeof input['redirect_uri'] === 'string' ? input['redirect_uri'] : '';
		const clientId = typeof input['client_id'] === 'string' ? input['client_id'] : '';
		const code = this.codes.get(codeValue);
		this.codes.delete(codeValue);
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		if (!code || code.expiresAt < Date.now() || code.clientId !== clientId || code.redirectUri !== redirectUri || !safeEqual(code.codeChallenge, challenge)) return json(response, 400, { error: 'invalid_grant' });
		const token = randomValue();
		this.tokens.set(token, { ...code, value: token, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
		// ChatGPT currently omits offline_access even though a desktop connector must
		// survive a normal gateway restart. Keep a rotating refresh credential after
		// the user explicitly approves the connector.
		const refreshToken = randomValue();
		this.refreshTokens.set(refreshToken, { ...code, offlineAccess: true, value: refreshToken, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 });
		await this.persist();
		json(response, 200, { access_token: token, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: [...code.scopes, 'offline_access'].join(' '), refresh_token: refreshToken });
	}

	private async refreshToken(input: Record<string, unknown>, response: ServerResponse): Promise<void> {
		const value = typeof input['refresh_token'] === 'string' ? input['refresh_token'] : '';
		const clientId = typeof input['client_id'] === 'string' ? input['client_id'] : '';
		const refresh = this.refreshTokens.get(value);
		const now = Date.now();
		if (!refresh || refresh.expiresAt < now || refresh.clientId !== clientId) return json(response, 400, { error: 'invalid_grant' });
		if (refresh.replacedBy) {
			if (!refresh.replayUntil || refresh.replayUntil < now) {
				this.refreshTokens.delete(value);
				await this.persist();
				return json(response, 400, { error: 'invalid_grant' });
			}
			const rotated = this.refreshTokens.get(refresh.replacedBy);
			if (!rotated || rotated.expiresAt < now) return json(response, 400, { error: 'invalid_grant' });
			const accessToken = randomValue();
			this.tokens.set(accessToken, { ...rotated, value: accessToken, expiresAt: now + ACCESS_TOKEN_TTL_MS });
			await this.persist();
			return json(response, 200, { access_token: accessToken, refresh_token: rotated.value, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: [...rotated.scopes, 'offline_access'].join(' ') });
		}
		const accessToken = randomValue();
		const rotatedRefreshToken = randomValue();
		this.tokens.set(accessToken, { ...refresh, value: accessToken, expiresAt: now + ACCESS_TOKEN_TTL_MS });
		this.refreshTokens.set(value, { ...refresh, replacedBy: rotatedRefreshToken, replayUntil: now + REFRESH_REPLAY_GRACE_MS });
		this.refreshTokens.set(rotatedRefreshToken, { ...refresh, value: rotatedRefreshToken, expiresAt: now + 30 * 24 * 60 * 60_000 });
		await this.persist();
		json(response, 200, { access_token: accessToken, refresh_token: rotatedRefreshToken, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), scope: [...refresh.scopes, 'offline_access'].join(' ') });
	}

	private tokenFor(request: IncomingMessage): AccessToken | undefined {
		const header = request.headers.authorization ?? '';
		const match = /^Bearer\s+(.+)$/i.exec(header);
		const token = match?.[1] ? this.tokens.get(match[1]) : undefined;
		if (!token || token.expiresAt < Date.now()) return undefined;
		return token;
	}

	private async handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const token = this.tokenFor(request);
		if (!token) { oauthChallenge(response, this.baseUrl(request), 'invalid_token'); return json(response, 401, { error: 'invalid_token' }); }
		const protocolVersion = request.headers[MCP_PROTOCOL_HEADER];
		if (protocolVersion && protocolVersion !== MCP_VERSION) {
			return json(response, 400, { error: 'Unsupported MCP protocol version.', supportedProtocolVersions: [MCP_VERSION] });
		}
		const message = await readJson(request);
		const id = message['id'];
		const method = typeof message['method'] === 'string' ? message['method'] : '';
		const params = asRecord(message['params']) ?? {};
		let result: unknown;
		try {
			if (method === 'initialize') result = { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'ChatGPT 2 Master MCP', version: '1.1.0' } };
			// A few connector clients probe this legacy discovery method before the
			// standard tools/list request. It is not part of the current MCP spec, but
			// answering it with the same capability document is harmless and avoids a
			// needless compatibility error during connector setup.
			else if (method === 'server/discover') result = { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'ChatGPT 2 Master MCP', version: '1.1.0' }, tools: this.tools() };
			else if (method === 'tools/list') result = { tools: this.tools() };
			else if (method === 'ping') result = {};
			else if (method === 'tools/call') result = await this.callTool(token, params);
			else if (method === 'notifications/initialized') return mcpAccepted(response);
			else throw new Error(`Unsupported MCP method: ${method}`);
			mcpJson(response, 200, { jsonrpc: '2.0', id, result });
		} catch (error) {
			this.logger.warn('Master MCP tool call failed', {
				tool: typeof params['name'] === 'string' ? params['name'] : 'unknown',
				error: error instanceof Error ? error.message : String(error)
			});
			mcpJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : 'Master MCP tool failed.' } });
		}
	}

	private tools(): unknown[] {
		const tools = [
				{ name: 'forja_get_capabilities', description: 'Show the permissions currently effective for this connector, including workspace, host terminal, network, SSH, Docker, mounts, USB/ADB and system access. Use this after a permission update.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
			{ name: 'forja_list_workspaces', description: 'List workspace aliases authorized for this connector, together with its effective permission summary.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
			{ name: 'forja_list_workspace_tools', description: 'List the built-in ChatGPT 2 workspace API tools available to this connector. These operate locally; they do not delegate to a separate AI agent.', inputSchema: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } }, annotations: { readOnlyHint: true } },
				{ name: 'forja_call_workspace_tool', description: 'Call a built-in ChatGPT 2 workspace API tool directly. Use for files, search, sandboxed terminal, host terminal, ADB, Git, tests, web retrieval and OCR. Paths and host capabilities follow forja_get_capabilities; Master MCP installation, original Codex, and its configuration are protected.', inputSchema: { type: 'object', required: ['workspaceId', 'tool', 'arguments'], properties: { workspaceId: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } } } },
			{ name: 'forja_browser_list_pages', description: 'List visible independent ChatGPT 2 Brave/CDP tabs. Only tabs shared with the connector can be controlled.', inputSchema: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' } } }, annotations: { readOnlyHint: true } },
			{ name: 'forja_browser_open', description: 'Open a new visible page in ChatGPT 2 Brave browser and share it with this connector.', inputSchema: { type: 'object', required: ['workspaceId', 'url'], properties: { workspaceId: { type: 'string' }, url: { type: 'string', maxLength: 4096 } } } },
			{ name: 'forja_browser_summary', description: 'Read the current accessible page snapshot, title and URL from a shared ChatGPT 2 Brave tab.', inputSchema: { type: 'object', required: ['workspaceId', 'pageId'], properties: { workspaceId: { type: 'string' }, pageId: { type: 'string' } } }, annotations: { readOnlyHint: true } },
			{ name: 'forja_browser_execute', description: 'Interact with a shared browser tab using a Playwright function definition: async (page, ...args) => { ... }. Use DOM locators, click, fill, press, navigation and waits; the result includes a fresh page snapshot.', inputSchema: { type: 'object', required: ['workspaceId', 'pageId', 'code'], properties: { workspaceId: { type: 'string' }, pageId: { type: 'string' }, code: { type: 'string', maxLength: 40000 }, args: { type: 'array', maxItems: 20 }, timeoutMs: { type: 'number', minimum: 1000, maximum: 120000 } } } },
			{ name: 'forja_browser_screenshot', description: 'Capture a PNG screenshot of a shared ChatGPT 2 Brave tab. The result is returned as base64 image data.', inputSchema: { type: 'object', required: ['workspaceId', 'pageId'], properties: { workspaceId: { type: 'string' }, pageId: { type: 'string' }, fullPage: { type: 'boolean' } } }, annotations: { readOnlyHint: true } },
			{ name: 'forja_browser_share_page', description: 'Existing tabs can only be shared manually in ChatGPT 2 Settings; remote sharing requests are denied.', inputSchema: { type: 'object', required: ['workspaceId', 'pageId'], properties: { workspaceId: { type: 'string' }, pageId: { type: 'string' } } } },
			{ name: 'forja_browser_unshare_page', description: 'Stop exposing a ChatGPT 2 Brave tab to this connector. The tab remains open for the user.', inputSchema: { type: 'object', required: ['workspaceId', 'pageId'], properties: { workspaceId: { type: 'string' }, pageId: { type: 'string' } } } },
			{ name: 'forja_start_session', description: 'Start a Forja agent session in an authorized workspace.', inputSchema: { type: 'object', required: ['workspaceId'], properties: { workspaceId: { type: 'string' }, title: { type: 'string' }, mode: { type: 'string', enum: ['ask', 'plan', 'agent'] } } } },
			{ name: 'forja_send_task', description: 'Send a task to an existing Forja session. Agent policy and local approvals remain enforced.', inputSchema: { type: 'object', required: ['workspaceId', 'sessionId', 'text'], properties: { workspaceId: { type: 'string' }, sessionId: { type: 'string' }, text: { type: 'string', maxLength: 20000 }, mode: { type: 'string', enum: ['ask', 'plan', 'agent'] } } } },
			{ name: 'forja_session_status', description: 'Read the status of an authorized session.', inputSchema: { type: 'object', required: ['workspaceId', 'sessionId'], properties: { workspaceId: { type: 'string' }, sessionId: { type: 'string' } } }, annotations: { readOnlyHint: true } },
			{ name: 'forja_read_transcript', description: 'Read a bounded, sanitized session transcript.', inputSchema: { type: 'object', required: ['workspaceId', 'sessionId'], properties: { workspaceId: { type: 'string' }, sessionId: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 } } }, annotations: { readOnlyHint: true } },
			{ name: 'forja_get_changes', description: 'Read a bounded change summary for an authorized session.', inputSchema: { type: 'object', required: ['workspaceId', 'sessionId'], properties: { workspaceId: { type: 'string' }, sessionId: { type: 'string' } } }, annotations: { readOnlyHint: true } },
			{ name: 'forja_cancel_turn', description: 'Cancel a running turn in an authorized session.', inputSchema: { type: 'object', required: ['workspaceId', 'sessionId'], properties: { workspaceId: { type: 'string' }, sessionId: { type: 'string' } } } }
		];
		if (this.includeSessions) return tools;
		return tools.filter((tool) => !['forja_start_session', 'forja_send_task', 'forja_session_status', 'forja_read_transcript', 'forja_get_changes', 'forja_cancel_turn'].includes((tool as { name?: unknown }).name as string));
	}

	private requireWorkspace(token: AccessToken, value: unknown): string {
		if (typeof value !== 'string' || !token.workspaceIds.includes(value)) throw new Error('This connector is not authorized for the requested workspace.');
		return value;
	}

	private requireAgent(token: AccessToken): void {
		if (!token.scopes.includes('forja:agent')) throw new Error('The connector grant does not include forja:agent.');
	}

	private requireScope(token: AccessToken, scope: MasterMcpScope): void {
		if (!token.scopes.includes(scope)) throw new Error(`The connector grant does not include ${scope}.`);
	}

	/** Do not advertise host/device tools that this connector cannot call. */
	private visibleWorkspaceTools(token: AccessToken, tools: readonly { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean }[]): readonly { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean }[] {
		const hostTerminal = token.scopes.includes('forja:host-terminal');
		const devices = token.scopes.includes('forja:devices');
		return tools.filter((tool) => {
			const hostTool = tool.name === 'host_terminal_execute' || tool.name.startsWith('adb_');
			if (!hostTool) return true;
			return hostTerminal && (tool.name === 'host_terminal_execute' || devices);
		});
	}

	private capabilities(token: AccessToken): Record<string, unknown> {
		const scopes = new Set(token.scopes);
		const hostTerminal = scopes.has('forja:host-terminal');
		const windows = process.platform === 'win32';
		return {
			scopes: [...token.scopes],
			workspaces: [...token.workspaceIds],
			effectivePermissions: {
				directWorkspaceApi: scopes.has('forja:agent'),
				outsideWorkspaceFiles: scopes.has('forja:outside-workspace'),
				protectedProjectFiles: scopes.has('forja:protected-files'),
				integratedBrowser: scopes.has('forja:browser'),
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
				tessarionInstallationAndConfiguration: 'always blocked'
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

	private async callTool(token: AccessToken, params: Record<string, unknown>): Promise<unknown> {
		const name = typeof params['name'] === 'string' ? params['name'] : '';
		const args = asRecord(params['arguments']) ?? {};
		return dispatchAuthorizedMasterTool({
			bridge: this.bridge,
			caller: {
				clientId: token.clientId,
				workspaceIds: token.workspaceIds,
				scopes: token.scopes,
				authorizationRevision: 0
			},
			name,
			args,
			includeSessions: this.includeSessions
		});
	}
}
