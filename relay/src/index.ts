/**
 * Forja Remote Anywhere relay.
 *
 * The relay is a short-lived HTTPS mailbox, never a model proxy. A desktop creates a random
 * installation id, relay secret and independent end-to-end encryption key, then embeds them in a
 * QR code. Cloudflare only sees a verifier and opaque AES-GCM packets, never chat text or captures.
 */

export interface Env { RELAY: DurableObjectNamespace<ForjaRelayRoom>; }

const INSTALLATION = /^[A-Za-z0-9_-]{32,128}$/;
const PAIRING_KEY = /^[A-Za-z0-9_-]{43,128}$/;
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_BODY_BYTES = 8_000_000;
const MAX_QUEUE = 100;
const COMMAND_TTL_MS = 5 * 60_000;
const RESPONSE_TTL_MS = 15 * 60_000;

interface Envelope {
	readonly id: string;
	readonly body: unknown;
	readonly createdAt: number;
}

interface RelayDevice {
	readonly id: string;
	readonly label: string;
	readonly platform: string;
	readonly pairedAt: number;
	readonly lastSeenAt?: number;
	readonly tokenHash: string;
}

interface RoomState {
	readonly keyHash: string;
	readonly pairingKeyHash?: string;
	readonly phoneTokenHash?: string;
	readonly phonePairedAt?: number;
	readonly devices?: readonly RelayDevice[];
	readonly commands: readonly Envelope[];
	readonly responses: readonly Envelope[];
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/health') {
			return Response.json({ service: 'forja-relay', protocol: 3, ready: true });
		}
		if (!url.pathname.startsWith('/v3/')) {
			return new Response('Not found', { status: 404 });
		}
		const installation = url.searchParams.get('installation') ?? '';
		if (!INSTALLATION.test(installation)) {
			return json({ error: 'Invalid installation id.' }, 400);
		}
		const id = env.RELAY.idFromName(installation);
		return env.RELAY.get(id).fetch(request);
	}
} satisfies ExportedHandler<Env>;

