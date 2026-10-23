/**
 * Error taxonomy for the whole agent core.
 *
 * Rationale: the router, the recovery loop and the UI all need to react differently to
 * "the provider is rate limited" vs "the model produced an invalid tool call" vs "the user
 * cancelled". Strings are unreliable for that, so every failure carries a stable code.
 */

export const ErrorCode = {
	/** Caller passed something invalid. Not retryable. */
	InvalidArgument: 'invalid_argument',
	/** Feature/endpoint not supported by this provider or platform. Not retryable. */
	Unsupported: 'unsupported',
	/** Requested entity does not exist. */
	NotFound: 'not_found',
	/** Policy or permission refused the operation. */
	Denied: 'denied',
	/** Operation aborted through a cancellation signal. */
	Cancelled: 'cancelled',
	/** Operation exceeded its time budget. Retryable. */
	Timeout: 'timeout',
	/** Provider returned HTTP 429 or an explicit rate-limit signal. Retryable with backoff. */
	RateLimited: 'rate_limited',
	/** Provider credentials missing/invalid. Not retryable without user action. */
	Unauthorized: 'unauthorized',
	/** Provider returned 5xx or an unusable transport error. Retryable. */
	ProviderUnavailable: 'provider_unavailable',
	/** Provider replied with a body we cannot parse into our normalized stream. */
	ProtocolError: 'protocol_error',
	/** Budget/quota exhausted locally. Not retryable until reset. */
	QuotaExceeded: 'quota_exceeded',
	/** The model emitted a malformed tool call / invalid arguments. Retryable by re-prompting. */
	InvalidToolCall: 'invalid_tool_call',
	/** A tool failed while executing. */
	ToolFailure: 'tool_failure',
	/** Patch could not be applied because the file no longer matches. */
	PatchConflict: 'patch_conflict',
	/** Requested path escapes the workspace boundary. */
	OutsideWorkspace: 'outside_workspace',
	/** Persistent store failure. */
	StorageError: 'storage_error',
	/** Anything we did not classify. */
	Internal: 'internal'
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const RETRYABLE = new Set<ErrorCode>([
	ErrorCode.Timeout,
	ErrorCode.RateLimited,
	ErrorCode.ProviderUnavailable,
	ErrorCode.ProtocolError
]);

export interface ForjaErrorOptions {
	readonly code?: ErrorCode;
	readonly cause?: unknown;
	/** Extra machine-readable detail. Must never contain secrets. */
	readonly data?: Record<string, unknown>;
	/** Overrides the default retryability of the code. */
	readonly retryable?: boolean;
	/** Seconds the provider asked us to wait, when known. */
	readonly retryAfterSeconds?: number;
}

export class ForjaError extends Error {
	readonly code: ErrorCode;
	readonly data: Record<string, unknown>;
	readonly retryAfterSeconds: number | undefined;
	private readonly retryableOverride: boolean | undefined;

	constructor(message: string, options: ForjaErrorOptions = {}) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'ForjaError';
		this.code = options.code ?? ErrorCode.Internal;
		this.data = options.data ?? {};
		this.retryableOverride = options.retryable;
		this.retryAfterSeconds = options.retryAfterSeconds;
	}

	get retryable(): boolean {
		return this.retryableOverride ?? RETRYABLE.has(this.code);
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			retryable: this.retryable,
			...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
			...(Object.keys(this.data).length > 0 ? { data: this.data } : {})
		};
	}

	static is(value: unknown): value is ForjaError {
		return value instanceof ForjaError;
	}

	/** Normalizes anything thrown into a ForjaError without losing the original. */
	static from(value: unknown, fallbackCode: ErrorCode = ErrorCode.Internal): ForjaError {
		if (value instanceof ForjaError) {
			return value;
		}
		if (isAbortError(value)) {
			return new ForjaError('Operation cancelled', { code: ErrorCode.Cancelled, cause: value });
		}
		if (value instanceof Error) {
			return new ForjaError(value.message, { code: mapNodeError(value, fallbackCode), cause: value });
		}
		return new ForjaError(String(value), { code: fallbackCode, cause: value });
	}
}

function mapNodeError(error: Error, fallback: ErrorCode): ErrorCode {
	const code = (error as NodeJS.ErrnoException).code;
	switch (code) {
		case 'ENOENT':
			return ErrorCode.NotFound;
		case 'EACCES':
		case 'EPERM':
			return ErrorCode.Denied;
		case 'ETIMEDOUT':
		case 'UND_ERR_HEADERS_TIMEOUT':
		case 'UND_ERR_BODY_TIMEOUT':
		case 'UND_ERR_CONNECT_TIMEOUT':
			return ErrorCode.Timeout;
		case 'ECONNREFUSED':
		case 'ECONNRESET':
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
		case 'EPIPE':
			return ErrorCode.ProviderUnavailable;
		default:
			return fallback;
	}
}

export function isAbortError(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const name = (value as { name?: unknown }).name;
	return name === 'AbortError' || name === 'TimeoutError';
}

export function isCancellation(value: unknown): boolean {
	return isAbortError(value) || (ForjaError.is(value) && value.code === ErrorCode.Cancelled);
}

/** Convenience constructors used all over the codebase. */
export const errors = {
	invalidArgument(message: string, data?: Record<string, unknown>): ForjaError {
		return new ForjaError(message, { code: ErrorCode.InvalidArgument, ...(data ? { data } : {}) });
	},
	unsupported(message: string, data?: Record<string, unknown>): ForjaError {
		return new ForjaError(message, { code: ErrorCode.Unsupported, ...(data ? { data } : {}) });
	},
	notFound(message: string, data?: Record<string, unknown>): ForjaError {
		return new ForjaError(message, { code: ErrorCode.NotFound, ...(data ? { data } : {}) });
	},
	denied(message: string, data?: Record<string, unknown>): ForjaError {
		return new ForjaError(message, { code: ErrorCode.Denied, ...(data ? { data } : {}) });
	},
	cancelled(message = 'Operation cancelled'): ForjaError {
		return new ForjaError(message, { code: ErrorCode.Cancelled });
	},
	timeout(message: string, data?: Record<string, unknown>): ForjaError {
		return new ForjaError(message, { code: ErrorCode.Timeout, ...(data ? { data } : {}) });
	},
	outsideWorkspace(message: string, data?: Record<string, unknown>): ForjaError {
		return new ForjaError(message, { code: ErrorCode.OutsideWorkspace, ...(data ? { data } : {}) });
	},
	internal(message: string, cause?: unknown): ForjaError {
		return new ForjaError(message, { code: ErrorCode.Internal, cause });
	}
};
