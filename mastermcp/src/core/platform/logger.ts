/**
 * Structured, channel-scoped logging with mandatory secret redaction.
 *
 * The brief requires separate observable channels (agent, router, provider, tool, mcp) and an
 * absolute guarantee that secrets never reach the log. Redaction therefore happens inside the
 * logger, not at the call sites, so a forgotten call site cannot leak.
 */

import { appendFile, mkdir, stat, rename, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { redactForLog } from '../security/secret-scanner.ts';
import { Emitter, type Event } from './events.ts';

export const LogLevel = {
	Trace: 10,
	Debug: 20,
	Info: 30,
	Warn: 40,
	Error: 50,
	Off: 100
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LOG_LEVEL_NAMES: Record<number, string> = {
	10: 'trace',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error'
};

export function parseLogLevel(value: string | undefined, fallback: LogLevel = LogLevel.Info): LogLevel {
	switch ((value ?? '').toLowerCase()) {
		case 'trace': return LogLevel.Trace;
		case 'debug': return LogLevel.Debug;
		case 'info': return LogLevel.Info;
		case 'warn': case 'warning': return LogLevel.Warn;
		case 'error': return LogLevel.Error;
		case 'off': case 'none': return LogLevel.Off;
		default: return fallback;
	}
}

/** Channels map 1:1 to the observability requirement (§57). */
export const LogChannel = {
	Agent: 'agent',
	Router: 'router',
	Provider: 'provider',
	Tool: 'tool',
	Mcp: 'mcp',
	Context: 'context',
	Storage: 'storage',
	Security: 'security',
	Daemon: 'daemon',
	Cli: 'cli',
	Ide: 'ide'
} as const;

export type LogChannel = (typeof LogChannel)[keyof typeof LogChannel];

export interface LogRecord {
	readonly time: number;
	readonly level: LogLevel;
	readonly channel: string;
	readonly message: string;
	readonly data?: Record<string, unknown>;
	readonly sessionId?: string;
}

export interface LogSink {
	write(record: LogRecord): void;
	flush?(): Promise<void>;
	dispose?(): void;
}

/** Serializes an unknown value for logging: bounded, redacted, never throwing. */
function serializeValue(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) {
		return value;
	}
	switch (typeof value) {
		case 'string':
			return redactForLog(value.length > 2000 ? `${value.slice(0, 2000)}…(${value.length})` : value);
		case 'number':
		case 'boolean':
			return value;
		case 'bigint':
			return value.toString();
		case 'function':
			return '[function]';
		case 'symbol':
			return value.toString();
		default:
			break;
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactForLog(value.message),
			...(typeof (value as unknown as { code?: unknown }).code === 'string'
				? { code: (value as unknown as { code: string }).code }
				: {}),
			stack: value.stack ? redactForLog(value.stack.split('\n').slice(0, 8).join('\n')) : undefined
		};
	}
	if (depth >= 4) {
		return '[depth-limit]';
	}
	if (Array.isArray(value)) {
		const limited = value.slice(0, 50).map((item) => serializeValue(item, depth + 1));
		return value.length > 50 ? [...limited, `…(${value.length} items)`] : limited;
	}
	if (value instanceof Map) {
		return serializeValue(Object.fromEntries(value), depth + 1);
	}
	if (value instanceof Set) {
		return serializeValue([...value], depth + 1);
	}
	const out: Record<string, unknown> = {};
	let count = 0;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (count++ >= 40) {
			out['…'] = 'truncated';
			break;
		}
		// Never log a field whose *name* says it is a secret, regardless of shape.
		if (/^(api[-_]?key|apikey|authorization|password|passwd|secret|token|credential|private[-_]?key)$/i.test(key)) {
			out[key] = '[REDACTED]';
			continue;
		}
		out[key] = serializeValue(item, depth + 1);
	}
	return out;
}

function formatData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!data || Object.keys(data).length === 0) {
		return undefined;
	}
	return serializeValue(data) as Record<string, unknown>;
}

export class ConsoleSink implements LogSink {
	private readonly stream: { write(chunk: string): unknown };

