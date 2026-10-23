/* ChatGPT 2 local Master MCP controller: no Tessarion daemon or sockets. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync as d_exists } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { LiteRuntime } from './runtime.ts';
import type { MasterMcpScope } from './master/master-mcp.ts';

const ROOT = process.env.CHATGPT2_HOME ? resolve(process.env.CHATGPT2_HOME, 'mastermcp') : resolve(homedir(), '.local/opt/chatgpt2/mastermcp');
const CODEX_DIR = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : resolve(homedir(), '.codex-2');
const DATA = process.env.CHATGPT2_MCP_TEST_ROOT ? resolve(process.env.CHATGPT2_MCP_TEST_ROOT) : resolve(CODEX_DIR, 'mastermcp');
const SETTINGS = resolve(DATA, 'control.json');
const PORT = process.env.CHATGPT2_MCP_TEST_ROOT ? Number(process.env.CHATGPT2_MCP_CONTROL_PORT || 8319) : 8319;
type Mode = 'local' | 'ngrok';
type Control = { enabled: boolean; mode: Mode; domain: string };
const defaults: Control = { enabled: false, mode: 'local', domain: '' };
let control: Control = { ...defaults };
let token = '';
const serious = new Set<MasterMcpScope>(['forja:host-terminal','forja:system-write','forja:ssh',
  'forja:docker','forja:mounts','forja:devices','forja:sudo']);
const validScopes = new Set<MasterMcpScope>(['forja:read','forja:agent','forja:browser',
  'forja:outside-workspace','forja:terminal-network','forja:protected-files',...serious]);
const protectedRoots = [
  ROOT,
  CODEX_DIR,
  resolve(homedir(), '.codex'),
  resolve(homedir(), '.local/opt/chatgpt'),
  resolve(homedir(), '.local/opt/tessarion'),
  resolve(homedir(), '.config/Codex-2'),
  resolve(homedir(), '.config/Codex')
];
async function main(): Promise<void> {
const runtime = await LiteRuntime.create({ userRoot: DATA, protectedRoots });
const json = (r: ServerResponse, status: number, data: unknown) => {
  r.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  r.end(JSON.stringify(data));
};
async function persist(): Promise<void> {
  const temporary = SETTINGS + '.tmp';
  await writeFile(temporary, JSON.stringify(control) + '\n', { mode: 0o600 });
  await rename(temporary, SETTINGS);
}
const equal = (a: string, b: string): boolean => {
  const aa = createHash('sha256').update(a).digest(), bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(aa, bb);
};
const plain = (s: unknown): string => typeof s === 'string' ? s : '';
const textArray = (a: unknown): string[] => Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : [];
function scopes(a: unknown): MasterMcpScope[] {
  const input = textArray(a);
  if (input.some(x => !validScopes.has(x as MasterMcpScope))) throw new Error('Invalid scope.');
  return [...new Set(input as MasterMcpScope[])];
}
function validDomain(s: string): string {
  const trimmed = s.trim().toLowerCase();
  if (trimmed && (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(trimmed) || trimmed.length > 253))
    throw new Error('Domain must be a valid hostname without scheme or path.');
  return trimmed;
}
async function snapshot(): Promise<unknown> {
  const state = await runtime.snapshot();
  return {control, ...state, risks: [...serious], localControlUrl:'http://127.0.0.1:' + PORT};
}
/** Comprueba que el gateway local (y, si hay, la URL pública/túnel) responden. Solo lectura, sin datos sensibles. */
async function testConnection(): Promise<{ local: { ok: boolean; detail: string }; remote?: { ok: boolean; detail: string } }> {
  const state = await runtime.snapshot();
  const probe = async (base: string): Promise<{ ok: boolean; detail: string }> => {
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(8000) });
      const data = await response.json().catch(() => ({})) as { status?: string };
      return response.ok && data.status === 'ok' ? { ok: true, detail: 'Responde correctamente: ' + base } : { ok: false, detail: 'Respuesta inesperada (HTTP ' + response.status + ') en ' + base };
    } catch (error) {
      return { ok: false, detail: 'No responde en ' + base + ': ' + (error instanceof Error ? error.message : String(error)) };
    }
  };
  const local = state.masterMcp.localUrl;
  if (!local) return { local: { ok: false, detail: 'Master MCP está apagado.' } };
  const result: { local: { ok: boolean; detail: string }; remote?: { ok: boolean; detail: string } } = { local: await probe(local) };
  if (state.masterMcp.publicUrl) result.remote = await probe(state.masterMcp.publicUrl);
  return result;
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw new Error('Request exceeds 64 KB.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON object expected.');
  return obj;
}
function chooseDirectory(): Promise<string> {
  return new Promise((ok, fail) => {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return fail(new Error('Native dialog requires desktop.'));
    const which = (n: string) => (process.env.PATH || '').split(':').map((d) => d + '/' + n).find((p) => d_exists(p)) || '';
    const kd = which('kdialog'), zn = which('zenity');
    if (!kd && !zn) return fail(new Error('Instala kdialog o zenity para elegir carpetas.'));
    const child = spawn(kd || zn, kd ? ['--getexistingdirectory', homedir()] : ['--file-selection', '--directory'], { stdio: ['ignore','pipe','ignore'] });
    let path = '';
    child.stdout?.on('data', d => { if (path.length < 4096) path += String(d); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
    child.on('error', fail);
    child.on('exit', code => { clearTimeout(timer); code === 0 ? ok(path.trim()) : fail(new Error('Folder selection cancelled.')); });
  });
}
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin;
  if (origin && origin !== 'app://-') return json(res, 403, {error:'Origin not allowed.'});
  if (origin === 'app://-') {
    res.setHeader('Access-Control-Allow-Origin', 'app://-');
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','X-Hub-Token,Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (typeof req.headers['x-hub-token'] !== 'string' ||
      !equal(req.headers['x-hub-token'], token)) return json(res, 401, {error:'Invalid local token.'});
  const u = new URL(req.url || '/', 'http://127.0.0.1:' + PORT);
  if (req.method === 'GET' && u.pathname === '/state') return json(res, 200, await snapshot());
  if (req.method === 'GET' && u.pathname === '/test') return json(res, 200, await testConnection());
  if (req.method !== 'POST') return json(res, 404, {error:'Not found.'});
  const x = await body(req);
  if (u.pathname === '/settings') {
    if (typeof x.enabled !== 'boolean' || !['local','ngrok'].includes(x.mode))
      throw new Error('enabled and mode are required.');
    const domain = validDomain(plain(x.domain));
    if (x.ngrokToken) await runtime.saveNgrokToken(plain(x.ngrokToken));
    if (!x.enabled) await runtime.stop();
    else if (x.mode === 'local') await runtime.startLocal();
    else await runtime.startTunnel(undefined, domain || undefined);
    control = {enabled:x.enabled, mode:x.mode, domain};
    await persist();
    return json(res, 200, await snapshot());
  }
  if (u.pathname === '/permissions') {
    const selected = scopes(x.scopes);
    const set = new Set(selected);
    // Narrow existing bearer/refresh grants first; then save global policy.
    for (const grant of (await runtime.snapshot()).authorizations) {
      await runtime.updateAuthorization(grant.clientId, grant.scopes.filter(v => set.has(v)));
    }
    await runtime.setPermissions(selected);
    return json(res, 200, await snapshot());
  }
  if (u.pathname === '/folder/pick') return json(res, 200, {path:await chooseDirectory()});
  if (u.pathname === '/workspace/add') return json(res, 200, await runtime.addWorkspace(plain(x.path)));
  if (u.pathname === '/workspace/remove') return json(res, 200, await runtime.removeWorkspace(plain(x.id)));
  if (u.pathname === '/authorization/approve') {
    const state = await runtime.snapshot();
    const pending = state.pendingAuthorizations.find(p => p.id === x.id);
    if (!pending) throw new Error('Pending authorization not found.');
    const allowed = new Set(state.permissions);
    const approved = scopes(x.scopes);
    // El usuario es quien decide qué conceder (como en Tessarion): basta con que el permiso esté habilitado
    // en «Permisos globales». Un conector puede pedir solo lectura y recibir más si tú lo marcas.
    if (approved.some(s => !allowed.has(s)))
      throw new Error('Ese permiso no está habilitado en «Permisos globales». Habilítalo allí y guarda antes de concederlo.');
    if (!approved.includes('forja:read')) throw new Error('Read scope is required.');
    return json(res, 200, await runtime.approveAuthorization(plain(x.id), textArray(x.workspaceIds), approved));
  }
  if (u.pathname === '/authorization/deny') return json(res, 200, await runtime.denyAuthorization(plain(x.id)));
  if (u.pathname === '/authorization/revoke') return json(res, 200, await runtime.revokeAuthorization(plain(x.clientId)));
  if (u.pathname === '/authorization/update') {
    const state = await runtime.snapshot();
    const grant = state.authorizations.find(g => g.clientId === x.clientId);
    if (!grant) throw new Error('Connector authorization not found.');
    const proposed = scopes(x.scopes);
    const permittedWorkspaces = new Set(grant.workspaceIds);
    const proposedWorkspaces = x.workspaceIds === undefined ? grant.workspaceIds : textArray(x.workspaceIds);
    if (proposed.some(s => !state.permissions.includes(s) || !grant.scopes.includes(s))
      || proposedWorkspaces.some(w => !permittedWorkspaces.has(w)))
      throw new Error('Grant expansion requires new interactive authorization.');
    return json(res, 200, await runtime.updateAuthorization(plain(x.clientId), proposed, proposedWorkspaces));
  }
  if (u.pathname === '/browser/open') return json(res, 200, await runtime.browserOpen(plain(x.workspaceId), plain(x.url)));
  if (u.pathname === '/browser/share') return json(res, 200, await runtime.browserShare(plain(x.pageId), x.shared === true, plain(x.workspaceId)));
  return json(res, 404, {error:'Not found.'});
}
await mkdir(DATA, {recursive:true,mode:0o700});
token = (await readFile(resolve(CODEX_DIR, 'hub-token'),'utf8')).trim();
if (token.length < 30) throw new Error('Local controller token is not configured.');
try {
  const saved = JSON.parse(await readFile(SETTINGS,'utf8'));
  if (typeof saved.enabled === 'boolean' && ['local','ngrok'].includes(saved.mode)) {
    control = {enabled:saved.enabled,mode:saved.mode,domain:validDomain(saved.domain||'')};
  }
} catch(e: any) { if (e.code !== 'ENOENT') throw e; }
if (control.enabled) {
  try {
    if (control.mode === 'ngrok') await runtime.startTunnel(undefined, control.domain || undefined);
    else await runtime.startLocal();
  } catch(e: any) { process.stderr.write('Master MCP startup failed: ' + String(e?.message || 'error') + '\n'); }
}
const server = createServer((req,res) => {
  void route(req,res).catch(err => json(res,err instanceof SyntaxError ? 400 : 422,{error:String(err?.message || 'Operation failed')}));
});
await new Promise<void>((ok,fail) => {
  server.once('error',fail);
  server.listen(PORT, '127.0.0.1',ok);
});
for (const signal of ['SIGINT','SIGTERM'] as const) {
  process.on(signal, () => { server.close(); void runtime.dispose().finally(() => process.exit(0)); });
}

}
void main().catch(error => { process.stderr.write('ChatGPT2 Master MCP controller failed: ' + String(error?.message || error) + '\n'); process.exitCode=1; });
