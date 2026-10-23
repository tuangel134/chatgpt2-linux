export const WEB_AI_PROTOCOL_VERSION = 1 as const;
export const WEB_AI_DEFAULT_PORT = 48_761;
export const WEB_AI_MAX_BODY_BYTES = 256 * 1024;
export const WEB_AI_PAIR_TTL_MS = 2 * 60_000;
export const WEB_AI_SESSION_TTL_MS = 15 * 60_000;
export const WEB_AI_APPROVAL_TTL_MS = 2 * 60_000;
export const WEB_AI_EXECUTION_TIMEOUT_MS = 2 * 60_000;
export const WEB_AI_RESULT_TTL_MS = 10 * 60_000;
export const WEB_AI_MAX_RESULT_BYTES = 256 * 1024;
export const WEB_AI_MAX_GLOBAL_RESULT_BYTES = 10 * 1024 * 1024;
export const WEB_AI_MAX_SESSIONS = 16;
export const WEB_AI_MAX_QUEUED_PER_CLIENT = 20;
export const WEB_AI_MAX_QUEUED_GLOBAL = 100;
export const WEB_AI_MAX_RUNNING_GLOBAL = 2;

export type WebAiProvider = 'qwen' | 'deepseek' | 'integrated' | 'unknown';
export type WebAiRequestState = 'pending-approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';

export interface WebAiSessionDescriptor {
	readonly provider: WebAiProvider;
	readonly tabId: number;
	readonly documentGeneration: string;
	readonly conversationId: string;
	readonly workspaceId: string;
	readonly autoSend?: boolean;
}

export interface WebAiCallEnvelope {
	readonly v: 1;
	readonly id: string;
	readonly messageId: string;
	readonly tool: string;
	readonly arguments: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidExtensionOrigin(value: string | undefined): value is string {
	if (typeof value !== 'string') return false;
	if (/^chrome-extension:\/\/[a-p]{32}$/.test(value)) return true;
	return /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isLoopbackHost(value: string | undefined, port: number): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}` || normalized === `[::1]:${port}`;
}

export function boundedPort(value: unknown, fallback = WEB_AI_DEFAULT_PORT): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : fallback;
}

export function utf8Bytes(value: unknown): number {
	return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

export function truncateResult(value: unknown): { value: unknown; truncated: boolean; bytes: number } {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	const bytes = Buffer.byteLength(text, 'utf8');
	if (bytes <= WEB_AI_MAX_RESULT_BYTES) return { value, truncated: false, bytes };
	const buffer = Buffer.from(text, 'utf8').subarray(0, WEB_AI_MAX_RESULT_BYTES);
	return {
		value: `${buffer.toString('utf8')}\n… resultado truncado por IA web local; revisa el resultado completo localmente antes de repetir.`,
		truncated: true,
		bytes: WEB_AI_MAX_RESULT_BYTES
	};
}
