import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

async function exists(path: string): Promise<boolean> {
	try { await readFile(path); return true; } catch { return false; }
}

async function atomicWrite(path: string, data: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, data, { encoding: 'utf8', mode: FILE_MODE });
		await rename(temporary, path);
		await chmod(path, FILE_MODE).catch(() => undefined);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function loadKey(path: string): Promise<Buffer> {
	if (await exists(path)) {
		const encoded = (await readFile(path, 'utf8')).trim();
		const key = Buffer.from(encoded, 'base64');
		if (key.length !== KEY_BYTES) throw new Error('The local encrypted store key is corrupt.');
		return key;
	}
	const key = randomBytes(KEY_BYTES);
	await atomicWrite(path, `${key.toString('base64')}\n`);
	return key;
}

/** Encrypted-at-rest persistence for OAuth state. It never writes the plaintext snapshot. */
export class EncryptedBlobStore {
	private key: Buffer | undefined;
	constructor(private readonly file: string, private readonly keyFile: string) {}

	async load(): Promise<string | undefined> {
		let encoded: string;
		try { encoded = await readFile(this.file, 'utf8'); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw error;
		}
		const record = JSON.parse(encoded) as { v?: number; iv?: string; tag?: string; data?: string };
		if (record.v !== 1 || !record.iv || !record.tag || !record.data) throw new Error('The encrypted OAuth store is corrupt.');
		this.key ??= await loadKey(this.keyFile);
		const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(record.iv, 'base64'));
		decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
		return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
	}

	async save(value: string): Promise<void> {
		this.key ??= await loadKey(this.keyFile);
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv(ALGORITHM, this.key, iv);
		const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
		await mkdir(dirname(this.file), { recursive: true, mode: DIR_MODE });
		await chmod(dirname(this.file), DIR_MODE).catch(() => undefined);
		await atomicWrite(this.file, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n');
	}
}

/** Small encrypted name/value vault for credentials such as an ngrok token. */
export class SecretVault {
	private readonly blob: EncryptedBlobStore;
	private queue: Promise<unknown> = Promise.resolve();
	constructor(root: string) {
		this.blob = new EncryptedBlobStore(join(root, 'secrets.enc'), join(root, 'secrets.key'));
	}

	async get(name: string): Promise<string | undefined> {
		const raw = await this.blob.load();
		if (!raw) return undefined;
		const values = JSON.parse(raw) as Record<string, unknown>;
		return typeof values[name] === 'string' ? values[name] : undefined;
	}

	async set(name: string, value: string): Promise<void> {
		if (!name || !value) throw new Error('A non-empty secret is required.');
		await this.serialize(async () => {
			const raw = await this.blob.load();
			const values = raw ? JSON.parse(raw) as Record<string, unknown> : {};
			values[name] = value;
			await this.blob.save(JSON.stringify(values));
		});
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		this.queue = next.then(() => undefined, () => undefined);
		return next;
	}
}
