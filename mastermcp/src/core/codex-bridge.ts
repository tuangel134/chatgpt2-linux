/**
 * Puente Master MCP -> Codex (CLI `codex exec`) del clon «ChatGPT 2».
 *
 * Un conector externo (p. ej. ChatGPT web) delega una tarea en Codex, que corre en local con el
 * CODEX_HOME del clon: mismos modelos del hub, skills y servidores MCP configurados. Las sesiones
 * quedan guardadas y se ven en el historial de ChatGPT 2.
 *
 * Seguridad (leer antes de tocar):
 *  - Exige el permiso `forja:codex` (alto riesgo, apagado por defecto) además de `forja:read`;
 *    iniciar/cancelar exige también `forja:agent`.
 *  - Codex corre con `-C <workspace>` y sandbox `workspace-write` (por defecto) o `read-only`.
 *    `danger-full-access` solo con `forja:host-terminal`. Red solo con `forja:terminal-network`.
 *  - OJO: el sandbox de Codex limita ESCRITURAS, no lecturas: el agente puede leer cualquier archivo
 *    legible por el usuario (incluido ~/.codex-2/config.toml). Por eso es un permiso de alto riesgo.
 *  - Entorno mínimo para el proceso hijo; el prompt va por stdin, nunca en argv.
 *  - No evita las aprobaciones de la GUI ni usa su navegador integrado ni sus sockets privados.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Logger } from './platform/logger.ts';

export type CodexJobStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'interrupted';
type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

interface JobMeta {
	jobId: string;
	workspaceId: string;
	root: string;
	status: CodexJobStatus;
	sandbox: Sandbox;
	network: boolean;
	model?: string;
	threadId?: string;
	startedAt: string;
	finishedAt?: string;
	exitCode?: number | null;
	usage?: unknown;
	promptPreview: string;
	resumedFrom?: string;
	error?: string;
}

interface LiveJob {
	meta: JobMeta;
	child: ChildProcess;
	events: WriteStream;
	recent: string[];
	timer: NodeJS.Timeout;
	cancelled: boolean;
	timedOut: boolean;
}

export interface CodexToolDef { name: string; description: string; parameters: Record<string, unknown>; readOnly: boolean }

export interface CodexToolResult { tool: string; output: string; isError: boolean; data?: Record<string, unknown> }

export interface CodexBridgeOptions {
	readonly jobsDir: string;
	readonly logger: Logger;
	/** Binario de Codex del clon. Sobrescribible con MASTERMCP_CODEX_BIN (pruebas). */
	readonly codexBin?: string;
	readonly codexHome?: string;
	readonly maxConcurrent?: number;
}

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
const THREAD_RE = /^[A-Za-z0-9-]{8,80}$/;
const JOB_RE = /^cx_[0-9a-f]{8}$/;
const MAX_PROMPT = 20_000;
const MAX_FINAL = 20_000;
const DEFAULT_TIMEOUT_S = 1_800;
const MAX_TIMEOUT_S = 7_200;
const MAX_WAIT_S = 120;

