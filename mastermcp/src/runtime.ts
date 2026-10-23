import { chmod, mkdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { BrowserController } from './browser-controller.ts';
import { loadLiteConfig, saveLiteConfig, type LiteConfig } from './core/config.ts';
import { EncryptedBlobStore, SecretVault } from './core/secure-store.ts';
import { LiteWorkspace, MASTER_MCP_SCOPES, workspaceName } from './core/lite-workspace.ts';
import { BackgroundProcessRegistry } from './core/platform/process.ts';
import { ConsoleSink, FileSink, LogLevel, LogService, type Logger } from './core/platform/logger.ts';
import { MasterMcpService, type MasterMcpBridge, type MasterMcpBrowserRequest, type MasterMcpScope } from './master/master-mcp.ts';
import { NgrokMasterMcpTunnel } from './master/master-mcp-tunnel.ts';
import { MasterMcpRelay, validateRelayUrl } from './master/master-mcp-relay.ts';
import { isPathWithin } from './core/platform/path-safety.ts';
import { LocalWebAiBroker } from './web-ai/local-broker.ts';
import { WebAiGrantStore } from './web-ai/grants.ts';
import { WebAiRequestStore } from './web-ai/request-store.ts';

const SCOPE_SET = new Set<MasterMcpScope>(MASTER_MCP_SCOPES);
const READ_SCOPE: MasterMcpScope = 'forja:read';

export interface LiteRuntimeOptions {
	readonly userRoot: string;
	readonly protectedRoots?: readonly string[];
	readonly logger?: Logger;
}

export interface LiteSnapshot {
	readonly masterMcp: ReturnType<MasterMcpService['status']>;
	readonly webAi: ReturnType<LocalWebAiBroker['status']>;
	readonly tunnel: ReturnType<NgrokMasterMcpTunnel['status']> & { readonly configured: boolean };
	readonly relay: ReturnType<MasterMcpRelay['status']> & { readonly configured: boolean; readonly savedUrl?: string };
	readonly workspaces: Array<{ id: string; name: string; root: string; toolCount: number }>;
	readonly pendingAuthorizations: ReturnType<MasterMcpService['pendingAuthorizations']>;
	readonly authorizations: ReturnType<MasterMcpService['authorizations']>;
	readonly permissions: readonly MasterMcpScope[];
	readonly browserPages: ReturnType<BrowserController['list']>;
}

function workspaceId(root: string): string {
	return `ws_${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
}

function scopes(raw: readonly string[] | undefined): MasterMcpScope[] {
	const selected = (raw ?? []).filter((value): value is MasterMcpScope => SCOPE_SET.has(value as MasterMcpScope));
	return [...new Set<MasterMcpScope>([READ_SCOPE, ...selected])];
}

function strictScopes(raw: readonly string[] | undefined): MasterMcpScope[] {
	return [...new Set((raw ?? []).filter((value): value is MasterMcpScope => SCOPE_SET.has(value as MasterMcpScope)))];
}

function workspaceSummary(workspace: LiteWorkspace): { id: string; name: string; root: string; toolCount: number } {
	return { id: workspace.info.id, name: workspace.info.name, root: workspace.root, toolCount: workspace.listTools().length };
}

/**
 * Application runtime for the standalone Windows and Linux product. It owns the MCP server,
 * encrypted state, workspaces, browser and the local permission bridge; there is
 * intentionally no model provider or Forja agent runtime here.
 */
export class LiteRuntime {
	readonly userRoot: string;
	private readonly configFile: string;
	private readonly config: LiteConfig;
	private readonly secrets: SecretVault;
	private readonly loggerService: LogService;
	private readonly logger: Logger;
	private readonly processes: BackgroundProcessRegistry;
	private readonly browser: BrowserController;
	private readonly tunnel: NgrokMasterMcpTunnel;
	private readonly relay = new MasterMcpRelay();
	private transportQueue: Promise<unknown> = Promise.resolve();
	private readonly workspaces = new Map<string, LiteWorkspace>();
	private readonly protectedRoots: readonly string[];
	private readonly master: MasterMcpService;
	private readonly webAiGrants: WebAiGrantStore;
	private readonly webAiRequests: WebAiRequestStore;
	private readonly webAi: LocalWebAiBroker;
	private disposed = false;

	private constructor(options: LiteRuntimeOptions, config: LiteConfig, loggerService: LogService) {
		this.userRoot = resolve(options.userRoot);
		this.configFile = resolve(this.userRoot, 'config.json');
		this.config = config;
		this.loggerService = loggerService;
		this.logger = options.logger ?? loggerService.logger('lite');
		this.processes = new BackgroundProcessRegistry(this.logger);
		this.browser = new BrowserController();
		this.tunnel = new NgrokMasterMcpTunnel(this.logger);
		this.secrets = new SecretVault(this.userRoot);
		this.protectedRoots = [...new Set([
			resolve(this.userRoot),
			...(options.protectedRoots ?? []).map((root) => resolve(root))
		])];
		const oauthStore = new EncryptedBlobStore(resolve(this.userRoot, 'oauth.enc'), resolve(this.userRoot, 'oauth.key'));
		const webAiGrantStore = new EncryptedBlobStore(resolve(this.userRoot, 'web-ai-grants.enc'), resolve(this.userRoot, 'web-ai-grants.key'));
		const webAiRequestStore = new EncryptedBlobStore(resolve(this.userRoot, 'web-ai-requests.enc'), resolve(this.userRoot, 'web-ai-requests.key'));
		const bridge: MasterMcpBridge = {
			listWorkspaces: async () => [...this.workspaces.values()].map((workspace) => ({ id: workspace.info.id, name: workspace.info.name })),
			listWorkspaceTools: async ({ workspaceId }) => this.requireWorkspace(workspaceId).listTools(),
			callWorkspaceTool: async ({ workspaceId, name, args, scopes: grantScopes }) => this.requireWorkspace(workspaceId).call(
				name, args, grantScopes.filter((scope) => this.config.permissions.includes(scope))
			),
			browserRequest: async ({ workspaceId, request }) => {
				if (!this.config.permissions.includes('forja:browser')) throw new Error('Browser scope is globally disabled.');
				if (['open', 'execute', 'share', 'unshare'].includes(request.action) && !this.config.permissions.includes('forja:agent'))
					throw new Error('Agent scope is globally disabled.');
				return this.browser.request(request.pageId ?? '', request.action, request, workspaceId);
			},
			startSession: async () => { throw new Error('Tessarion MasterMCP Lite does not include a local AI session runtime.'); },
			sendTask: async () => { throw new Error('Tessarion MasterMCP Lite does not include a local AI session runtime.'); },
			sessionStatus: async () => { throw new Error('Tessarion MasterMCP Lite does not include a local AI session runtime.'); },
			readTranscript: async () => { throw new Error('Tessarion MasterMCP Lite does not include a local AI session runtime.'); },
			getChanges: async () => { throw new Error('Tessarion MasterMCP Lite does not include a local AI session runtime.'); },
			cancelTurn: async () => { throw new Error('Tessarion MasterMCP Lite does not include a local AI session runtime.'); }
		};
		this.master = new MasterMcpService({ bridge, logger: this.logger, persistence: oauthStore, includeSessions: false });
		this.webAiGrants = new WebAiGrantStore(webAiGrantStore);
		this.webAiRequests = new WebAiRequestStore(webAiRequestStore);
		this.webAi = new LocalWebAiBroker({ bridge, grants: this.webAiGrants, requests: this.webAiRequests, logger: this.logger });
	}

	static async create(options: LiteRuntimeOptions): Promise<LiteRuntime> {
		const userRoot = resolve(options.userRoot);
		await mkdir(userRoot, { recursive: true, mode: 0o700 });
		await chmod(userRoot, 0o700).catch(() => undefined);
		const configFile = resolve(userRoot, 'config.json');
		const config = await loadLiteConfig(configFile);
		const logDir = resolve(userRoot, 'logs');
		await mkdir(logDir, { recursive: true, mode: 0o700 });
		await chmod(logDir, 0o700).catch(() => undefined);
		const loggerService = new LogService(LogLevel.Info, [new ConsoleSink(), new FileSink(resolve(logDir, 'lite.log'))]);
		const runtime = new LiteRuntime(options, config, loggerService);
		await runtime.initialize();
		return runtime;
	}

	private async initialize(): Promise<void> {
		await Promise.all([this.master.initialize(), this.webAiGrants.initialize(), this.webAiRequests.initialize()]);
		for (const entry of this.config.workspaces) {
			try {
				const workspace = await this.makeWorkspace(entry.root, entry.id, entry.name);
				this.workspaces.set(workspace.info.id, workspace);
			} catch (error) {
				this.logger.warn('Configured workspace was skipped', { root: entry.root, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	async snapshot(): Promise<LiteSnapshot> {
		await this.master.initialize();
		const relayUrl = await this.secrets.get('masterMcp.relayUrl');
		return {
			masterMcp: this.master.status(),
			webAi: this.webAi.status(),
			tunnel: { ...this.tunnel.status(), configured: Boolean(await this.secrets.get('masterMcp.ngrokAuthtoken')) },
			relay: { ...this.relay.status(), configured: Boolean(relayUrl && await this.secrets.get('masterMcp.relayKey')), savedUrl: relayUrl },
			workspaces: [...this.workspaces.values()].map(workspaceSummary),
			pendingAuthorizations: this.master.pendingAuthorizations(),
			authorizations: this.master.authorizations(),
			permissions: [...this.config.permissions] as MasterMcpScope[],
			browserPages: this.browser.list()
		};
	}

	async start(): Promise<LiteSnapshot> {
		if (this.config.preferredTransport === 'relay') return this.startRelay();
		if (this.config.preferredTransport === 'ngrok') return this.startTunnel();
		return this.transport(async () => { await this.master.start(); return this.snapshot(); });
	}

	async startLocal(): Promise<LiteSnapshot> {
		return this.transport(async () => {
			await this.relay.stop(); await this.tunnel.stop();
			await this.master.start(); this.master.setPublicUrl(undefined);
			return this.snapshot();
		});
	}

	async stop(): Promise<LiteSnapshot> {
		return this.transport(async () => {
		await this.relay.stop();
		await this.tunnel.stop();
		await this.master.stop();
		return this.snapshot();
		});
	}

	private transport<T>(operation: () => Promise<T>): Promise<T> {
		const guarded = () => { if (this.disposed) throw new Error('Master MCP Lite is closing.'); return operation(); };
		const next = this.transportQueue.then(guarded, guarded);
		this.transportQueue = next.catch(() => undefined);
		return next;
	}

	async startRelay(rawUrl?: string, rawKey?: string): Promise<LiteSnapshot> {
		return this.transport(async () => {
			const url = rawUrl?.trim() || await this.secrets.get('masterMcp.relayUrl');
			const key = rawKey?.trim() || await this.secrets.get('masterMcp.relayKey');
			if (!url || !key) throw new Error('Configura la URL de instalación y la clave privada del relay.');
			validateRelayUrl(url);
			if (!this.master.status().running) await this.master.start();
			await this.tunnel.stop();
			await this.relay.stop();
			this.master.setPublicUrl(url.replace(/\/$/, ''));
			try {
				await this.relay.start(url, key, this.master.status().localUrl!);
				await this.secrets.set('masterMcp.relayUrl', url);
				await this.secrets.set('masterMcp.relayKey', key);
				this.config.preferredTransport = 'relay';
				await saveLiteConfig(this.configFile, this.config);
			} catch (error) { await this.relay.stop(); this.master.setPublicUrl(undefined); throw error; }
			return this.snapshot();
		});
	}

	async stopRelay(): Promise<LiteSnapshot> {
		return this.transport(async () => {
			await this.relay.stop();
			if (this.master.status().running && !this.tunnel.status().running) this.master.setPublicUrl(undefined);
			this.config.preferredTransport = 'local';
			await saveLiteConfig(this.configFile, this.config);
			return this.snapshot();
		});
	}

	async saveNgrokToken(rawToken: string): Promise<void> {
		if (typeof rawToken !== 'string' || rawToken.trim().length < 10) throw new Error('ngrok token is missing.');
		await this.secrets.set('masterMcp.ngrokAuthtoken', rawToken.trim());
	}

	async startTunnel(rawToken?: string, domain?: string): Promise<LiteSnapshot> {
		return this.transport(async () => {
		const token = rawToken?.trim() || await this.secrets.get('masterMcp.ngrokAuthtoken');
		if (!token) throw new Error('Introduce el token del túnel para crear el enlace público.');
		if (!this.master.status().running) await this.master.start();
		const localUrl = this.master.status().localUrl;
		if (!localUrl) throw new Error('Master MCP no tiene un puerto local disponible.');
		if (rawToken?.trim()) await this.secrets.set('masterMcp.ngrokAuthtoken', rawToken.trim());
		await this.relay.stop();
		this.master.setPublicUrl(undefined);
		const publicUrl = await this.tunnel.start(localUrl, token, domain);
		this.master.setPublicUrl(publicUrl);
		this.config.preferredTransport = 'ngrok';
		await saveLiteConfig(this.configFile, this.config);
		return this.snapshot();
		});
	}

	async stopTunnel(): Promise<LiteSnapshot> {
		return this.transport(async () => {
		await this.tunnel.stop();
		if (this.master.status().running && !this.relay.status().running) this.master.setPublicUrl(undefined);
		this.config.preferredTransport = this.relay.status().running ? 'relay' : 'local';
		await saveLiteConfig(this.configFile, this.config);
		return this.snapshot();
		});
	}

	async startWebAi(rawPort?: number): Promise<LiteSnapshot> {
		const port = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535 ? rawPort : this.config.webAiLocal.port;
		await this.webAi.start(port);
		this.config.webAiLocal.port = port;
		await saveLiteConfig(this.configFile, this.config);
		return this.snapshot();
	}

	async stopWebAi(): Promise<LiteSnapshot> {
		await this.webAi.stop();
		return this.snapshot();
	}

	webAiBeginPairing(): { code: string; expiresAt: number } {
		return this.webAi.beginPairing();
	}

	async webAiApprovePair(id: string, workspaceIds: readonly string[], rawScopes: readonly string[]): Promise<LiteSnapshot> {
		const selectedWorkspaces = [...new Set(workspaceIds)].filter((workspaceId) => this.workspaces.has(workspaceId));
		await this.webAi.approvePair(id, selectedWorkspaces, strictScopes(rawScopes));
		return this.snapshot();
	}

	async webAiDenyPair(id: string): Promise<LiteSnapshot> {
		this.webAi.denyPair(id);
		return this.snapshot();
	}

	async webAiUpdateClient(id: string, workspaceIds: readonly string[], rawScopes: readonly string[]): Promise<LiteSnapshot> {
		const selectedWorkspaces = [...new Set(workspaceIds)].filter((workspaceId) => this.workspaces.has(workspaceId));
		await this.webAi.updateClient(id, selectedWorkspaces, strictScopes(rawScopes));
		return this.snapshot();
	}

	async webAiRevokeClient(id: string): Promise<LiteSnapshot> {
		await this.webAi.revokeClient(id);
		return this.snapshot();
	}

	async webAiPauseSession(id: string, paused: boolean): Promise<LiteSnapshot> {
		this.webAi.pauseSession(id, paused);
		return this.snapshot();
	}

	async webAiApproveRequest(id: string): Promise<LiteSnapshot> {
		await this.webAi.approveRequest(id);
		return this.snapshot();
	}

	async webAiDenyRequest(id: string): Promise<LiteSnapshot> {
		await this.webAi.denyRequest(id);
		return this.snapshot();
	}

	async setPermissions(raw: readonly string[]): Promise<LiteSnapshot> {
		this.config.permissions = scopes(raw);
		await saveLiteConfig(this.configFile, this.config);
		return this.snapshot();
	}

	async addWorkspace(rootInput: string): Promise<LiteSnapshot> {
		const workspace = await this.makeWorkspace(rootInput);
		if (this.workspaces.has(workspace.info.id)) return this.snapshot();
		this.workspaces.set(workspace.info.id, workspace);
		this.config.workspaces.push({ id: workspace.info.id, root: workspace.root, name: workspace.info.name });
		await saveLiteConfig(this.configFile, this.config);
		return this.snapshot();
	}

	async removeWorkspace(id: string): Promise<LiteSnapshot> {
		if (!this.workspaces.delete(id)) throw new Error('El workspace no existe o ya fue eliminado.');
		this.config.workspaces = this.config.workspaces.filter((entry) => entry.id !== id);
		await saveLiteConfig(this.configFile, this.config);
		return this.snapshot();
	}

	async approveAuthorization(id: string, workspaceIds: readonly string[], rawScopes?: readonly string[]): Promise<LiteSnapshot> {
		const selectedWorkspaces = [...new Set(workspaceIds)].filter((workspaceId) => this.workspaces.has(workspaceId));
		if (selectedWorkspaces.length === 0) throw new Error('Selecciona al menos un workspace para aprobar el conector.');
		this.master.approveAuthorization(id, { workspaceIds: selectedWorkspaces, scopes: scopes(rawScopes ?? this.config.permissions) });
		return this.snapshot();
	}

	async denyAuthorization(id: string): Promise<LiteSnapshot> {
		this.master.denyAuthorization(id);
		return this.snapshot();
	}

	async revokeAuthorization(clientId: string): Promise<LiteSnapshot> {
		await this.master.revokeAuthorization(clientId);
		return this.snapshot();
	}

	async updateAuthorization(clientId: string, rawScopes: readonly string[], workspaceIds?: readonly string[]): Promise<LiteSnapshot> {
		await this.master.updateAuthorization(clientId, scopes(rawScopes), workspaceIds);
		return this.snapshot();
	}

	async browserOpen(workspaceId: string, url: string): Promise<LiteSnapshot> {
		this.requireWorkspace(workspaceId);
		await this.browser.open(url, true, workspaceId);
		return this.snapshot();
	}

	async browserShare(pageId: string, shared: boolean, workspaceId?: string): Promise<LiteSnapshot> {
		const page = this.browser.list().find((candidate) => candidate.id === pageId);
		if (!page || (workspaceId && page.workspaceId !== workspaceId)) throw new Error('La pestaña del navegador no existe.');
		this.browser.share(pageId, shared);
		return this.snapshot();
	}

	async browserRequest(workspaceId: string, request: MasterMcpBrowserRequest): Promise<unknown> {
		this.requireWorkspace(workspaceId);
		return this.browser.request(request.pageId ?? '', request.action, request, workspaceId);
	}

	private async makeWorkspace(rootInput: string, expectedId?: string, expectedName?: string): Promise<LiteWorkspace> {
		if (!rootInput || !isAbsolute(rootInput)) throw new Error('El workspace debe ser una ruta absoluta.');
		const root = await realpath(resolve(rootInput));
		const info = await stat(root);
		if (!info.isDirectory()) throw new Error('El workspace seleccionado no es una carpeta.');
		if (this.protectedRoots.some((protectedRoot) => isPathWithin(protectedRoot, root) || isPathWithin(root, protectedRoot))) {
			throw new Error('No puedes usar la instalación, la configuración o los datos privados de Master MCP Lite como workspace.');
		}
		const id = workspaceId(root);
		if (expectedId && expectedId !== id) this.logger.info('Workspace id was recalculated after resolving its path', { expectedId, id });
		const workspace = new LiteWorkspace({ id, name: expectedName || workspaceName(root), root, protectedRoots: this.protectedRoots, processes: this.processes, logger: this.logger });
		await workspace.initialize();
		return workspace;
	}

	private requireWorkspace(id: string): LiteWorkspace {
		const workspace = this.workspaces.get(id);
		if (!workspace) throw new Error('El workspace solicitado no está autorizado en Master MCP Lite.');
		return workspace;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.transportQueue;
		await this.webAi.stop().catch(() => undefined);
		await this.relay.stop().catch(() => undefined);
		await this.tunnel.stop().catch(() => undefined);
		await this.master.stop().catch(() => undefined);
		this.browser.closeAll();
		await this.loggerService.flush().catch(() => undefined);
		this.loggerService.dispose();
	}
}
