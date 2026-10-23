#!/usr/bin/env node
"use strict";
// ChatGPT 2 · agente de control remoto (móvil).
//
// La PC sale hacia un relay HTTPS tuyo (Cloudflare Worker «forja-relay», ver relay/), el teléfono se empareja con un QR y todo viaja
// cifrado de punta a punta (AES-256-GCM): el relay solo ve paquetes opacos. Aquí se implementa el lado «escritorio» del mismo protocolo
// que usa la app Android (android/): estado, mensajes, enviar, cancelar, tarea y captura. Las conversaciones son las de Codex
// (hilos de ~/.codex-2), así que lo que haces desde el teléfono aparece también en la app de escritorio.
//
// Sin dependencias (solo Node 18+). Control local: 127.0.0.1:8324 con el token del hub (la interfaz de Ajustes lo usa).

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const readline = require("node:readline");
const { qrRows } = require("./qr.cjs");

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex-2");
const ROOT = process.env.CHATGPT2_HOME || path.resolve(__dirname, "..");
const CODEX_BIN = process.env.CHATGPT2_CODEX_BIN || path.join(ROOT, "resources", "codex");
const DIR = path.join(CODEX_HOME, "remote");
const STATE_FILE = path.join(DIR, "state.json");
const SETTINGS_FILE = path.join(DIR, "settings.json");
const PORT = Number(process.env.CHATGPT2_REMOTE_PORT || 8324);
const POLL_FAST_MS = Number(process.env.CHATGPT2_REMOTE_POLL_FAST_MS || 1200);
const POLL_IDLE_MS = Number(process.env.CHATGPT2_REMOTE_POLL_IDLE_MS || 5000);
const PERMISSIONS = ["read-only", "workspace-write", "danger-full-access"];

const logLines = [];
function log(...a) { const l = new Date().toISOString().slice(11, 19) + " " + a.join(" "); logLines.push(l); if (logLines.length > 80) logLines.shift(); if (process.env.CHATGPT2_REMOTE_DEBUG) console.error(l); }

// ------------------------------------------------------------------ ajustes y estado (0600)
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
let settings = { relayUrl: process.env.CHATGPT2_RELAY_URL || "", model: "", permission: "workspace-write", ...readJson(SETTINGS_FILE, {}) };
const saveSettings = () => writeJson(SETTINGS_FILE, settings);
let state = readJson(STATE_FILE, null); // {version:3, relayUrl, installation, key, pairingKey, encryptionKey}

const b64u = (n) => crypto.randomBytes(n).toString("base64url");

// ------------------------------------------------------------------ relay (mismo protocolo v3 que Forja Remote Anywhere)
function validateRelayUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new Error("La URL del relay no es válida."); }
  const local = process.env.CHATGPT2_REMOTE_ALLOW_LOOPBACK === "1" && u.protocol === "http:" && u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) throw new Error("El relay debe usar HTTPS.");
  if (u.username || u.password || u.search || u.hash) throw new Error("La URL del relay no puede llevar credenciales, consulta ni fragmento.");
  const url = u.toString().replace(/\/$/, "");
  if (!local && url.length > 64) throw new Error("La URL del relay es demasiado larga para el QR (máximo 64 caracteres).");
  return url;
}

