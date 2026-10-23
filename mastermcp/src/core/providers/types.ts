/**
 * Provider Abstraction Layer contracts.
 *
 * THE RULE (brief §7): the agent runtime imports from this file and nothing else provider-shaped.
 * It must never know whether the bytes on the wire were OpenAI, Anthropic, Gemini or a homemade
 * gateway. Every adapter normalizes into `ProviderEvent`.
 */

/** Wire protocols we can speak. Extensible: adding one means adding an adapter, nothing else. */
export const Protocol = {
	OpenAIChat: 'openai-chat',
	OpenAIResponses: 'openai-responses',
	Anthropic: 'anthropic-messages',
	Gemini: 'gemini-generate',
	Mock: 'mock'
} as const;

export type ProtocolId = (typeof Protocol)[keyof typeof Protocol];

export const ALL_PROTOCOLS: readonly ProtocolId[] = [
	Protocol.OpenAIChat,
	Protocol.OpenAIResponses,
	Protocol.Anthropic,
	Protocol.Gemini,
	Protocol.Mock
];

export function isProtocolId(value: unknown): value is ProtocolId {
	return typeof value === 'string' && (ALL_PROTOCOLS as readonly string[]).includes(value);
}

/** Role of a message in the conversation sent to the provider. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
	readonly type: 'text';
	readonly text: string;
	/** When true, adapters may mark this block as cacheable (Anthropic cache_control etc.). */
	readonly cacheable?: boolean;
}

export interface ImagePart {
	readonly type: 'image';
	/** Base64 payload without the data: prefix. */
	readonly data: string;
	readonly mimeType: string;
}

export interface ToolCallPart {
	readonly type: 'tool-call';
	readonly callId: string;
	readonly name: string;
	/** Parsed arguments. Adapters are responsible for turning provider JSON strings into this. */
	readonly args: Record<string, unknown>;
	/** Raw argument text, kept for debugging malformed calls. */
	readonly rawArgs?: string;
}

export interface ToolResultPart {
	readonly type: 'tool-result';
	readonly callId: string;
	readonly name: string;
	readonly content: string;
	readonly isError?: boolean;
}

export interface ReasoningPart {
	readonly type: 'reasoning';
	readonly text: string;
	/** Opaque provider token (Anthropic signature, OpenAI encrypted item) to replay reasoning. */
	readonly signature?: string;
	readonly redacted?: boolean;
}

export type MessagePart = TextPart | ImagePart | ToolCallPart | ToolResultPart | ReasoningPart;

export interface ProviderMessage {
	readonly role: MessageRole;
	readonly parts: readonly MessagePart[];
	/** Optional stable id, used for prompt-cache prefix stability and dedup. */
	readonly id?: string;
}

export interface ToolSchema {
	readonly name: string;
	readonly description: string;
	/** JSON Schema (draft 2020-12 subset) describing the arguments object. */
	readonly parameters: Record<string, unknown>;
}

export type ToolChoice =
	| { readonly type: 'auto' }
	| { readonly type: 'none' }
	| { readonly type: 'required' }
	| { readonly type: 'tool'; readonly name: string };

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface CompletionRequest {
	readonly modelId: string;
	/** System instructions kept separate so adapters can place them where the protocol wants and
	 *  so prompt caching sees a stable prefix (§63). */
	readonly system?: readonly TextPart[];
	readonly messages: readonly ProviderMessage[];
	readonly tools?: readonly ToolSchema[];
	readonly toolChoice?: ToolChoice;
	readonly maxOutputTokens?: number;
	readonly temperature?: number;
	readonly topP?: number;
	readonly stopSequences?: readonly string[];
	readonly reasoning?: { readonly effort?: ReasoningEffort; readonly maxTokens?: number };
	/** Ask the adapter to enable provider-side prompt caching when available. */
	readonly enableCaching?: boolean;
	/** Free-form protocol passthrough for provider-specific knobs the user configured. */
	readonly extraBody?: Record<string, unknown>;
	/** Correlation id for logs and the request inspector. */
	readonly requestId?: string;
	readonly timeoutMs?: number;
}

