/** Bounded HTTP envelopes: the relay never chooses a destination on the PC. */
export const REQUEST_LIMIT = 512 * 1024;
export const RESPONSE_LIMIT = 4 * 1024 * 1024;
export const ID_PATTERN = /^[a-z0-9_-]{16,64}$/;
export const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const REQUEST_HEADERS = ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id'] as const;
export const RESPONSE_HEADERS = ['content-type', 'www-authenticate', 'location', 'allow', 'mcp-protocol-version', 'mcp-session-id', 'retry-after'] as const;

export interface RelayRequest { id: string; method: string; path: string; headers: Record<string, string>; body: string; }
export interface RelayResponse { id: string; status: number; headers: Record<string, string>; body: string; }

export function permittedRoute(method: string, path: string): boolean {
  if (path.length > 8192 || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n#]/.test(path)) return false;
  const pathname = path.split('?')[0];
  return (method === 'GET' && ['/health', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/oauth/authorize', '/mcp'].includes(pathname))
    || (method === 'POST' && ['/mcp', '/oauth/register', '/oauth/token'].includes(pathname))
    || (method === 'DELETE' && pathname === '/mcp');
}

export function filteredHeaders(headers: Record<string, unknown>, allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = headers[name];
    if (typeof value === 'string' && value.length <= 8192 && !/[\r\n]/.test(value)) result[name] = value;
  }
  return result;
}

export function decodeBody(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('Invalid or oversized relay body.');
  const body = Buffer.from(value, 'base64');
  if (body.length > limit || body.toString('base64') !== value) throw new Error('Relay body exceeds its limit or is not canonical base64.');
  return body;
}

export async function boundedFetchBody(response: Response, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > limit) { await reader.cancel(); throw new Error('Relay response exceeds its limit.'); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
  }
  return Buffer.concat(chunks, size);
}
