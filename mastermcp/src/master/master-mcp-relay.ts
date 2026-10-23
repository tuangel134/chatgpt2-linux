import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ID_PATTERN, KEY_PATTERN, REQUEST_LIMIT, RESPONSE_LIMIT, REQUEST_HEADERS, RESPONSE_HEADERS, boundedFetchBody, decodeBody, filteredHeaders, permittedRoute, type RelayRequest } from '../relay/protocol.ts';

export function validateRelayUrl(raw: string, allowLoopback = false): { publicUrl: string; agentUrl: string } {
  const url = new URL(raw);
  const parts = url.pathname.replace(/\/$/, '').split('/');
  if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.search || url.hash || parts.length !== 4 || parts[1] !== 'lite-relay' || parts[2] !== 'i' || !ID_PATTERN.test(parts[3])) throw new Error('Usa la URL HTTPS de instalación del relay: /lite-relay/i/identificador.');
  return { publicUrl: `${url.origin}${parts.join('/')}`, agentUrl: `${url.origin}/lite-relay/agent/${parts[3]}` };
}

/**
 * Deliver responses over a fresh socket.  The relay's poll and public MCP
 * request can remain open for a long time; reusing the same fetch pool for
 * this acknowledgement can deadlock behind an HTTP proxy.  This function
 * never retries the POST because a completed write must not be replayed.
 */
function relayRequest(url: string, key: string, method: 'GET' | 'POST', payload: string | undefined, signal: AbortSignal, maxResponseBytes = Math.ceil(REQUEST_LIMIT / 3) * 4 + 32768, timeoutMs = 15_000): Promise<{ status: number; body: Buffer }> {
	const target = new URL(url);
	const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, result?: { status: number; body: Buffer }) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			if (error) reject(error); else resolve(result ?? { status: 0, body: Buffer.alloc(0) });
		};
		const onAbort = () => finish(new Error('Relay delivery aborted.'));
		if (signal.aborted) return onAbort();
		const request = requestFn({
			protocol: target.protocol,
			hostname: target.hostname,
			port: target.port || undefined,
			path: `${target.pathname}${target.search}`,
			method,
			agent: false,
			headers: {
				authorization: `Bearer ${key}`,
				...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
				connection: 'close'
			}
		}, (response) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxResponseBytes) response.destroy(new Error('Relay response is too large.'));
				else chunks.push(chunk);
			});
			response.once('error', (error) => finish(error));
			response.once('end', () => finish(undefined, { status: response.statusCode ?? 0, body: Buffer.concat(chunks, size) }));
		});
		request.once('error', (error) => finish(error));
		request.setTimeout(timeoutMs, () => request.destroy(new Error('Relay request timed out.')));
		signal.addEventListener('abort', onAbort, { once: true });
		request.end(payload);
	});
}

function postResponse(url: string, key: string, payload: string, signal: AbortSignal): Promise<number> {
	return relayRequest(url, key, 'POST', payload, signal, 64 * 1024).then((result) => result.status);
}

export class MasterMcpRelay {
  private controller?: AbortController;
  private loop?: Promise<void>;
  private readonly active = new Set<Promise<void>>();
  private connected = false;
  private error?: string;
  private publicUrl?: string;
  private agentUrl?: string;
  private key?: string;
  private localUrl?: string;
  private failures = 0;
  private received = 0;
  private delivered = 0;
  private stage = 'idle';
  constructor(private readonly allowLoopback = false) {}

  status() { return { running: !!this.controller, connected: this.connected, publicUrl: this.publicUrl, error: this.error, inFlight: this.active.size, received: this.received, delivered: this.delivered, stage: this.stage }; }