export const CODEX_TOOL_DEFS: readonly CodexToolDef[] = [
	{
		name: 'codex_task_start',
		description: 'Delegates a task to Codex running locally on this machine (same models, skills and MCP servers as the ChatGPT 2 app). It works inside the authorized workspace and returns a job_id; poll codex_task_status. Optionally wait_seconds to wait for the result. Requires forja:codex and forja:agent.',
		parameters: {
			type: 'object', required: ['prompt'], additionalProperties: false,
			properties: {
				prompt: { type: 'string', description: 'Complete instructions for Codex. It starts without your conversation context.' },
				sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Default workspace-write. danger-full-access needs forja:host-terminal.' },
				model: { type: 'string', description: 'Optional model slug from the ChatGPT 2 hub (for example claude-sonnet-4-6).' },
				reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'] },
				timeout_seconds: { type: 'integer', minimum: 60, maximum: MAX_TIMEOUT_S, description: `Default ${DEFAULT_TIMEOUT_S}.` },
				resume_thread_id: { type: 'string', description: 'thread_id from a previous task to continue that Codex conversation.' },
				wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_S, description: 'Wait up to this long for completion before returning.' }
			}
		},
		readOnly: false
	},
	{
		name: 'codex_task_status',
		description: 'Status, recent progress and final message of a Codex task started with codex_task_start. Use wait_seconds to long-poll. Requires forja:codex.',
		parameters: {
			type: 'object', required: ['job_id'], additionalProperties: false,
			properties: {
				job_id: { type: 'string' },
				wait_seconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_S },
				recent_events: { type: 'integer', minimum: 0, maximum: 60, description: 'How many recent condensed events to include (default 12).' }
			}
		},
		readOnly: true
	},
	{
		name: 'codex_task_cancel',
		description: 'Cancels a running Codex task. Requires forja:codex and forja:agent.',
		parameters: { type: 'object', required: ['job_id'], additionalProperties: false, properties: { job_id: { type: 'string' } } },
		readOnly: false
	},
	{
		name: 'codex_task_list',
		description: 'Lists recent Codex tasks of this workspace. Requires forja:codex.',
		parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } } },
		readOnly: true
	}
];

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/** Resume un evento JSONL de `codex exec --json` en una línea legible; null si no aporta. */
export function condenseEvent(raw: unknown): string | null {
	if (!raw || typeof raw !== 'object') return null;
	const ev = raw as Record<string, unknown>;
	const type = String(ev['type'] ?? '');
	if (type === 'thread.started') return `thread ${String(ev['thread_id'] ?? '')}`;
	if (type === 'turn.completed') return 'turn completed';
	if (type === 'turn.failed' || type === 'error') {
		const err = ev['error'] as Record<string, unknown> | undefined;
		return `error: ${clip(String(err?.['message'] ?? ev['message'] ?? 'unknown'), 300)}`;
	}
	if (type !== 'item.completed' && type !== 'item.started') return null;
	if (type === 'item.started') return null;
	const item = (ev['item'] ?? {}) as Record<string, unknown>;
	switch (String(item['type'] ?? '')) {
		case 'agent_message': return `assistant: ${clip(String(item['text'] ?? ''), 500)}`;
		case 'command_execution': return `command: ${clip(String(item['command'] ?? ''), 200)} -> exit ${String(item['exit_code'] ?? '?')}`;
		case 'file_change': {
			const changes = Array.isArray(item['changes']) ? (item['changes'] as Array<Record<string, unknown>>) : [];
			return `file_change: ${changes.map((c) => `${String(c['kind'] ?? '')} ${String(c['path'] ?? '')}`).join(', ')}`;
		}
		case 'mcp_tool_call': return `mcp: ${String(item['server'] ?? '')}.${String(item['tool'] ?? '')}`;
		case 'web_search': return `web_search: ${clip(String(item['query'] ?? ''), 160)}`;
		case 'error': return `error: ${clip(String(item['message'] ?? ''), 300)}`;
		default: return null;
	}
}

export class CodexBridge {
	private readonly jobsDir: string;
	private readonly logger: Logger;
	private readonly codexBin: string;
	private readonly codexHome: string;
	private readonly maxConcurrent: number;
	private readonly live = new Map<string, LiveJob>();
	private readonly known = new Map<string, JobMeta>();
	private loaded = false;
	private disposed = false;

	constructor(options: CodexBridgeOptions) {
		this.jobsDir = resolve(options.jobsDir);
		this.logger = options.logger.child('codex-bridge');
		this.codexBin = options.codexBin ?? process.env['MASTERMCP_CODEX_BIN'] ?? join(homedir(), '.local/opt/chatgpt2/resources/codex');
		this.codexHome = options.codexHome ?? process.env['MASTERMCP_CODEX_HOME'] ?? join(homedir(), '.codex-2');
		this.maxConcurrent = options.maxConcurrent ?? 2;
	}

