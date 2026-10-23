/**
 * Minimal event + cancellation primitives.
 *
 * We deliberately do not depend on Node's EventEmitter: the agent runtime needs typed, single-topic
 * emitters that never throw into the caller when one listener misbehaves, plus a cancellation model
 * that interoperates with `AbortSignal` (which every provider request needs anyway).
 */

export type Listener<T> = (event: T) => void;

export interface Disposable {
	dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
	let disposed = false;
	return {
		dispose() {
			if (!disposed) {
				disposed = true;
				fn();
			}
		}
	};
}

export class DisposableStore implements Disposable {
	private readonly items = new Set<Disposable>();
	private disposed = false;

	add<T extends Disposable>(item: T): T {
		if (this.disposed) {
			item.dispose();
			return item;
		}
		this.items.add(item);
		return item;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const item of this.items) {
			try {
				item.dispose();
			} catch {
				// A failing dispose must not prevent the rest from being cleaned up.
			}
		}
		this.items.clear();
	}
}

export type Event<T> = (listener: Listener<T>) => Disposable;

export class Emitter<T> {
	private listeners: Listener<T>[] = [];
	private onError: ((error: unknown) => void) | undefined;

	constructor(options?: { onListenerError?: (error: unknown) => void }) {
		this.onError = options?.onListenerError;
	}

	get event(): Event<T> {
		return (listener: Listener<T>) => {
			this.listeners.push(listener);
			return toDisposable(() => {
				const index = this.listeners.indexOf(listener);
				if (index >= 0) {
					this.listeners.splice(index, 1);
				}
			});
		};
	}

	get listenerCount(): number {
		return this.listeners.length;
	}

	fire(event: T): void {
		// Copy so that listeners which unsubscribe during dispatch do not shift the iteration.
		for (const listener of this.listeners.slice()) {
			try {
				listener(event);
			} catch (error) {
				if (this.onError) {
					this.onError(error);
				}
			}
		}
	}

	dispose(): void {
		this.listeners = [];
	}
}

/**
 * A cancellation source that is also an AbortSignal producer, so the same token can be handed to
 * `fetch`, to child processes and to our own loops.
 */
export class CancellationSource {
	private readonly controller = new AbortController();
	private reasonValue: string | undefined;

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get cancelled(): boolean {
		return this.controller.signal.aborted;
	}

	get reason(): string | undefined {
		return this.reasonValue;
	}

	cancel(reason = 'cancelled'): void {
		if (this.controller.signal.aborted) {
			return;
		}
		this.reasonValue = reason;
		this.controller.abort(new DOMException(reason, 'AbortError'));
	}

	/** Cancels when any of the given signals aborts. Returns a disposable to detach. */
	linkTo(...signals: (AbortSignal | undefined)[]): Disposable {
		const store = new DisposableStore();
		for (const signal of signals) {
			if (!signal) {
				continue;
			}
			if (signal.aborted) {
				this.cancel('linked signal already aborted');
				break;
			}
			const onAbort = () => this.cancel('linked signal aborted');
			signal.addEventListener('abort', onAbort, { once: true });
			store.add(toDisposable(() => signal.removeEventListener('abort', onAbort)));
		}
		return store;
	}
}

export function throwIfCancelled(signal: AbortSignal | undefined, message = 'Operation cancelled'): void {
	if (signal?.aborted) {
		throw new DOMException(message, 'AbortError');
	}
}

/** Sleep that rejects on cancellation instead of leaking a timer. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Operation cancelled', 'AbortError'));
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(new DOMException('Operation cancelled', 'AbortError'));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Races a promise against a timeout without leaving the original promise unhandled.
 * Returns the value, or throws a DOMException('TimeoutError').
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
	if (!Number.isFinite(ms) || ms <= 0) {
		return promise;
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new DOMException(`${label} timed out after ${ms}ms`, 'TimeoutError')), ms);
			})
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}
