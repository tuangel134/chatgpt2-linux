import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { MasterMcpScope } from '../master/master-mcp.ts';
import type { AuthorizedCaller } from '../master/master-mcp-dispatcher.ts';
import { WEB_AI_MAX_SESSIONS, WEB_AI_PAIR_TTL_MS, WEB_AI_SESSION_TTL_MS, type WebAiProvider, type WebAiSessionDescriptor } from './protocol.ts';

export interface WebAiPersistence {
	load(): Promise<string | undefined>;
	save(value: string): Promise<void>;
}

interface PairWindow {
	readonly code: string;
	readonly expiresAt: number;
	pendingRequestId?: string;
	failedAttempts: number;
}

interface PendingPair {
	readonly id: string;
	readonly tempSecret: string;
	readonly origin: string;
	readonly extensionId: string;
	readonly browserName: string;
	readonly installationId: string;
	readonly requestedWorkspaceIds: readonly string[];
	readonly createdAt: number;
	readonly expiresAt: number;
	status: 'pending' | 'approved' | 'denied';
	clientId?: string;
	clientSecret?: string;
}

export interface WebAiClient {
	readonly id: string;
	readonly origin: string;
	readonly extensionId: string;
	readonly browserName: string;
	readonly installationId: string;
	readonly secretHash: string;
	readonly workspaceIds: readonly string[];
	readonly scopes: readonly MasterMcpScope[];
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly authorizationRevision: number;
}

export interface WebAiSession extends WebAiSessionDescriptor {
	readonly id: string;
	readonly tokenHash: string;
	readonly clientId: string;
	readonly origin: string;
	readonly createdAt: number;
	expiresAt: number;
	paused: boolean;
}