export interface TokenUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly reasoningTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	/** True when the numbers came from the provider rather than from our estimator (§53). */
	readonly measured: boolean;
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, measured: false };

export type FinishReason =
	| 'stop'
	| 'length'
	| 'tool-calls'
	| 'content-filter'
	| 'cancelled'
	| 'error';

export interface TextDeltaEvent {
	readonly type: 'text-delta';
	readonly text: string;
}

export interface ReasoningDeltaEvent {
	readonly type: 'reasoning-delta';
	readonly text: string;
	readonly signature?: string;
	readonly redacted?: boolean;
}

/** Emitted when a tool call is fully assembled and parsed. Partial deltas are internal. */
export interface ToolCallEvent {
	readonly type: 'tool-call';
	readonly call: ToolCallPart;
}

/** Emitted when the model is streaming tool-call arguments; UI-only, never acted upon. */
export interface ToolCallDeltaEvent {
	readonly type: 'tool-call-delta';
	readonly callId: string;
	readonly name?: string;
	readonly argsDelta: string;
}

export interface UsageEvent {
	readonly type: 'usage';
	readonly usage: TokenUsage;
}

export interface FinishEvent {
	readonly type: 'finish';
	readonly reason: FinishReason;
	readonly usage: TokenUsage;
	/** Provider's own model identifier as echoed back, useful when gateways rewrite it. */
	readonly modelId?: string;
}

export interface ProviderErrorEvent {
	readonly type: 'error';
	readonly message: string;
	readonly code: string;
	readonly retryable: boolean;
	readonly status?: number;
	readonly retryAfterSeconds?: number;
}

export type ProviderEvent =
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| ToolCallEvent
	| ToolCallDeltaEvent
	| UsageEvent
	| FinishEvent
	| ProviderErrorEvent;

export interface CompletionResult {
	readonly text: string;
	readonly reasoning?: string;
	readonly toolCalls: readonly ToolCallPart[];
	readonly usage: TokenUsage;
	readonly finishReason: FinishReason;
	readonly modelId: string;
	readonly latencyMs: number;
}

export interface ModelCapabilities {
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly supportsTools: boolean;
	readonly supportsStreaming: boolean;
	readonly supportsVision: boolean;
	readonly supportsReasoning: boolean;
	readonly supportsPromptCaching: boolean;
	readonly supportsParallelToolCalls: boolean;
	readonly supportsSystemPrompt: boolean;
	readonly supportsTemperature: boolean;
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
	contextWindow: 128_000,
	maxOutputTokens: 8_192,
	supportsTools: true,
	supportsStreaming: true,
	supportsVision: false,
	supportsReasoning: false,
	supportsPromptCaching: false,
	supportsParallelToolCalls: true,
	supportsSystemPrompt: true,
	supportsTemperature: true
};

/** A model as reported by a provider's list endpoint. Everything except the id is best-effort. */
export interface DiscoveredModel {
	readonly id: string;
	readonly displayName?: string;
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly capabilities?: Partial<ModelCapabilities>;
	readonly createdAt?: number;
	readonly raw?: Record<string, unknown>;
}

export interface HealthReport {
	readonly ok: boolean;
	readonly latencyMs: number;
	readonly detail: string;
	/** Populated when the health check could also enumerate models. */
	readonly models?: readonly DiscoveredModel[];
	readonly checkedAt: number;
}

export interface TokenCountInput {
	readonly modelId: string;
	readonly system?: readonly TextPart[];
	readonly messages: readonly ProviderMessage[];
	readonly tools?: readonly ToolSchema[];
}

/**
 * Tolerance switches for the fact that "OpenAI compatible" means different things everywhere
 * (§94). Users can flip these per provider; adapters must honour them.
 */
