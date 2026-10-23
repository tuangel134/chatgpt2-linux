import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LiteConfig {
	version: 1;
	workspaces: Array<{ id: string; root: string; name: string }>;
	permissions: string[];
	preferredTransport?: 'local' | 'ngrok' | 'relay';
	webAiLocal: { port: number };
}

const DEFAULT_CONFIG: LiteConfig = {
	version: 1,
	workspaces: [],
	permissions: ['forja:read'],
	webAiLocal: { port: 48_761 }
};

async function atomicWrite(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

export async function loadLiteConfig(file: string): Promise<LiteConfig> {
	try {
		const value = JSON.parse(await readFile(file, 'utf8')) as Partial<LiteConfig>;
		return {
			version: 1,
			preferredTransport: value.preferredTransport === 'relay' || value.preferredTransport === 'ngrok' ? value.preferredTransport : 'local',
			workspaces: Array.isArray(value.workspaces) ? value.workspaces.filter((entry): entry is LiteConfig['workspaces'][number] => Boolean(entry) && typeof entry.id === 'string' && typeof entry.root === 'string' && typeof entry.name === 'string') : [],
			permissions: Array.isArray(value.permissions) ? value.permissions.filter((entry): entry is string => typeof entry === 'string') : [...DEFAULT_CONFIG.permissions],
			webAiLocal: { port: typeof value.webAiLocal?.port === 'number' && Number.isInteger(value.webAiLocal.port) && value.webAiLocal.port >= 1024 && value.webAiLocal.port <= 65535 ? value.webAiLocal.port : DEFAULT_CONFIG.webAiLocal.port }
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG, workspaces: [], permissions: [...DEFAULT_CONFIG.permissions], webAiLocal: { ...DEFAULT_CONFIG.webAiLocal } };
		throw error;
	}
}

export async function saveLiteConfig(file: string, config: LiteConfig): Promise<void> {
	await atomicWrite(file, `${JSON.stringify(config, undefined, 2)}\n`);
	await chmod(file, 0o600).catch(() => undefined);
}