function secret(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

function hash(value: string): string {
	return createHash('sha256').update(value).digest('base64url');
}

function safeHashEqual(value: string, expectedHash: string): boolean {
	const actual = Buffer.from(hash(value));
	const expected = Buffer.from(expectedHash);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function pairingCode(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	const bytes = randomBytes(10);
	let out = '';
	for (let i = 0; i < 10; i += 1) out += alphabet[bytes[i]! % alphabet.length];
	return out;
}

function extensionIdFromOrigin(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}

export class WebAiGrantStore {
	private pairWindow: PairWindow | undefined;
	private readonly pendingPairs = new Map<string, PendingPair>();
	private readonly clients = new Map<string, WebAiClient>();
	private readonly sessions = new Map<string, WebAiSession>();
	private readonly invalidAttemptsByOrigin = new Map<string, number[]>();
	private persistQueue: Promise<void> = Promise.resolve();
	private hydrated = false;

	constructor(private readonly persistence?: WebAiPersistence) {}

	async initialize(): Promise<void> {
		if (this.hydrated) return;
		try {
			const raw = await this.persistence?.load();
			if (!raw) return;
			const parsed = JSON.parse(raw) as { version?: number; clients?: unknown[] };
			if (parsed.version !== 1 || !Array.isArray(parsed.clients)) return;
			for (const value of parsed.clients) {
				if (!value || typeof value !== 'object') continue;
				const client = value as Partial<WebAiClient>;
				if (typeof client.id !== 'string' || typeof client.origin !== 'string' || typeof client.secretHash !== 'string' || !Array.isArray(client.workspaceIds) || !Array.isArray(client.scopes)) continue;
				this.clients.set(client.id, {
					id: client.id,
					origin: client.origin,
					extensionId: typeof client.extensionId === 'string' ? client.extensionId : extensionIdFromOrigin(client.origin),
					browserName: typeof client.browserName === 'string' ? client.browserName : 'Browser extension',
					installationId: typeof client.installationId === 'string' ? client.installationId : 'unknown',
					secretHash: client.secretHash,
					workspaceIds: client.workspaceIds.filter((entry): entry is string => typeof entry === 'string'),
					scopes: client.scopes.filter((entry): entry is MasterMcpScope => typeof entry === 'string') as MasterMcpScope[],
					createdAt: typeof client.createdAt === 'number' ? client.createdAt : Date.now(),
					updatedAt: typeof client.updatedAt === 'number' ? client.updatedAt : Date.now(),
					authorizationRevision: typeof client.authorizationRevision === 'number' ? client.authorizationRevision : 1
				});
			}
		} finally {
			this.hydrated = true;
		}
	}

	private persist(): Promise<void> {
		if (!this.persistence) return Promise.resolve();
		const snapshot = JSON.stringify({ version: 1, clients: [...this.clients.values()] });
		const save = () => this.persistence!.save(snapshot);
		this.persistQueue = this.persistQueue.then(save, save);
		return this.persistQueue;
	}

	private cleanup(now = Date.now()): void {
		if (this.pairWindow && this.pairWindow.expiresAt < now) this.pairWindow = undefined;
		for (const [id, pair] of this.pendingPairs) if (pair.expiresAt < now) this.pendingPairs.delete(id);
		for (const [id, session] of this.sessions) if (session.expiresAt < now) this.sessions.delete(id);
		for (const [origin, entries] of this.invalidAttemptsByOrigin) {
			const current = entries.filter((time) => time >= now - 60_000);
			if (current.length) this.invalidAttemptsByOrigin.set(origin, current); else this.invalidAttemptsByOrigin.delete(origin);
		}
	}

	beginPairing(): { code: string; expiresAt: number } {
		this.cleanup();
		const window: PairWindow = { code: pairingCode(), expiresAt: Date.now() + WEB_AI_PAIR_TTL_MS, failedAttempts: 0 };
		this.pairWindow = window;
		return { code: window.code, expiresAt: window.expiresAt };
	}

	pairingOpen(): boolean {
		this.cleanup();
		return Boolean(this.pairWindow && this.pairWindow.expiresAt >= Date.now());
	}

	requestPair(input: { code: string; origin: string; browserName?: string; installationId?: string; requestedWorkspaceIds?: readonly string[] }): { requestId: string; tempSecret: string; expiresAt: number } {
		this.cleanup();
		const now = Date.now();
		const recent = this.invalidAttemptsByOrigin.get(input.origin) ?? [];
		if (recent.length >= 5) throw new Error('Demasiados códigos inválidos. Espera un minuto antes de intentar de nuevo.');
		const window = this.pairWindow;
		if (!window || window.expiresAt < now || window.failedAttempts >= 20 || window.code !== input.code.trim().toUpperCase()) {
			if (window) window.failedAttempts += 1;
			recent.push(now);
			this.invalidAttemptsByOrigin.set(input.origin, recent);
			throw new Error('Código de vinculación inválido o caducado.');
		}
		if (window.pendingRequestId) throw new Error('Este código ya tiene una solicitud pendiente.');
		const id = randomUUID();
		const tempSecret = secret(24);
		const pending: PendingPair = {
			id,
			tempSecret,
			origin: input.origin,
			extensionId: extensionIdFromOrigin(input.origin),
			browserName: (input.browserName || 'Chrome/Edge').slice(0, 80),
			installationId: (input.installationId || 'unknown').slice(0, 120),
			requestedWorkspaceIds: [...new Set((input.requestedWorkspaceIds ?? []).filter((value): value is string => typeof value === 'string'))],
			createdAt: now,
			expiresAt: window.expiresAt,
			status: 'pending'
		};
		this.pendingPairs.set(id, pending);
		window.pendingRequestId = id;
		return { requestId: id, tempSecret, expiresAt: pending.expiresAt };
	}

	pendingPairSummaries(): Array<{ id: string; origin: string; extensionId: string; browserName: string; installationId: string; requestedWorkspaceIds: readonly string[]; createdAt: number; expiresAt: number }> {
		this.cleanup();
		return [...this.pendingPairs.values()].filter((pair) => pair.status === 'pending').map((pair) => ({ id: pair.id, origin: pair.origin, extensionId: pair.extensionId, browserName: pair.browserName, installationId: pair.installationId, requestedWorkspaceIds: pair.requestedWorkspaceIds, createdAt: pair.createdAt, expiresAt: pair.expiresAt }));
	}

	async approvePair(id: string, workspaceIds: readonly string[], scopes: readonly MasterMcpScope[]): Promise<void> {
		this.cleanup();
		const pair = this.pendingPairs.get(id);
		if (!pair || pair.status !== 'pending' || pair.expiresAt < Date.now()) throw new Error('La solicitud de vinculación no existe o caducó.');
		const uniqueWorkspaces = [...new Set(workspaceIds)];
		if (uniqueWorkspaces.length === 0) throw new Error('Selecciona al menos un workspace para la IA web local.');
		const clientSecret = secret(32);
		const client: WebAiClient = {
			id: `webai_${randomUUID()}`,
			origin: pair.origin,
			extensionId: pair.extensionId,
			browserName: pair.browserName,
			installationId: pair.installationId,
			secretHash: hash(clientSecret),
			workspaceIds: uniqueWorkspaces,
			scopes: [...new Set(scopes)],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			authorizationRevision: 1
		};
		this.clients.set(client.id, client);
		pair.status = 'approved';
		pair.clientId = client.id;
		pair.clientSecret = clientSecret;
		this.pairWindow = undefined;
		await this.persist();
	}

	denyPair(id: string): void {
		const pair = this.pendingPairs.get(id);
		if (!pair) return;
		pair.status = 'denied';
		this.pairWindow = undefined;
	}

	pairStatus(id: string, tempSecret: string): { status: 'pending' | 'denied' | 'approved'; clientId?: string; clientSecret?: string; workspaceIds?: readonly string[]; scopes?: readonly MasterMcpScope[] } {
		this.cleanup();
		const pair = this.pendingPairs.get(id);
		if (!pair || !safeHashEqual(tempSecret, hash(pair.tempSecret))) throw new Error('La solicitud de vinculación no existe o no coincide.');
		if (pair.status === 'approved') {
			const client = pair.clientId ? this.clients.get(pair.clientId) : undefined;
			return { status: 'approved', clientId: pair.clientId, clientSecret: pair.clientSecret, workspaceIds: client?.workspaceIds ?? [], scopes: client?.scopes ?? [] };
		}
		return { status: pair.status };
	}

	clientSummaries(): Array<{ id: string; origin: string; extensionId: string; browserName: string; installationId: string; workspaceIds: readonly string[]; scopes: readonly MasterMcpScope[]; authorizationRevision: number; updatedAt: number }> {
		return [...this.clients.values()].map(({ id, origin, extensionId, browserName, installationId, workspaceIds, scopes, authorizationRevision, updatedAt }) => ({ id, origin, extensionId, browserName, installationId, workspaceIds, scopes, authorizationRevision, updatedAt }));
	}

	authenticateClient(token: string, origin: string): WebAiClient {
		this.cleanup();
		const client = [...this.clients.values()].find((candidate) => candidate.origin === origin && safeHashEqual(token, candidate.secretHash));
		if (!client) throw new Error('Credencial de IA web local inválida o revocada.');
		return client;
	}

	async updateClient(id: string, workspaceIds: readonly string[], scopes: readonly MasterMcpScope[]): Promise<void> {
		const current = this.clients.get(id);
		if (!current) throw new Error('El navegador vinculado ya no existe.');
		const next: WebAiClient = { ...current, workspaceIds: [...new Set(workspaceIds)], scopes: [...new Set(scopes)], updatedAt: Date.now(), authorizationRevision: current.authorizationRevision + 1 };
		this.clients.set(id, next);
		for (const [sessionId, session] of this.sessions) if (session.clientId === id && !next.workspaceIds.includes(session.workspaceId)) this.sessions.delete(sessionId);
		await this.persist();
	}

	async revokeClient(id: string): Promise<boolean> {
		const removed = this.clients.delete(id);
		for (const [sessionId, session] of this.sessions) if (session.clientId === id) this.sessions.delete(sessionId);
		if (removed) await this.persist();
		return removed;
	}

	createSession(client: WebAiClient, origin: string, descriptor: WebAiSessionDescriptor): { session: WebAiSession; token: string } {
		this.cleanup();
		if (this.sessions.size >= WEB_AI_MAX_SESSIONS) throw new Error('Se alcanzó el máximo de sesiones de IA web local.');
		if (client.origin !== origin) throw new Error('El origen de la extensión no coincide con la vinculación aprobada.');
		if (!client.workspaceIds.includes(descriptor.workspaceId)) throw new Error('El workspace no está autorizado para este navegador.');
		if (!Number.isInteger(descriptor.tabId) || descriptor.tabId < 0) throw new Error('tabId inválido.');
		if (!descriptor.documentGeneration || !descriptor.conversationId) throw new Error('La sesión requiere generación de documento y conversación.');
		const token = secret(32);
		const session: WebAiSession = {
			...descriptor,
			id: randomUUID(),
			tokenHash: hash(token),
			clientId: client.id,
			origin,
			createdAt: Date.now(),
			expiresAt: Date.now() + WEB_AI_SESSION_TTL_MS,
			paused: false
		};
		this.sessions.set(session.id, session);
		return { session, token };
	}

	authenticateSession(token: string, origin: string): WebAiSession {
		this.cleanup();
		const session = [...this.sessions.values()].find((candidate) => candidate.origin === origin && safeHashEqual(token, candidate.tokenHash));
		if (!session || session.expiresAt < Date.now()) throw new Error('La sesión de IA web local caducó o fue revocada.');
		if (session.paused) throw new Error('La sesión de IA web local está pausada.');
		session.expiresAt = Date.now() + WEB_AI_SESSION_TTL_MS;
		return session;
	}

	sessionById(id: string): WebAiSession | undefined {
		this.cleanup();
		return this.sessions.get(id);
	}

	callerForSession(id: string): AuthorizedCaller {
		const session = this.sessionById(id);
		if (!session) throw new Error('La sesión ya no existe.');
		const client = this.clients.get(session.clientId);
		if (!client || !client.workspaceIds.includes(session.workspaceId)) throw new Error('La autorización cambió o fue revocada.');
		return { clientId: client.id, workspaceIds: client.workspaceIds, scopes: client.scopes, authorizationRevision: client.authorizationRevision };
	}

	pauseSession(id: string, paused: boolean): void {
		const session = this.sessions.get(id);
		if (!session) throw new Error('La sesión ya no existe.');
		session.paused = paused;
	}

	closeSession(id: string): boolean {
		return this.sessions.delete(id);
	}

	closeAllSessions(): void {
		this.sessions.clear();
	}

	sessionSummaries(): Array<{ id: string; clientId: string; provider: WebAiProvider; tabId: number; conversationId: string; workspaceId: string; paused: boolean; expiresAt: number; autoSend: boolean }> {
		this.cleanup();
		return [...this.sessions.values()].map((session) => ({ id: session.id, clientId: session.clientId, provider: session.provider, tabId: session.tabId, conversationId: session.conversationId, workspaceId: session.workspaceId, paused: session.paused, expiresAt: session.expiresAt, autoSend: session.autoSend === true }));
	}
}