	constructor(stream: { write(chunk: string): unknown } = process.stderr) {
		this.stream = stream;
	}

	write(record: LogRecord): void {
		const time = new Date(record.time).toISOString().slice(11, 23);
		const level = (LOG_LEVEL_NAMES[record.level] ?? '?').toUpperCase().padEnd(5);
		let line = `${time} ${level} [${record.channel}] ${record.message}`;
		if (record.data) {
			try {
				line += ` ${JSON.stringify(record.data)}`;
			} catch {
				line += ' [unserializable data]';
			}
		}
		this.stream.write(`${line}\n`);
	}
}

/** Newline-delimited JSON file sink with size-based rotation. */
export class FileSink implements LogSink {
	private queue: string[] = [];
	private writing = false;
	private disposed = false;
	private bytesWritten = 0;
	private initialized = false;

	private readonly filePath: string;
	private readonly maxBytes: number;
	private readonly maxFiles: number;

	constructor(filePath: string, maxBytes = 8 * 1024 * 1024, maxFiles = 4) {
		this.filePath = filePath;
		this.maxBytes = maxBytes;
		this.maxFiles = maxFiles;
	}

	write(record: LogRecord): void {
		if (this.disposed) {
			return;
		}
		try {
			this.queue.push(`${JSON.stringify(record)}\n`);
		} catch {
			this.queue.push(`${JSON.stringify({ ...record, data: undefined })}\n`);
		}
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.writing || this.queue.length === 0) {
			return;
		}
		this.writing = true;
		try {
			if (!this.initialized) {
				await mkdir(dirname(this.filePath), { recursive: true });
				this.bytesWritten = await stat(this.filePath).then((s) => s.size).catch(() => 0);
				this.initialized = true;
			}
			while (this.queue.length > 0) {
				const chunk = this.queue.join('');
				this.queue = [];
				await appendFile(this.filePath, chunk, 'utf8');
				this.bytesWritten += Buffer.byteLength(chunk);
				if (this.bytesWritten >= this.maxBytes) {
					await this.rotate();
				}
			}
		} catch {
			// Logging must never break the product. Drop the batch.
			this.queue = [];
		} finally {
			this.writing = false;
		}
	}

	private async rotate(): Promise<void> {
		try {
			await rename(this.filePath, `${this.filePath}.${Date.now()}`);
			this.bytesWritten = 0;
			const dir = dirname(this.filePath);
			const base = this.filePath.slice(dir.length + 1);
			const rotated = (await readdir(dir))
				.filter((name) => name.startsWith(`${base}.`))
				.sort()
				.reverse();
			for (const stale of rotated.slice(this.maxFiles)) {
				await unlink(join(dir, stale)).catch(() => undefined);
			}
		} catch {
			this.bytesWritten = 0;
		}
	}

	async flush(): Promise<void> {
		await this.drain();
	}

	dispose(): void {
		this.disposed = true;
	}
}

export class MemorySink implements LogSink {
	readonly records: LogRecord[] = [];
	private readonly limit: number;
	constructor(limit = 2000) {
		this.limit = limit;
	}
	write(record: LogRecord): void {
		this.records.push(record);
		if (this.records.length > this.limit) {
			this.records.splice(0, this.records.length - this.limit);
		}
	}
	clear(): void {
		this.records.length = 0;
	}
}

export interface Logger {
	readonly channel: string;
	trace(message: string, data?: Record<string, unknown>): void;
	debug(message: string, data?: Record<string, unknown>): void;
	info(message: string, data?: Record<string, unknown>): void;
	warn(message: string, data?: Record<string, unknown>): void;
	error(message: string, data?: Record<string, unknown>): void;
	child(suffix: string): Logger;
	scoped(context: Record<string, unknown>): Logger;
}

export class LogService {
	private readonly sinks: LogSink[] = [];
	private readonly channelLevels = new Map<string, LogLevel>();
	private readonly onDidLogEmitter = new Emitter<LogRecord>();
	private level: LogLevel;