	async call(workspaceId: string, root: string, name: string, args: Record<string, unknown>, scopes: readonly string[]): Promise<CodexToolResult> {
		await this.load();
		switch (name) {
			case 'codex_task_start': return this.start(workspaceId, root, args, scopes);
			case 'codex_task_status': return this.status(workspaceId, args);
			case 'codex_task_cancel': return this.cancel(workspaceId, args);
			case 'codex_task_list': return this.list(workspaceId, args);
			default: throw new Error(`Unknown Codex bridge tool "${name}".`);
		}
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
		const names = await readdir(this.jobsDir).catch(() => [] as string[]);
		for (const id of names.filter((n) => JOB_RE.test(n)).slice(-200)) {
			try {
				const meta = JSON.parse(await readFile(join(this.jobsDir, id, 'meta.json'), 'utf8')) as JobMeta;
				if (meta.status === 'running') {
					meta.status = 'interrupted';
					meta.finishedAt = meta.finishedAt ?? new Date().toISOString();
					await writeFile(join(this.jobsDir, id, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
				}
				this.known.set(id, meta);
			} catch { /* carpeta ajena o corrupta: se ignora */ }
		}
	}

	private async persist(meta: JobMeta): Promise<void> {
		await writeFile(join(this.jobsDir, meta.jobId, 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
	}

	private async start(workspaceId: string, root: string, args: Record<string, unknown>, scopes: readonly string[]): Promise<CodexToolResult> {
		if (this.disposed) throw new Error('Master MCP is closing.');
		const prompt = typeof args['prompt'] === 'string' ? args['prompt'].trim() : '';
		if (!prompt) throw new Error('prompt is required.');
		if (prompt.length > MAX_PROMPT) throw new Error(`prompt is longer than ${MAX_PROMPT} characters.`);
		const requested = (args['sandbox'] ?? 'workspace-write') as string;
		if (requested !== 'read-only' && requested !== 'workspace-write' && requested !== 'danger-full-access') throw new Error('Invalid sandbox.');
		if (requested === 'danger-full-access' && !scopes.includes('forja:host-terminal')) throw new Error('sandbox danger-full-access requires the forja:host-terminal permission.');
		const sandbox: Sandbox = requested;
		const model = typeof args['model'] === 'string' && args['model'] ? args['model'] : undefined;
		if (model && !MODEL_RE.test(model)) throw new Error('Invalid model slug.');
		const effort = args['reasoning_effort'];
		if (effort !== undefined && effort !== 'low' && effort !== 'medium' && effort !== 'high') throw new Error('Invalid reasoning_effort.');
		const resume = typeof args['resume_thread_id'] === 'string' && args['resume_thread_id'] ? args['resume_thread_id'] : undefined;
		if (resume && !THREAD_RE.test(resume)) throw new Error('Invalid resume_thread_id.');
		const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(60, Number.isInteger(args['timeout_seconds']) ? Number(args['timeout_seconds']) : DEFAULT_TIMEOUT_S));
		const waitS = Math.min(MAX_WAIT_S, Math.max(0, Number.isInteger(args['wait_seconds']) ? Number(args['wait_seconds']) : 0));
		if ([...this.live.values()].length >= this.maxConcurrent) throw new Error(`Too many Codex tasks running (max ${this.maxConcurrent}). Wait for one to finish or cancel it.`);

		const network = sandbox === 'workspace-write' && scopes.includes('forja:terminal-network');
		const jobId = `cx_${randomBytes(4).toString('hex')}`;
		const dir = join(this.jobsDir, jobId);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const lastFile = join(dir, 'last-message.txt');
		const cliArgs = ['exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check', '-s', sandbox, '-C', root, '-o', lastFile, '-c', 'approval_policy="never"'];
		if (network) cliArgs.push('-c', 'sandbox_workspace_write.network_access=true');
		if (model) cliArgs.push('-m', model);
		if (effort) cliArgs.push('-c', `model_reasoning_effort="${effort}"`);
		if (resume) cliArgs.push(resume);
		cliArgs.push('-'); // el prompt llega por stdin

		const env: NodeJS.ProcessEnv = {
			PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
			HOME: homedir(),
			LANG: process.env['LANG'] ?? 'C.UTF-8',
			TERM: 'dumb',
			NO_COLOR: '1',
			CODEX_HOME: this.codexHome
		};
		const meta: JobMeta = {
			jobId, workspaceId, root, status: 'running', sandbox, network, ...(model ? { model } : {}),
			startedAt: new Date().toISOString(), promptPreview: clip(prompt.replace(/\s+/g, ' '), 160), ...(resume ? { resumedFrom: resume, threadId: resume } : {})
		};
		const events = createWriteStream(join(dir, 'events.jsonl'), { flags: 'a', mode: 0o600 });
		const stderrLog = createWriteStream(join(dir, 'stderr.log'), { flags: 'a', mode: 0o600 });
		let child: ChildProcess;
		try {
			child = spawn(this.codexBin, cliArgs, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
		} catch (error) {
			events.end(); stderrLog.end();
			throw new Error(`Could not start Codex: ${error instanceof Error ? error.message : String(error)}`);
		}
		const job: LiveJob = {
			meta, child, events, recent: [], cancelled: false, timedOut: false,
			timer: setTimeout(() => { job.timedOut = true; this.kill(job); }, timeoutS * 1000)
		};
		this.live.set(jobId, job);
		this.known.set(jobId, meta);
		await this.persist(meta);

		let carry = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			events.write(chunk);
			carry += chunk.toString('utf8');
			let nl: number;
			while ((nl = carry.indexOf('\n')) >= 0) {
				const line = carry.slice(0, nl).trim();
				carry = carry.slice(nl + 1);
				if (!line) continue;
				try {
					const ev = JSON.parse(line) as Record<string, unknown>;
					if (ev['type'] === 'thread.started' && typeof ev['thread_id'] === 'string') meta.threadId = ev['thread_id'];
					if (ev['type'] === 'turn.completed') meta.usage = ev['usage'];
					const text = condenseEvent(ev);
					if (text) { job.recent.push(text); if (job.recent.length > 80) job.recent.shift(); }
				} catch { /* línea no JSON: solo queda en events.jsonl */ }
			}
		});
		child.stderr?.on('data', (chunk: Buffer) => stderrLog.write(chunk));
		child.stdin?.on('error', () => undefined);
		child.stdin?.end(prompt);
		child.on('error', (error) => { meta.error = error.message; });
		child.on('close', (code) => {
			clearTimeout(job.timer);
			meta.exitCode = code;
			meta.finishedAt = new Date().toISOString();
			meta.status = job.cancelled ? 'cancelled' : job.timedOut ? 'timeout' : code === 0 ? 'completed' : 'failed';
			this.live.delete(jobId);
			events.end(); stderrLog.end();
			void this.persist(meta).catch(() => undefined);
		});
		this.logger.info('Codex task started', { jobId, sandbox, network, resumed: Boolean(resume) });

		if (waitS > 0) await this.waitUntilDone(jobId, waitS);
		return this.status(workspaceId, { job_id: jobId, recent_events: 6 });
	}

	private kill(job: LiveJob): void {
		const pid = job.child.pid;
		if (!pid) return;
		try { process.kill(-pid, 'SIGTERM'); } catch { try { job.child.kill('SIGTERM'); } catch { /* ya terminó */ } }
		setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* ya terminó */ } }, 5_000).unref();
	}

	private async waitUntilDone(jobId: string, seconds: number): Promise<void> {
		const until = Date.now() + seconds * 1000;
		while (Date.now() < until && this.live.has(jobId)) await sleep(500);
	}

	private owned(workspaceId: string, args: Record<string, unknown>): JobMeta {
		const id = typeof args['job_id'] === 'string' ? args['job_id'] : '';
		if (!JOB_RE.test(id)) throw new Error('Invalid job_id.');
		const meta = this.known.get(id);
		if (!meta || meta.workspaceId !== workspaceId) throw new Error('Unknown job_id for this workspace.');
		return meta;
	}

	private async status(workspaceId: string, args: Record<string, unknown>): Promise<CodexToolResult> {
		const meta = this.owned(workspaceId, args);
		const waitS = Math.min(MAX_WAIT_S, Math.max(0, Number.isInteger(args['wait_seconds']) ? Number(args['wait_seconds']) : 0));
		if (waitS > 0) await this.waitUntilDone(meta.jobId, waitS);
		const wanted = Math.min(60, Math.max(0, Number.isInteger(args['recent_events']) ? Number(args['recent_events']) : 12));
		const liveJob = this.live.get(meta.jobId);
		const recent = liveJob ? liveJob.recent.slice(-wanted) : await this.tailEvents(meta.jobId, wanted);
		let finalMessage: string | undefined;
		if (meta.status !== 'running') {
			finalMessage = await readFile(join(this.jobsDir, meta.jobId, 'last-message.txt'), 'utf8').then((t) => clip(t.trim(), MAX_FINAL)).catch(() => undefined);
		}
		const data: Record<string, unknown> = {
			job_id: meta.jobId, status: meta.status, thread_id: meta.threadId, sandbox: meta.sandbox, network: meta.network, model: meta.model,
			started_at: meta.startedAt, finished_at: meta.finishedAt, exit_code: meta.exitCode, usage: meta.usage, prompt: meta.promptPreview,
			recent_events: recent, ...(finalMessage ? { final_message: finalMessage } : {}),
			...(meta.status === 'running' ? { hint: 'Still running. Call codex_task_status again, optionally with wait_seconds.' } : {}),
			...(meta.status === 'failed' ? { hint: 'Failed. recent_events and stderr describe why; cancel is not needed.' } : {})
		};
		return { tool: 'codex_task_status', output: JSON.stringify(data, null, 2), isError: false, data };
	}

	private async tailEvents(jobId: string, n: number): Promise<string[]> {
		if (n === 0) return [];
		const file = join(this.jobsDir, jobId, 'events.jsonl');
		const handle = await open(file, 'r').catch(() => undefined);
		if (!handle) return [];
		try {
			const size = (await handle.stat()).size;
			const length = Math.min(size, 512 * 1024);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			const lines = buffer.toString('utf8').split('\n').filter(Boolean);
			const out: string[] = [];
			for (const line of lines) {
				try { const text = condenseEvent(JSON.parse(line)); if (text) out.push(text); } catch { /* línea cortada por el inicio del tramo */ }
			}
			return out.slice(-n);
		} finally {
			await handle.close();
		}
	}

	private async cancel(workspaceId: string, args: Record<string, unknown>): Promise<CodexToolResult> {
		const meta = this.owned(workspaceId, args);
		const job = this.live.get(meta.jobId);
		if (!job) return { tool: 'codex_task_cancel', output: `Task ${meta.jobId} is not running (status: ${meta.status}).`, isError: false, data: { job_id: meta.jobId, status: meta.status } };
		job.cancelled = true;
		this.kill(job);
		await this.waitUntilDone(meta.jobId, 8);
		return { tool: 'codex_task_cancel', output: `Cancellation requested for ${meta.jobId}.`, isError: false, data: { job_id: meta.jobId, status: meta.status } };
	}

	private async list(workspaceId: string, args: Record<string, unknown>): Promise<CodexToolResult> {
		const limit = Math.min(50, Math.max(1, Number.isInteger(args['limit']) ? Number(args['limit']) : 20));
		const jobs = [...this.known.values()]
			.filter((meta) => meta.workspaceId === workspaceId)
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
			.slice(0, limit)
			.map((m) => ({ job_id: m.jobId, status: m.status, thread_id: m.threadId, started_at: m.startedAt, finished_at: m.finishedAt, sandbox: m.sandbox, prompt: m.promptPreview }));
		return { tool: 'codex_task_list', output: JSON.stringify({ jobs }, null, 2), isError: false, data: { jobs } };
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const job of this.live.values()) { job.cancelled = true; clearTimeout(job.timer); this.kill(job); }
	}
}