  async start(rawUrl: string, key: string, localUrl: string): Promise<string> {
    const { publicUrl, agentUrl } = validateRelayUrl(rawUrl, this.allowLoopback);
    if (!KEY_PATTERN.test(key)) throw new Error('La clave privada del relay debe tener 43 caracteres.');
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(localUrl)) throw new Error('Relay destination must be the local MCP loopback server.');
    await this.stop();
    // Verify enrollment before reporting a usable public endpoint.
		const check = await relayRequest(`${agentUrl}/metrics`, key, 'GET', undefined, AbortSignal.timeout(10_000), 64 * 1024, 10_000);
		if (check.status < 200 || check.status >= 300) throw new Error(`El relay rechazó la conexión (HTTP ${check.status}). Revisa la URL y la clave de esta instalación.`);
    this.publicUrl = publicUrl; this.agentUrl = agentUrl; this.key = key; this.localUrl = localUrl;
    this.error = undefined; this.failures = 0; this.connected = true;
    this.controller = new AbortController();
    this.loop = this.poll(this.controller.signal);
    return publicUrl;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (this.active.size >= 4) await Promise.race(this.active);
        if (signal.aborted) break;
			const agentUrl = this.agentUrl;
			const key = this.key;
			if (!agentUrl || !key) throw new Error('Relay is not configured.');
			const response = await relayRequest(`${agentUrl}/poll`, key, 'GET', undefined, AbortSignal.any([signal, AbortSignal.timeout(35_000)]), Math.ceil(REQUEST_LIMIT / 3) * 4 + 32768, 35_000);
			if (response.status < 200 || response.status >= 300) {
				if (response.status === 401 || response.status === 403) { this.error = 'La credencial del relay fue revocada. Actualízala para reconectar.'; this.connected = false; break; }
				throw new Error(`HTTP ${response.status}`);
			}
			const input = JSON.parse(response.body.toString()) as RelayRequest | null;
        this.connected = true; this.error = undefined; this.failures = 0;
        if (input) {
          this.received++;
          const operation = this.forward(input, signal).catch(() => { this.error = 'Una petición no pudo completarse. Comprueba su resultado antes de repetirla.'; }).finally(() => this.active.delete(operation));
          this.active.add(operation);
        }
      } catch {
        if (signal.aborted) break;
        this.connected = false;
        this.error = 'Relay desconectado; reintentando automáticamente sin repetir herramientas.';
        this.failures++;
        await delay(Math.min(15_000, 500 * 2 ** Math.min(this.failures, 5)) + Math.random() * 300, undefined, { signal }).catch(() => undefined);
      }
    }
    this.connected = false;
  }

  private async forward(input: RelayRequest, signal: AbortSignal): Promise<void> {
    if (!input || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || !permittedRoute(input.method, input.path) || !input.headers || typeof input.headers !== 'object') throw new Error('Relay request rejected.');
    const body = decodeBody(input.body, REQUEST_LIMIT);
    const headers = filteredHeaders(input.headers, REQUEST_HEADERS);
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(80_000)]);
    let status = 502;
    let resultHeaders: Record<string, string> = { 'content-type': 'application/json' };
    let result = Buffer.from(JSON.stringify({ error: 'Lite could not complete this request. Check the result before retrying a write.' }));
    try {
      this.stage = 'local-request';
      const response = await fetch(`${this.localUrl}${input.path}`, { method: input.method, headers, ...(input.method === 'POST' ? { body: new Uint8Array(body) } : {}), redirect: 'manual', signal: timeout });
      this.stage = 'local-response';
      status = response.status;
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => { responseHeaders[name] = value; });
      resultHeaders = filteredHeaders(responseHeaders, RESPONSE_HEADERS);
      result = await boundedFetchBody(response, RESPONSE_LIMIT);
    } catch { status = 502; resultHeaders = { 'content-type': 'application/json' }; /* No sensitive error contents. */ }
		if (signal.aborted) return;
		this.stage = 'relay-delivery';
		const agentUrl = this.agentUrl;
		const key = this.key;
		if (!agentUrl || !key) throw new Error('Relay is not configured.');
		const deliveryStatus = await postResponse(`${agentUrl}/response`, key, JSON.stringify({ id: input.id, status, headers: resultHeaders, body: result.toString('base64') }), AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
		if (deliveryStatus !== 200 && deliveryStatus !== 410) throw new Error('Relay delivery failed.');
		if (deliveryStatus === 200) this.delivered++;
    this.stage = 'idle';
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    controller?.abort();
    await this.loop;
		await Promise.allSettled([...this.active]);
		if (controller && this.agentUrl && this.key) {
			await relayRequest(`${this.agentUrl}/disconnect`, this.key, 'POST', undefined, AbortSignal.timeout(3000), 64 * 1024, 3000).catch(() => undefined);
    }
    this.controller = undefined; this.loop = undefined; this.connected = false; this.error = undefined;
    this.publicUrl = undefined; this.agentUrl = undefined; this.key = undefined; this.localUrl = undefined;
  }
}