async function relay(action, body) {
  if (!state) throw new Error("El control remoto no está configurado.");
  const r = await fetch(`${state.relayUrl}/v3/${action}?installation=${encodeURIComponent(state.installation)}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forja-Device": "desktop", "X-Forja-Pairing-Key": state.key },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.error === "string" ? data.error : `El relay respondió ${r.status}.`);
  return data;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(state.encryptionKey, "base64url"), iv);
  c.setAAD(Buffer.from(state.installation));
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64url"), ciphertext: ct.toString("base64url") };
}
function decrypt(p) {
  if (!p || typeof p !== "object" || typeof p.iv !== "string" || typeof p.ciphertext !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(p.iv) || !/^[A-Za-z0-9_-]{24,8000000}$/.test(p.ciphertext)) throw new Error("Paquete remoto mal formado.");
  try {
    const bytes = Buffer.from(p.ciphertext, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(state.encryptionKey, "base64url"), Buffer.from(p.iv, "base64url"));
    d.setAAD(Buffer.from(state.installation));
    d.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([d.update(bytes.subarray(0, -16)), d.final()]).toString("utf8"));
  } catch { throw new Error("No se pudo autenticar el paquete remoto."); }
}

let pollTimer = null, polling = false, lastCommandAt = 0, running = false;
function schedulePoll() {
  if (!running) return;
  const idle = Date.now() - lastCommandAt > 10 * 60 * 1000;
  pollTimer = setTimeout(() => poll().finally(schedulePoll), idle ? POLL_IDLE_MS : POLL_FAST_MS);
  pollTimer.unref?.();
}
async function poll() {
  if (!state || polling) return;
  polling = true;
  try {
    const reply = await relay("commands", {});
    for (const env of Array.isArray(reply.messages) ? reply.messages : []) {
      if (!env || typeof env.id !== "string") continue;
      lastCommandAt = Date.now();
      let out;
      try { out = await handleCommand(decrypt(env.body)); } catch (e) { out = { ok: false, error: e instanceof Error ? e.message : "La operación remota falló." }; log("cmd error:", out.error); }
      await respond(env.id, out);
    }
  } catch (e) { log("poll:", e.message); } finally { polling = false; }
}
async function respond(id, body) {
  const delays = [250, 900, 2500];
  for (let i = 0; ; i++) {
    try { await relay("response", { id, body: encrypt(body) }); return; }
    catch (e) { if (i >= delays.length) { log("response perdida:", e.message); return; } await new Promise((r) => setTimeout(r, delays[i])); }
  }
}

async function startRemote(relayUrl) {
  const url = validateRelayUrl(relayUrl || settings.relayUrl);
  settings.relayUrl = url; saveSettings();
  if (state && state.relayUrl === url) state = { ...state, pairingKey: b64u(32) };
  else state = { version: 3, relayUrl: url, installation: b64u(24), key: b64u(32), pairingKey: b64u(32), encryptionKey: b64u(32) };
  await relay("register", { pairingKey: state.pairingKey });
  writeJson(STATE_FILE, state);
  beginPolling();
  return statusObj();
}
function beginPolling() { if (running) return; running = true; lastCommandAt = Date.now(); schedulePoll(); poll().catch(() => {}); }
async function stopRemote(revoke) {
  running = false; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (revoke && state) { await relay("revoke", {}).catch(() => {}); state = null; fs.rmSync(STATE_FILE, { force: true }); }
}
async function rotateRemote() { const url = state && state.relayUrl; await stopRemote(true); return startRemote(url); }
async function listDevices() {
  if (!state) return [];
  const r = await relay("devices", {});
  return (Array.isArray(r.devices) ? r.devices : []).filter((d) => d && typeof d.id === "string").map((d) => ({ id: d.id, label: String(d.label || ""), platform: String(d.platform || ""), pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt || null }));
}

// ------------------------------------------------------------------ Codex (codex app-server por stdio, mismo CODEX_HOME que la app)
class AppServer {
  constructor() { this.p = null; this.id = 0; this.pend = new Map(); this.ready = null; this.onNotify = () => {}; }
  ensure() { if (!this.ready) this.ready = this.start().catch((e) => { this.ready = null; throw e; }); return this.ready; }
  async start() {
    if (!fs.existsSync(CODEX_BIN)) throw new Error("No encuentro el ejecutable de Codex de ChatGPT 2 (" + CODEX_BIN + ").");
    const p = cp.spawn(CODEX_BIN, ["app-server"], { env: { ...process.env, CODEX_HOME }, stdio: ["pipe", "pipe", "pipe"] });
    this.p = p;
    p.stderr.on("data", (d) => log("codex:", String(d).trim().slice(0, 160)));
    p.on("exit", (code) => { log("codex app-server salió", code); this.p = null; this.ready = null; for (const w of this.pend.values()) w.rej(new Error("Codex se cerró.")); this.pend.clear(); this.onNotify({ method: "__exit" }); });
    readline.createInterface({ input: p.stdout }).on("line", (l) => this.line(l));
    await this.call("initialize", { clientInfo: { name: "chatgpt2-remote", title: "ChatGPT 2 Remote", version: "1.0.0" }, capabilities: null }, 20000, true);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  }
  line(l) {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.id !== undefined && m.method) return this.serverRequest(m);       // petición del servidor (aprobaciones...)
    if (m.id !== undefined) { const w = this.pend.get(m.id); if (w) { this.pend.delete(m.id); m.error ? w.rej(new Error(m.error.message || JSON.stringify(m.error))) : w.res(m.result); } return; }
    if (m.method) this.onNotify(m);
  }
  serverRequest(m) {
    // Desde el teléfono no se aprueba nada a ciegas: se rechaza (la política «never» hace que casi nunca se pida).
    const decline = m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval";
    log("rechazado:", m.method);
    this.write(decline ? { jsonrpc: "2.0", id: m.id, result: { decision: "decline" } } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "No disponible desde el teléfono." } });
  }
  write(o) { if (this.p) this.p.stdin.write(JSON.stringify(o) + "\n"); }
  async call(method, params, timeout = 60000, noEnsure = false) {
    if (!noEnsure) await this.ensure();
    return new Promise((res, rej) => {
      const id = ++this.id; const t = setTimeout(() => { this.pend.delete(id); rej(new Error("Codex tardó demasiado (" + method + ").")); }, timeout);
      this.pend.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  kill() { try { this.p && this.p.kill(); } catch {} }
}
const codex = new AppServer();
const jobs = new Map();       // jobId -> {threadId, turnId, status, error, sessionId, text}
const loaded = new Set();     // hilos ya reanudados en este app-server
codex.onNotify = (m) => {
  if (m.method === "__exit") { loaded.clear(); for (const j of jobs.values()) if (j.status === "running") { j.status = "error"; j.error = "Codex se cerró durante la tarea."; } return; }
  const p = m.params || {};
  if (m.method === "turn/completed" && p.turn) {
    for (const j of jobs.values()) if (j.threadId === p.threadId && j.turnId === p.turn.id) {
      if (p.turn.status === "failed") { j.status = "error"; j.error = (p.turn.error && (p.turn.error.message || JSON.stringify(p.turn.error))) || "El turno falló."; }
      else if (p.turn.status === "interrupted") { j.status = "cancelled"; }
      else j.status = "done";
    }
  } else if (m.method === "error" && p.willRetry === false) {
    for (const j of jobs.values()) if (j.threadId === p.threadId && j.status === "running") { j.status = "error"; j.error = (p.error && p.error.message) || "Error del modelo."; }
  } else if (m.method === "item/completed" && p.item && p.item.type === "agentMessage") {
    for (const j of jobs.values()) if (j.threadId === p.threadId && j.turnId === p.turnId) j.text = p.item.text;
  }
};

const wsId = (cwd) => crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
const AMBIENT = /<in-app-browser-context[\s\S]*?<\/in-app-browser-context>\s*/g;
function userText(content) {
  const t = (Array.isArray(content) ? content : []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
  const i = t.lastIndexOf("## My request:");
  return (i >= 0 ? t.slice(i + "## My request:".length) : t).replace(AMBIENT, "").trim();
}
function title(t) { return String(t.name || t.preview || "Conversación").replace(/\s+/g, " ").trim().slice(0, 70) || "Conversación"; }

async function workspaces() {
  const threads = [];
  let cursor = null;
  for (let page = 0; page < 3 && threads.length < 150; page++) {
    const r = await codex.call("thread/list", { limit: 60, cursor, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true });
    threads.push(...(r.data || []));
    if (!r.nextCursor) break; cursor = r.nextCursor;
  }
  const by = new Map();
  for (const t of threads) {
    if (t.parentThreadId || t.ephemeral || typeof t.cwd !== "string") continue;
    const w = by.get(t.cwd) || { id: wsId(t.cwd), name: path.basename(t.cwd) || t.cwd, root: t.cwd, sessions: [] };
    const busy = [...jobs.values()].some((j) => j.threadId === t.id && j.status === "running");
    w.sessions.push({ id: t.id, title: title(t), status: busy || (t.status && t.status.type === "active") ? "running" : "idle", updatedAt: (t.updatedAt || 0) * 1000 });
    by.set(t.cwd, w);
  }
  const list = [...by.values()];
  for (const w of list) w.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  list.sort((a, b) => (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0));
  if (!list.length) list.push({ id: wsId(HOME), name: path.basename(HOME), root: HOME, sessions: [] }); // sin hilos aún: la carpeta personal
  return list;
}
async function rootOf(workspaceId) {
  const w = (await workspaces()).find((x) => x.id === workspaceId);
  if (!w) throw new Error("No encuentro esa carpeta de trabajo en ChatGPT 2.");
  return w.root;
}

async function messages(workspaceId, sessionId, limit) {
  const r = await codex.call("thread/turns/list", { threadId: sessionId, limit: Math.min(40, Math.max(1, limit || 30)), sortDirection: "desc" });
  const turns = (r.data || []).slice().reverse();
  const out = [];
  for (const turn of turns) for (const item of turn.items || []) {
    if (item.type === "userMessage") { const t = userText(item.content); if (t) out.push({ role: "user", message: { parts: [{ type: "text", text: t }] } }); }
    else if (item.type === "agentMessage" && item.text) out.push({ role: "assistant", message: { parts: [{ type: "text", text: item.text }] } });
  }
  return out;
}

async function ensureLoaded(threadId) {
  if (loaded.has(threadId)) return;
  await codex.call("thread/resume", { threadId, excludeTurns: true, approvalPolicy: "never", sandbox: settings.permission });
  loaded.add(threadId);
}

async function start(workspaceId, sessionId, text) {
  const root = await rootOf(workspaceId);
  let threadId = sessionId;
  if (threadId) {
    if ([...jobs.values()].some((j) => j.threadId === threadId && j.status === "running")) throw new Error("Ya hay una tarea en curso en esta conversación. Espera o cancélala.");
    await ensureLoaded(threadId);
  } else {
    const t = await codex.call("thread/start", { cwd: root, approvalPolicy: "never", sandbox: settings.permission, ...(settings.model ? { model: settings.model } : {}) });
    threadId = t.thread.id; loaded.add(threadId);
  }
  const r = await codex.call("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], approvalPolicy: "never", ...(settings.model ? { model: settings.model } : {}) });
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { threadId, turnId: r.turn.id, status: "running", error: "", sessionId: threadId, text: "", at: Date.now() });
  for (const [k, j] of jobs) if (j.status !== "running" && Date.now() - j.at > 3600_000) jobs.delete(k);
  return { jobId, sessionId: threadId };
}
async function cancel(workspaceId, sessionId) {
  const j = [...jobs.values()].find((x) => x.threadId === sessionId && x.status === "running");
  if (!j) return { cancelled: false };
  await codex.call("turn/interrupt", { threadId: j.threadId, turnId: j.turnId });
  return { cancelled: true };
}
function job(jobId) {
  const j = jobs.get(jobId);
  if (!j) return { status: "error", error: "No encuentro esa tarea (¿se reinició el agente?)." };
  return { status: j.status, sessionId: j.sessionId, error: j.error || undefined, result: j.text || undefined };
}

function capture() {
  const file = path.join(os.tmpdir(), `chatgpt2-shot-${process.pid}-${Date.now()}.png`);
  const tools = [["spectacle", ["-b", "-n", "-f", "-o", file]], ["grim", [file]], ["gnome-screenshot", ["-f", file]], ["scrot", ["-o", file]], ["import", ["-window", "root", file]]];
  for (const [bin, args] of tools) {
    const r = cp.spawnSync(bin, args, { timeout: 15000, stdio: "ignore" });
    if (r.status === 0 && fs.existsSync(file)) { const b = fs.readFileSync(file); fs.rmSync(file, { force: true }); return b; }
  }
  throw new Error("No encuentro una herramienta de capturas (spectacle, grim, gnome-screenshot, scrot o import).");
}

// ------------------------------------------------------------------ órdenes del teléfono
async function handleCommand(c) {
  if (!c || typeof c !== "object") throw new Error("Orden remota mal formada.");
  const str = (k) => (typeof c[k] === "string" ? c[k] : "");
  switch (c.type) {
    case "status": return { ok: true, workspaces: await workspaces() };
    case "messages": if (!str("workspaceId") || !str("sessionId")) throw new Error("Faltan workspaceId y sessionId."); return { ok: true, messages: await messages(str("workspaceId"), str("sessionId"), 30) };
    case "send": {
      const text = str("text").trim();
      if (!str("workspaceId") || !text) throw new Error("Faltan workspaceId y texto.");
      return { ok: true, ...(await start(str("workspaceId"), str("sessionId") || undefined, text)) };
    }
    case "cancel": if (!str("sessionId")) throw new Error("Falta sessionId."); return { ok: true, ...(await cancel(str("workspaceId"), str("sessionId"))) };
    case "job": if (!str("jobId")) throw new Error("Falta jobId."); return { ok: true, status: job(str("jobId")) };
    case "screenshot": {
      const img = capture();
      if (img.length > 3_500_000) throw new Error("La captura es demasiado grande para el control remoto.");
      return { ok: true, image: img.toString("base64") };
    }
    case "browser": case "external-start": case "external-status": case "external-cancel":
      throw new Error("Esta función no existe en ChatGPT 2 (solo chats de Codex y capturas).");
    default: throw new Error("Orden remota desconocida.");
  }
}

// ------------------------------------------------------------------ control local para la interfaz de Ajustes
function statusObj() {
  const base = { running, configured: !!state, relayUrl: (state && state.relayUrl) || settings.relayUrl || "", settings: { relayUrl: settings.relayUrl, model: settings.model, permission: settings.permission }, jobs: [...jobs.values()].filter((j) => j.status === "running").length };
  if (!state) return base;
  const payload = `F3|${state.relayUrl}|${state.installation}|${state.pairingKey}|${state.encryptionKey}`;
  return { ...base, installation: state.installation.slice(0, 6) + "…", pairingPayload: payload, qr: qrRows(payload) };
}
function hubToken() { try { return fs.readFileSync(path.join(CODEX_HOME, "hub-token"), "utf8").trim(); } catch { return ""; } }
function bodyOf(req) { return new Promise((res) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 20000) req.destroy(); }); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const origin = req.headers.origin;
  if (origin) return send(403, { error: "forbidden" });  // solo procesos locales (el hub), nunca páginas web
  const tok = hubToken();
  if (!tok || req.headers["x-hub-token"] !== tok) return send(403, { error: "forbidden" });
  try {
    const url = req.url.split("?")[0], b = req.method === "GET" ? {} : await bodyOf(req);
    if (req.method === "GET" && url === "/status") return send(200, statusObj());
    if (req.method === "GET" && url === "/devices") return send(200, { devices: await listDevices() });
    if (req.method === "GET" && url === "/log") return send(200, { log: logLines });
    if (req.method === "POST" && url === "/start") return send(200, await startRemote(b.relayUrl));
    if (req.method === "POST" && url === "/stop") { await stopRemote(!!b.revoke); return send(200, statusObj()); }
    if (req.method === "POST" && url === "/rotate") return send(200, await rotateRemote());
    if (req.method === "POST" && url === "/revoke-device") { if (!state) throw new Error("No está activo."); await relay("revoke-device", { deviceId: String(b.id || "") }); return send(200, { ok: true }); }
    if (req.method === "POST" && url === "/settings") {
      if (typeof b.relayUrl === "string") settings.relayUrl = b.relayUrl.trim() ? validateRelayUrl(b.relayUrl) : "";
      if (typeof b.model === "string") settings.model = b.model.trim().slice(0, 120);
      if (typeof b.permission === "string") { if (!PERMISSIONS.includes(b.permission)) throw new Error("Permiso desconocido."); settings.permission = b.permission; loaded.clear(); }
      saveSettings(); return send(200, statusObj());
    }
    send(404, { error: "no encontrado" });
  } catch (e) { send(400, { error: e instanceof Error ? e.message : String(e) }); }
});

if (require.main === module) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  server.on("error", (e) => { console.error("agente remoto:", e.message); process.exit(1); });
  server.listen(PORT, "127.0.0.1", () => {
    if (state) { running = true; lastCommandAt = Date.now(); schedulePoll(); log("reanudado:", state.relayUrl); }
  });
  const bye = () => { codex.kill(); process.exit(0); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
}
module.exports = { handleCommand, startRemote, stopRemote, statusObj, encrypt, decrypt, _setState: (s) => { state = s; }, _jobs: jobs };
