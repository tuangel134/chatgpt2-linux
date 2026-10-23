import { createHash, randomUUID } from 'node:crypto';
import type { WebAiPersistence } from './grants.ts';
import {
	WEB_AI_APPROVAL_TTL_MS,
	WEB_AI_MAX_GLOBAL_RESULT_BYTES,
	WEB_AI_MAX_QUEUED_GLOBAL,
	WEB_AI_MAX_QUEUED_PER_CLIENT,
	WEB_AI_RESULT_TTL_MS,
	truncateResult,
	type WebAiRequestState
} from './protocol.ts';

export interface WebAiRequestRecord {
	readonly id: string;
	readonly clientId: string;
	readonly sessionId: string;
	readonly idempotencyKey: string;
	readonly contentHash: string;
	readonly tool: string;
	readonly arguments: Record<string, unknown>;
	readonly createdAt: number;
	readonly authorizationRevisionAtCreate: number;
	readonly requiresApproval: boolean;
	state: WebAiRequestState;
	updatedAt: number;
	approvalDeadline?: number;
	approvedRevision?: number;
	startedAt?: number;
	finishedAt?: number;
	result?: unknown;
	resultBytes?: number;
	resultTruncated?: boolean;
	error?: string;
}

interface JournalRecord {
	readonly id: string;
	readonly clientId: string;
	readonly sessionId: string;
	readonly idempotencyKey: string;
	readonly contentHash: string;
	readonly tool: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly state: WebAiRequestState;
	readonly authorizationRevisionAtCreate: number;
	readonly requiresApproval: boolean;
	readonly approvedRevision?: number;
}