export interface ProviderQuirks {
	/** Never send a `tools` array (gateway 400s on it). */
	readonly noTools?: boolean;
	/** Send system content as a leading user message instead of a system message. */
	readonly systemAsUser?: boolean;
	/** Omit `temperature`/`top_p` (reasoning-only endpoints reject them). */
	readonly noSamplingParams?: boolean;
	/** Use `max_tokens` instead of `max_completion_tokens` (older OpenAI-compatible servers). */
	readonly legacyMaxTokens?: boolean;
	/** Do not request `stream_options.include_usage`. */
	readonly noStreamUsage?: boolean;
	/** Provider cannot stream at all; emulate a stream from the non-streaming call. */
	readonly noStreaming?: boolean;
	/** Provider rejects multiple tool calls per turn. */
	readonly singleToolCall?: boolean;
	/** Merge consecutive same-role messages (some servers reject them). */
	readonly mergeConsecutiveRoles?: boolean;
	/** Path appended to the base URL for chat completions. Default `/chat/completions`. */
	readonly chatPath?: string;
	/** Path for model listing. Default `/models`. Empty string disables discovery. */
	readonly modelsPath?: string;
	/** Field name carrying reasoning text in deltas (e.g. `reasoning_content`). */
	readonly reasoningField?: string;
	/** Send `"stream": true` in the body even for non-SSE endpoints. */
	readonly forceStreamFlag?: boolean;
	/** Strip JSON-Schema keywords the server chokes on. */
	readonly simplifyToolSchema?: boolean;
}

export interface ProviderRuntimeConfig {
	readonly id: string;
	readonly name: string;
	readonly protocol: ProtocolId;
	readonly baseUrl: string;
	/** Resolved secret. Never persisted here; injected at construction time. */
	readonly apiKey?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly query?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
	readonly maxRetries?: number;
	readonly quirks?: ProviderQuirks;
	/** Extra body fields merged into every request (e.g. `{ provider: { order: [...] } }`). */
	readonly extraBody?: Readonly<Record<string, unknown>>;
	/** Capability defaults for models of this provider, before per-model overrides. */
	readonly defaultCapabilities?: Partial<ModelCapabilities>;
}

/** What the request inspector shows in Developer Mode (§95). Key is already stripped. */
export interface NormalizedRequestSnapshot {
	readonly requestId: string;
	readonly providerId: string;
	readonly protocol: ProtocolId;
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
	readonly startedAt: number;
}

export interface NormalizedResponseSnapshot {
	readonly requestId: string;
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly latencyMs: number;
	readonly usage?: TokenUsage;
	readonly finishReason?: FinishReason;
	readonly errorMessage?: string;
	/** Present for non-streaming or captured stream tails; truncated. */
	readonly bodyPreview?: string;
}

export interface ProviderObserver {
	onRequest?(snapshot: NormalizedRequestSnapshot): void;
	onResponse?(snapshot: NormalizedResponseSnapshot): void;
}

/**
 * The only provider-facing interface the runtime knows about.
 * Implementations live in `src/providers/<protocol>.ts`.
 */
export interface ModelProvider {
	readonly id: string;
	readonly name: string;
	readonly protocol: ProtocolId;

	/** Streaming completion. MUST end with exactly one `finish` or one `error` event. */
	streamMessage(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;

	/** Non-streaming convenience. Default implementation folds `streamMessage`. */
	sendMessage(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;

	estimateTokens(input: TokenCountInput): number | Promise<number>;

	getCapabilities(modelId: string): ModelCapabilities;

	/** Best-effort discovery. Throws `ErrorCode.Unsupported` when the provider has no endpoint. */
	listModels(signal?: AbortSignal): Promise<readonly DiscoveredModel[]>;

	healthCheck(signal?: AbortSignal): Promise<HealthReport>;

	dispose?(): void;
}