export class ForjaRelayRoom {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const action = url.pathname.slice('/v3/'.length);
		const key = request.headers.get('X-Forja-Pairing-Key') ?? '';
		if (action === 'register') {
			if (!PAIRING_KEY.test(key)) { return json({ error: 'A valid pairing key is required.' }, 401); }
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'desktop') {
				return json({ error: 'Only a desktop can register an installation.' }, 403);
			}
			return this.register(key, request);
		}
		if (action === 'pair') {
			if (!PAIRING_KEY.test(key)) { return json({ error: 'A valid pairing key is required.' }, 401); }
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'android') {
				return json({ error: 'Only Forja Remote may claim a pairing.' }, 403);
			}
			const room = await this.pairingRoom(key);
			if (!room) { return json({ error: 'Pairing expired. Open Forja and scan a new QR code.' }, 401); }
			return this.pair(room, request);
		}
		if (action === 'command' || action === 'responses') {
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'android') {
				return json({ error: 'Only the paired phone may use this endpoint.' }, 403);
			}
			const room = await this.phoneRoom(request.headers.get('X-Forja-Device-Token') ?? '');
			if (!room) { return json({ error: 'This phone is no longer paired.' }, 401); }
			return action === 'command' ? this.enqueue(room, 'commands', request) : this.take(room, 'responses');
		}
		if (action === 'devices') {
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'desktop') return json({ error: 'Only the paired desktop may list devices.' }, 403);
			const room = await this.room(key);
			if (!room) return json({ error: 'Pairing expired. Open Forja and scan a new QR code.' }, 401);
			return json({ devices: (room.devices ?? []).map(({ tokenHash: _tokenHash, ...device }) => device) });
		}
		if (!PAIRING_KEY.test(key)) { return json({ error: 'A valid desktop pairing key is required.' }, 401); }
		const room = await this.room(key);
		if (!room) {
			return json({ error: 'Pairing expired. Open Forja and scan a new QR code.' }, 401);
		}
		if (action === 'revoke') {
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'desktop') {
				return json({ error: 'Only the paired desktop may revoke an installation.' }, 403);
			}
			await this.state.storage.delete('room');
			return json({ ok: true });
		}
		if (action === 'commands') {
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'desktop') {
				return json({ error: 'Only the paired desktop may read commands.' }, 403);
			}
			return this.take(room, 'commands');
		}
		if (action === 'unpair') {
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'desktop') {
				return json({ error: 'Only the paired desktop may unpair a phone.' }, 403);
			}
			await this.state.storage.put('room', { ...room, phoneTokenHash: undefined, phonePairedAt: undefined, devices: [], commands: [], responses: [] } satisfies RoomState);
			return json({ ok: true });
		}
		if (action === 'revoke-device') {
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'desktop') return json({ error: 'Only the paired desktop may revoke devices.' }, 403);
			const body = await readJson(request);
			const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : '';
			if (!deviceId) return json({ error: 'deviceId is required.' }, 400);
			await this.state.storage.put('room', { ...room, devices: (room.devices ?? []).filter(device => device.id !== deviceId) } satisfies RoomState);
			return json({ ok: true });
		}
		if (action === 'response') {
			if (request.method !== 'POST' || request.headers.get('X-Forja-Device') !== 'desktop') {
				return json({ error: 'Only the paired desktop may post responses.' }, 403);
			}
			return this.enqueue(room, 'responses', request);
		}
		return json({ error: 'Not found.' }, 404);
	}

	private async register(key: string, request?: Request): Promise<Response> {
		const existing = await this.state.storage.get<RoomState>('room');
		const keyHash = await sha256(key);
		const body = request ? await readJson(request) : undefined;
		const pairingKey = typeof body?.pairingKey === 'string' && PAIRING_KEY.test(body.pairingKey) ? body.pairingKey : '';
		if (existing && existing.keyHash !== keyHash) {
			return json({ error: 'This installation is already registered.' }, 409);
		}
		if (!existing) {
			await this.state.storage.put('room', { keyHash, pairingKeyHash: pairingKey ? await sha256(pairingKey) : undefined, commands: [], responses: [] } satisfies RoomState);
		} else if (pairingKey) {
			await this.state.storage.put('room', { ...existing, pairingKeyHash: await sha256(pairingKey) } satisfies RoomState);
		}
		return json({ ok: true });
	}

	private async room(key: string): Promise<RoomState | undefined> {
		const room = await this.state.storage.get<RoomState>('room');
		return room && room.keyHash === await sha256(key) ? room : undefined;
	}

	private async pairingRoom(key: string): Promise<RoomState | undefined> {
		const room = await this.state.storage.get<RoomState>('room');
		return room && room.pairingKeyHash === await sha256(key) ? room : undefined;
	}

	private async phoneRoom(token: string): Promise<RoomState | undefined> {
		if (!DEVICE_TOKEN.test(token)) { return undefined; }
		const room = await this.state.storage.get<RoomState>('room');
		const hash = await sha256(token);
		if (!room) return undefined;
		const device = (room.devices ?? []).find(candidate => candidate.tokenHash === hash);
		if (device) {
			const devices = (room.devices ?? []).map(candidate => candidate.id === device.id ? { ...candidate, lastSeenAt: Date.now() } : candidate);
			await this.state.storage.put('room', { ...room, devices } satisfies RoomState);
			return { ...room, devices };
		}
		return room.phoneTokenHash === hash ? room : undefined;
	}

	private async pair(room: RoomState, request: Request): Promise<Response> {
		const body = await readJson(request);
		const devices = room.devices ?? [];
		if (devices.length >= 8) return json({ error: 'This installation already has eight paired devices.' }, 429);
		const token = randomToken();
		const pairedAt = Date.now();
		const device: RelayDevice = {
			id: randomToken().slice(0, 16),
			label: typeof body?.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 80) : 'Forja Remote',
			platform: typeof body?.platform === 'string' ? body.platform.slice(0, 40) : 'unknown',
			pairedAt,
			tokenHash: await sha256(token)
		};
		await this.state.storage.put('room', { ...room, pairingKeyHash: undefined, phoneTokenHash: undefined, phonePairedAt: undefined, devices: [...devices, device] } satisfies RoomState);
		return json({ token, deviceId: device.id });
	}

	private async enqueue(room: RoomState, queue: 'commands' | 'responses', request: Request): Promise<Response> {
		const body = await readJson(request);
		if (!body || typeof body.id !== 'string' || body.id.length < 8 || body.id.length > 128 || !isCipherEnvelope(body.body)) {
			return json({ error: 'An id and encrypted body are required.' }, 400);
		}
		const now = Date.now();
		const next = trim(room[queue], queue === 'commands' ? COMMAND_TTL_MS : RESPONSE_TTL_MS, now);
		if (next.length >= MAX_QUEUE) {
			return json({ error: 'The paired device is not keeping up. Try again shortly.' }, 429);
		}
		const updated: RoomState = { ...room, [queue]: [...next, { id: body.id, body: body.body, createdAt: now }] };
		await this.state.storage.put('room', updated);
		return json({ ok: true });
	}

	private async take(room: RoomState, queue: 'commands' | 'responses'): Promise<Response> {
		const now = Date.now();
		const messages = trim(room[queue], queue === 'commands' ? COMMAND_TTL_MS : RESPONSE_TTL_MS, now);
		await this.state.storage.put('room', { ...room, [queue]: [] } satisfies RoomState);
		return json({ messages });
	}
}

function trim(messages: readonly Envelope[], ttl: number, now: number): Envelope[] {
	return messages.filter(message => now - message.createdAt <= ttl).slice(-MAX_QUEUE);
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
	const length = Number(request.headers.get('Content-Length') ?? 0);
	if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
		return undefined;
	}
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

async function sha256(value: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
	return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function isCipherEnvelope(value: unknown): value is { iv: string; ciphertext: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	const packet = value as Record<string, unknown>;
	return typeof packet.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(packet.iv)
		&& typeof packet.ciphertext === 'string' && /^[A-Za-z0-9_-]{24,8000000}$/.test(packet.ciphertext);
}

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