function stable(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function contentHash(tool: string, args: Record<string, unknown>): string {
	return createHash('sha256').update(`${tool}\n${stable(args)}`).digest('base64url');
}

function terminal(state: WebAiRequestState): boolean {
	return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'uncertain';
}

export class WebAiRequestStore {
	private readonly requests = new Map<string, WebAiRequestRecord>();
	private readonly journal = new Map<string, JournalRecord>();
	private persistQueue: Promise<void> = Promise.resolve();
	private hydrated = false;

	constructor(private readonly persistence?: WebAiPersistence) {}

	async initialize(): Promise<void> {
		if (this.hydrated) return;
		try {
			const raw = await this.persistence?.load();
			if (!raw) return;
			const parsed = JSON.parse(raw) as { version?: number; journal?: unknown[] };
			if (parsed.version !== 1 || !Array.isArray(parsed.journal)) return;
			for (const value of parsed.journal) {
				if (!value || typeof value !== 'object') continue;
				const row = value as Partial<JournalRecord>;
				if (typeof row.id !== 'string' || typeof row.clientId !== 'string' || typeof row.sessionId !== 'string' || typeof row.idempotencyKey !== 'string' || typeof row.contentHash !== 'string' || typeof row.tool !== 'string' || typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number' || typeof row.state !== 'string') continue;
				const restoredState: WebAiRequestState = terminal(row.state as WebAiRequestState) ? row.state as WebAiRequestState : 'uncertain';
				this.journal.set(row.idempotencyKey, {
					id: row.id,
					clientId: row.clientId,
					sessionId: row.sessionId,
					idempotencyKey: row.idempotencyKey,
					contentHash: row.contentHash,
					tool: row.tool,
					createdAt: row.createdAt,
					updatedAt: Date.now(),
					state: restoredState,
					authorizationRevisionAtCreate: typeof row.authorizationRevisionAtCreate === 'number' ? row.authorizationRevisionAtCreate : 0,
					requiresApproval: row.requiresApproval === true,
					...(typeof row.approvedRevision === 'number' ? { approvedRevision: row.approvedRevision } : {})
				});
			}
		} finally {
			this.hydrated = true;
		}
	}

	private persist(): Promise<void> {
		if (!this.persistence) return Promise.resolve();
		this.cleanupJournal();
		const snapshot = JSON.stringify({ version: 1, journal: [...this.journal.values()] });
		const save = () => this.persistence!.save(snapshot);
		this.persistQueue = this.persistQueue.then(save, save);
		return this.persistQueue;
	}

	private cleanupJournal(now = Date.now()): void {
		for (const [key, row] of this.journal) if (row.updatedAt < now - WEB_AI_RESULT_TTL_MS) this.journal.delete(key);
		for (const [id, request] of this.requests) {
			if (request.approvalDeadline && request.state === 'pending-approval' && request.approvalDeadline < now) {
				request.state = 'failed';
				request.error = 'La aprobación local caducó.';
				request.finishedAt = now;
				request.updatedAt = now;
			}
			if (terminal(request.state) && request.updatedAt < now - WEB_AI_RESULT_TTL_MS) this.requests.delete(id);
		}
	}

	private counts(clientId: string): { client: number; global: number } {
		this.cleanupJournal();
		const active = [...this.requests.values()].filter((request) => !terminal(request.state));
		return { client: active.filter((request) => request.clientId === clientId).length, global: active.length };
	}

	async register(input: {
		clientId: string;
		sessionId: string;
		idempotencyKey: string;
		tool: string;
		arguments: Record<string, unknown>;
		authorizationRevision: number;
		requiresApproval: boolean;
	}): Promise<WebAiRequestRecord> {
		this.cleanupJournal();
		if (!input.idempotencyKey || input.idempotencyKey.length > 700) throw new Error('Clave de idempotencia inválida.');
		const hash = contentHash(input.tool, input.arguments);
		const existing = this.journal.get(input.idempotencyKey);
		if (existing) {
			if (existing.contentHash !== hash || existing.clientId !== input.clientId || existing.sessionId !== input.sessionId) throw new Error('Conflicto de idempotencia: la misma clave contiene una solicitud diferente.');
			const live = this.requests.get(existing.id);
			if (live) return live;
			return {
				id: existing.id,
				clientId: existing.clientId,
				sessionId: existing.sessionId,
				idempotencyKey: existing.idempotencyKey,
				contentHash: existing.contentHash,
				tool: existing.tool,
				arguments: {},
				createdAt: existing.createdAt,
				updatedAt: existing.updatedAt,
				state: existing.state,
				authorizationRevisionAtCreate: existing.authorizationRevisionAtCreate,
				requiresApproval: existing.requiresApproval,
				...(existing.approvedRevision !== undefined ? { approvedRevision: existing.approvedRevision } : {}),
				error: existing.state === 'uncertain' ? 'Estado incierto tras reinicio; verifica el efecto antes de repetir.' : 'El resultado completo ya no está disponible en memoria; no se reejecutará automáticamente.'
			};
		}
		const counts = this.counts(input.clientId);
		if (counts.client >= WEB_AI_MAX_QUEUED_PER_CLIENT) throw new Error('Se alcanzó la cola máxima para este navegador.');
		if (counts.global >= WEB_AI_MAX_QUEUED_GLOBAL) throw new Error('Se alcanzó la cola global de IA web local.');
		const now = Date.now();
		const request: WebAiRequestRecord = {
			id: randomUUID(),
			clientId: input.clientId,
			sessionId: input.sessionId,
			idempotencyKey: input.idempotencyKey,
			contentHash: hash,
			tool: input.tool,
			arguments: input.arguments,
			createdAt: now,
			updatedAt: now,
			authorizationRevisionAtCreate: input.authorizationRevision,
			requiresApproval: input.requiresApproval,
			state: input.requiresApproval ? 'pending-approval' : 'queued',
			...(input.requiresApproval ? { approvalDeadline: now + WEB_AI_APPROVAL_TTL_MS } : {})
		};
		this.requests.set(request.id, request);
		this.journal.set(input.idempotencyKey, this.toJournal(request));
		await this.persist();
		return request;
	}

	private toJournal(request: WebAiRequestRecord): JournalRecord {
		return {
			id: request.id,
			clientId: request.clientId,
			sessionId: request.sessionId,
			idempotencyKey: request.idempotencyKey,
			contentHash: request.contentHash,
			tool: request.tool,
			createdAt: request.createdAt,
			updatedAt: request.updatedAt,
			state: request.state,
			authorizationRevisionAtCreate: request.authorizationRevisionAtCreate,
			requiresApproval: request.requiresApproval,
			...(request.approvedRevision !== undefined ? { approvedRevision: request.approvedRevision } : {})
		};
	}

	private async checkpoint(request: WebAiRequestRecord): Promise<void> {
		request.updatedAt = Date.now();
		this.journal.set(request.idempotencyKey, this.toJournal(request));
		await this.persist();
	}

	get(id: string): WebAiRequestRecord | undefined {
		this.cleanupJournal();
		return this.requests.get(id);
	}

	getOwned(id: string, clientId: string, sessionId: string): WebAiRequestRecord {
		const request = this.get(id);
		if (!request || request.clientId !== clientId || request.sessionId !== sessionId) throw new Error('La solicitud no existe para esta sesión.');
		return request;
	}

	pendingApprovals(): WebAiRequestRecord[] {
		this.cleanupJournal();
		return [...this.requests.values()].filter((request) => request.state === 'pending-approval');
	}

	queued(): WebAiRequestRecord[] {
		this.cleanupJournal();
		return [...this.requests.values()].filter((request) => request.state === 'queued').sort((left, right) => left.createdAt - right.createdAt);
	}

	async approve(id: string, authorizationRevision: number): Promise<WebAiRequestRecord> {
		const request = this.get(id);
		if (!request || request.state !== 'pending-approval') throw new Error('La solicitud ya no espera aprobación.');
		if (request.approvalDeadline && request.approvalDeadline < Date.now()) throw new Error('La aprobación local caducó.');
		request.state = 'queued';
		request.approvedRevision = authorizationRevision;
		delete request.approvalDeadline;
		await this.checkpoint(request);
		return request;
	}

	async deny(id: string, reason = 'La operación fue denegada por el usuario local.'): Promise<WebAiRequestRecord> {
		const request = this.get(id);
		if (!request || request.state !== 'pending-approval') throw new Error('La solicitud ya no espera aprobación.');
		request.state = 'cancelled';
		request.error = reason;
		request.finishedAt = Date.now();
		delete request.approvalDeadline;
		await this.checkpoint(request);
		return request;
	}

	async markRunning(id: string): Promise<WebAiRequestRecord> {
		const request = this.get(id);
		if (!request || request.state !== 'queued') throw new Error('La solicitud no está lista para ejecutarse.');
		request.state = 'running';
		request.startedAt = Date.now();
		await this.checkpoint(request);
		return request;
	}

	private retainedResultBytes(): number {
		return [...this.requests.values()].reduce((sum, request) => sum + (request.resultBytes ?? 0), 0);
	}

	async succeed(id: string, value: unknown): Promise<WebAiRequestRecord> {
		const request = this.get(id);
		if (!request || request.state !== 'running') throw new Error('La solicitud no está en ejecución.');
		const bounded = truncateResult(value);
		const available = WEB_AI_MAX_GLOBAL_RESULT_BYTES - this.retainedResultBytes();
		request.result = available >= bounded.bytes ? bounded.value : 'Resultado omitido del buffer local por límite global; verifica el efecto antes de repetir.';
		request.resultBytes = available >= bounded.bytes ? bounded.bytes : Buffer.byteLength(String(request.result), 'utf8');
		request.resultTruncated = bounded.truncated || available < bounded.bytes;
		request.state = 'succeeded';
		request.finishedAt = Date.now();
		await this.checkpoint(request);
		return request;
	}

	async fail(id: string, error: unknown, uncertain = false): Promise<WebAiRequestRecord> {
		const request = this.get(id);
		if (!request) throw new Error('La solicitud ya no existe.');
		request.state = uncertain ? 'uncertain' : 'failed';
		request.error = error instanceof Error ? error.message : String(error);
		request.finishedAt = Date.now();
		await this.checkpoint(request);
		return request;
	}

	async cancel(id: string): Promise<{ request: WebAiRequestRecord; interrupted: boolean }> {
		const request = this.get(id);
		if (!request) throw new Error('La solicitud ya no existe.');
		if (request.state === 'pending-approval' || request.state === 'queued') {
			request.state = 'cancelled';
			request.error = 'Cancelada antes de iniciar.';
			request.finishedAt = Date.now();
			await this.checkpoint(request);
			return { request, interrupted: true };
		}
		return { request, interrupted: false };
	}

	async stopPending(): Promise<void> {
		for (const request of this.requests.values()) {
			if (request.state === 'pending-approval' || request.state === 'queued') {
				request.state = 'cancelled';
				request.error = 'IA web local se detuvo antes de ejecutar la solicitud.';
				request.finishedAt = Date.now();
				request.updatedAt = Date.now();
				this.journal.set(request.idempotencyKey, this.toJournal(request));
			} else if (request.state === 'running') {
				request.state = 'uncertain';
				request.error = 'IA web local se detuvo durante la operación; el efecto puede haberse aplicado.';
				request.finishedAt = Date.now();
				request.updatedAt = Date.now();
				this.journal.set(request.idempotencyKey, this.toJournal(request));
			}
		}
		await this.persist();
	}

	summaries(): Array<{ id: string; tool: string; state: WebAiRequestState; createdAt: number; updatedAt: number; durationMs?: number; clientId: string; sessionId: string }> {
		this.cleanupJournal();
		return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map((request) => ({
			id: request.id,
			tool: request.tool,
			state: request.state,
			createdAt: request.createdAt,
			updatedAt: request.updatedAt,
			...(request.startedAt && request.finishedAt ? { durationMs: request.finishedAt - request.startedAt } : {}),
			clientId: request.clientId,
			sessionId: request.sessionId
		}));
	}
}