	constructor(level: LogLevel = LogLevel.Info, sinks: LogSink[] = []) {
		this.level = level;
		this.sinks.push(...sinks);
	}

	get onDidLog(): Event<LogRecord> {
		return this.onDidLogEmitter.event;
	}

	addSink(sink: LogSink): void {
		this.sinks.push(sink);
	}

	setLevel(level: LogLevel, channel?: string): void {
		if (channel) {
			this.channelLevels.set(channel, level);
		} else {
			this.level = level;
		}
	}

	getLevel(channel?: string): LogLevel {
		if (channel) {
			// Longest matching prefix wins so `agent.session` inherits `agent`.
			let best: LogLevel | undefined;
			let bestLength = -1;
			for (const [key, value] of this.channelLevels) {
				if ((channel === key || channel.startsWith(`${key}.`)) && key.length > bestLength) {
					best = value;
					bestLength = key.length;
				}
			}
			if (best !== undefined) {
				return best;
			}
		}
		return this.level;
	}

	isEnabled(level: LogLevel, channel: string): boolean {
		return level >= this.getLevel(channel);
	}

	log(level: LogLevel, channel: string, message: string, data?: Record<string, unknown>, sessionId?: string): void {
		if (!this.isEnabled(level, channel)) {
			return;
		}
		const record: LogRecord = {
			time: Date.now(),
			level,
			channel,
			message: redactForLog(message),
			...(formatData(data) ? { data: formatData(data) } : {}),
			...(sessionId ? { sessionId } : {})
		};
		for (const sink of this.sinks) {
			try {
				sink.write(record);
			} catch {
				// ignore sink failures
			}
		}
		this.onDidLogEmitter.fire(record);
	}

	logger(channel: string, context?: Record<string, unknown>): Logger {
		return new ChannelLogger(this, channel, context);
	}

	async flush(): Promise<void> {
		await Promise.all(this.sinks.map((sink) => sink.flush?.() ?? Promise.resolve()));
	}

	dispose(): void {
		for (const sink of this.sinks) {
			sink.dispose?.();
		}
		this.onDidLogEmitter.dispose();
	}
}

class ChannelLogger implements Logger {
	private readonly service: LogService;
	readonly channel: string;
	private readonly context: Record<string, unknown> | undefined;

	constructor(service: LogService, channel: string, context?: Record<string, unknown>) {
		this.service = service;
		this.channel = channel;
		this.context = context;
	}

	private merge(data?: Record<string, unknown>): Record<string, unknown> | undefined {
		if (!this.context) {
			return data;
		}
		return { ...this.context, ...(data ?? {}) };
	}

	private sessionId(): string | undefined {
		const value = this.context?.['sessionId'];
		return typeof value === 'string' ? value : undefined;
	}

	trace(message: string, data?: Record<string, unknown>): void {
		this.service.log(LogLevel.Trace, this.channel, message, this.merge(data), this.sessionId());
	}
	debug(message: string, data?: Record<string, unknown>): void {
		this.service.log(LogLevel.Debug, this.channel, message, this.merge(data), this.sessionId());
	}
	info(message: string, data?: Record<string, unknown>): void {
		this.service.log(LogLevel.Info, this.channel, message, this.merge(data), this.sessionId());
	}
	warn(message: string, data?: Record<string, unknown>): void {
		this.service.log(LogLevel.Warn, this.channel, message, this.merge(data), this.sessionId());
	}
	error(message: string, data?: Record<string, unknown>): void {
		this.service.log(LogLevel.Error, this.channel, message, this.merge(data), this.sessionId());
	}
	child(suffix: string): Logger {
		return new ChannelLogger(this.service, `${this.channel}.${suffix}`, this.context);
	}
	scoped(context: Record<string, unknown>): Logger {
		return new ChannelLogger(this.service, this.channel, this.merge(context));
	}
}

/** A logger that discards everything — handy in tests and library defaults. */
export const nullLogger: Logger = {
	channel: 'null',
	trace() {}, debug() {}, info() {}, warn() {}, error() {},
	child() { return nullLogger; },
	scoped() { return nullLogger; }
};
