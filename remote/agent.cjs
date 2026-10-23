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
const { IpcClient } = require("./ipc.cjs");
const { Follower, turnsOf, isActive } = require("./follow.cjs");

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
const UPLOADS = path.join(DIR, "uploads");
const MAX_FILE = 40 * 1024 * 1024, MAX_CHUNK = 1_200_000;  // por archivo / por trozo (el relay admite 8 MB por paquete cifrado)
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", zip: "application/zip", mp3: "audio/mpeg", mp4: "video/mp4" };
const mimeOf = (f) => MIME[path.extname(f).slice(1).toLowerCase()] || "application/octet-stream";
const safeName = (n) => String(n || "archivo").split(/[\\/]/).pop().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "archivo";

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
      try { out = await handleCommand(decrypt(env.body)); } catch (e) { out = { ok: false, error: e instanceof Error ? e.message : "La operación remota falló.", ...(e && e.code === "busy" ? { code: "busy" } : {}) }; log("cmd error:", out.error); }
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
const ipc = new IpcClient(CODEX_HOME, (...a) => log(...a));
const follower = new Follower(ipc, (...a) => log(...a), (id, state) => onFollowChange(id, state));
follower.keep = (id) => [...jobs.values()].some((j) => j.owner && j.threadId === id && j.status === "running");
const jobs = new Map();       // jobId -> {threadId, turnId, status, error, sessionId, text}
// Al terminar un turno propio se suelta la conversación para que la app de la PC pueda abrirla y escribir en ella.
function releaseLater(threadId) {
  setTimeout(() => {
    if ([...jobs.values()].some((j) => j.threadId === threadId && j.status === "running")) return;
    codex.call("thread/unsubscribe", { threadId }, 10000).catch(() => {}); loaded.delete(threadId);
  }, 2500).unref?.();
}
const usage = new Map();      // hilo -> último uso de contexto (para /estado)
const loaded = new Set();     // hilos ya reanudados en este app-server
codex.onNotify = (m) => {
  if (m.method === "__exit") { loaded.clear(); for (const j of jobs.values()) if (j.status === "running") { j.status = "error"; j.error = "Codex se cerró durante la tarea."; } return; }
  const p = m.params || {};
  if (m.method === "turn/completed" && p.turn) {
    for (const j of jobs.values()) if (j.kind === "compact" && j.threadId === p.threadId && j.status === "running") { j.status = "done"; j.text = "Contexto compactado."; }
    for (const j of jobs.values()) if (j.threadId === p.threadId && j.turnId === p.turn.id) {
      if (p.turn.status === "failed") { j.status = "error"; j.error = (p.turn.error && (p.turn.error.message || JSON.stringify(p.turn.error))) || "El turno falló."; }
      else if (p.turn.status === "interrupted") { j.status = "cancelled"; }
      else j.status = "done";
      if (!j.owner) releaseLater(p.threadId);
    }
  } else if (m.method === "error" && p.willRetry === false) {
    for (const j of jobs.values()) if (j.threadId === p.threadId && j.status === "running") { j.status = "error"; j.error = (p.error && p.error.message) || "Error del modelo."; }
  } else if (m.method === "thread/tokenUsage/updated" && p.tokenUsage) {
    usage.set(p.threadId, p.tokenUsage);
  } else if (m.method === "thread/compacted") {
    for (const j of jobs.values()) if (j.kind === "compact" && j.threadId === p.threadId && j.status === "running") { j.status = "done"; j.text = "Contexto compactado."; }
  } else if (m.method === "item/agentMessage/delta") {
    for (const j of jobs.values()) if (j.threadId === p.threadId && j.turnId === p.turnId && j.status === "running") {
      if (j.itemId !== p.itemId) { j.itemId = p.itemId; j.partial = ""; }
      j.partial += p.delta || "";
    }
  } else if ((m.method === "item/started" || m.method === "item/completed") && p.item) {
    for (const j of jobs.values()) if (j.threadId === p.threadId && j.turnId === p.turnId) {
      if (m.method === "item/completed" && p.item.type === "agentMessage") { j.text = p.item.text; j.partial = ""; }
      const a = activityOf(p.item);
      if (a) { const i = j.activity.findIndex((x) => x.id === p.item.id); if (i >= 0) j.activity[i] = { ...a, id: p.item.id }; else { j.activity.push({ ...a, id: p.item.id }); if (j.activity.length > 8) j.activity.shift(); } }
    }
  }
};

function activityOf(item) {
  const cmd = (c) => (Array.isArray(c) ? c.join(" ") : String(c || ""));
  if (item.type === "commandExecution") return { kind: "command", text: cmd(item.command).slice(0, 200), status: item.status || "" };
  if (item.type === "fileChange") return { kind: "file", text: (item.changes || []).map((c) => c.path).filter(Boolean).slice(0, 4).join(", ") || "Cambios en archivos", status: item.status || "" };
  if (item.type === "webSearch") return { kind: "web", text: String(item.query || "Búsqueda web").slice(0, 120), status: item.status || "" };
  if (item.type === "mcpToolCall") return { kind: "tool", text: `${item.server || ""}.${item.tool || ""}`.slice(0, 120), status: item.status || "" };
  return null;
}

const wsId = (cwd) => crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
const AMBIENT = /<in-app-browser-context[\s\S]*?<\/in-app-browser-context>\s*/g;
function userText(content) {
  const t = (Array.isArray(content) ? content : []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
  const i = t.lastIndexOf("## My request:");
  return (i >= 0 ? t.slice(i + "## My request:".length) : t).replace(AMBIENT, "").replace(/\n*\[Archivos adjuntos\][\s\S]*$/, "").trim();
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
  const r = await codex.call("thread/turns/list", { threadId: sessionId, limit: Math.min(40, Math.max(1, limit || 30)), sortDirection: "desc", itemsView: "full" });
  let turns = (r.data || []).slice().reverse();
  // Si la app de la PC tiene la conversación, su estado en vivo manda: el disco va unos segundos atrasado y marca como «interrupted» el turno que está corriendo.
  const state = await follower.ensure(sessionId, 2500).catch(() => null);
  if (state) {
    const live = turnsOf(state), byId = new Map(live.map((t) => [t.turnId, t])), lastId = turns.length ? turns[turns.length - 1].id : "";
    turns = turns.map((t) => (byId.has(t.id) ? { id: t.id, items: byId.get(t.id).items || [] } : t));
    const ids = new Set(turns.map((t) => t.id));
    for (const t of live) if (!ids.has(t.turnId) && (!lastId || t.turnId > lastId)) turns.push({ id: t.turnId, items: t.items || [] });
  }
  const out = [];
  const part = (t) => ({ message: { parts: [{ type: "text", text: t }] } });
  for (const turn of turns) for (const item of turn.items || []) {
    if (item.type === "userMessage") {
      const t = userText(item.content);
      const files = (Array.isArray(item.content) ? item.content : []).filter((c) => c && (c.type === "localImage" || c.type === "mention") && typeof c.path === "string").map((c) => ({ path: c.path, name: c.name || path.basename(c.path), image: c.type === "localImage" || IMAGE_EXT.test(c.path) }));
      if (t || files.length) out.push({ role: "user", ...part(t), ...(files.length ? { files } : {}) });
    }
    else if (item.type === "imageGeneration" && item.savedPath) out.push({ role: "tool", kind: "image", status: item.status || "", ...part(path.basename(String(item.savedPath))), files: [{ path: String(item.savedPath), name: path.basename(String(item.savedPath)), image: true }] });
    else if (item.type === "agentMessage" && item.text) out.push({ role: "assistant", ...part(item.text) });
    else { const a = activityOf(item); if (a) out.push({ role: "tool", kind: a.kind, status: a.status, exitCode: item.exitCode, ...part(a.text) }); }
  }
  return out.slice(-400);  // hilos muy largos (p. ej. automatizaciones): solo lo más reciente
}

async function models() {
  const r = await codex.call("model/list", { limit: 200 });
  let def = settings.model || "";
  if (!def) { try { const m = /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(CODEX_HOME, "config.toml"), "utf8")); if (m) def = m[1]; } catch {} }
  const list = (r.data || []).filter((m) => !m.hidden).map((m) => ({ id: m.id, name: m.displayName || m.id, efforts: (m.supportedReasoningEfforts || []).map((e) => (typeof e === "string" ? e : e.reasoningEffort || e.effort)).filter(Boolean), effort: m.defaultReasoningEffort || "" }));
  return { models: list, default: def };
}

async function ensureLoaded(threadId) {
  if (loaded.has(threadId)) return;
  await codex.call("thread/resume", { threadId, excludeTurns: true, approvalPolicy: "never", sandbox: settings.permission });
  loaded.add(threadId);
}

// Cada cambio que manda la app de la PC (texto que se escribe, comandos, fin del turno) actualiza las tareas que lanzó el teléfono.
const textOfLast = (t) => { const it = (t.items || []); const last = it[it.length - 1]; return last && last.type === "agentMessage" ? String(last.text || "") : ""; };
function onFollowChange(threadId, state) {
  if (state.latestTokenUsageInfo) usage.set(threadId, state.latestTokenUsageInfo);
  for (const j of jobs.values()) {
    if (!j.owner || j.status !== "running" || j.threadId !== threadId) continue;
    if (j.kind === "compact") { if (isActive(state)) j.sawActive = true; else if (j.sawActive || Date.now() - j.at > 8000) { j.status = "done"; j.text = "Contexto compactado."; } continue; }
    const t = turnsOf(state).find((x) => x.turnId === j.turnId); if (!t) continue;
    const v = turnView(t); j.activity = v.activity;
    if (!t.status || t.status === "inProgress") { j.partial = textOfLast(t); j.text = ""; continue; }
    j.partial = ""; j.text = v.text;
    if (t.status === "failed") { j.status = "error"; j.error = (t.error && (t.error.message || JSON.stringify(t.error))) || "El turno falló."; }
    else if (t.status === "interrupted") j.status = "cancelled";
    else j.status = "done";
  }
}
// Pide a la app de la PC que abra la conversación (enlace profundo codex://threads/ID a la instancia ya abierta): al abrirla pasa a ser su dueña
// y entonces se le pueden mandar órdenes por el IPC. Solo si la app está corriendo; nunca arranca una app nueva.
async function openInDesktop(threadId) {
  try { await ipc.connect(); } catch { return false; }
  if (await follower.owns(threadId, true)) return true;
  const bin = process.env.CHATGPT2_APP_BIN || path.join(ROOT, "ChatGPT");
  if (!fs.existsSync(bin)) return false;
  const c = cp.spawn(bin, [`--user-data-dir=${process.env.CHATGPT2_USER_DATA || path.join(HOME, ".config", "Codex-2")}`, `codex://threads/${threadId}`], { detached: true, stdio: "ignore", env: { ...process.env, CODEX_HOME } });
  c.on("error", () => {}); c.unref();
  for (let i = 0; i < 25; i++) { await new Promise((r) => setTimeout(r, 400)); if (await follower.owns(threadId, true)) return true; }
  return false;
}
async function lastTurns(threadId, n) {
  const r = await codex.call("thread/turns/list", { threadId, limit: n || 2, sortDirection: "desc", itemsView: "full" });
  return r.data || [];
}
// Estado de un turno leído del historial (sirve para turnos que corre la app de la PC, de los que no llegan notificaciones).
function turnView(turn) {
  const activity = [];
  let text = "";
  for (const item of turn.items || []) {
    if (item.type === "agentMessage" && item.text) text = item.text;
    const a = activityOf(item); if (a) { activity.push({ ...a, id: item.id }); if (activity.length > 8) activity.shift(); }
  }
  return { activity, text };
}
// Respaldo por si el seguimiento en vivo falla: lee el historial del disco. Ojo: un turno que corre en otro proceso se lee ahí como
// «interrupted» hasta que termina, así que solo se confía en «completed» y «failed».
function watchOwnerJob(jobId) {
  const j = jobs.get(jobId); if (!j) return;
  let misses = 0;
  const timer = setInterval(async () => {
    if (j.status !== "running") return clearInterval(timer);
    if (Date.now() - j.at > 6 * 3600_000) { j.status = "error"; j.error = "La tarea tardó demasiado."; return clearInterval(timer); }
    if (j.kind === "compact" && Date.now() - j.at > 120_000) { j.status = "done"; j.text = "Contexto compactado."; return clearInterval(timer); }
    if (j.kind === "compact") { const st = follower.get(j.threadId); if (st && !isActive(st) && Date.now() - j.at > 6000) { j.status = "done"; j.text = "Contexto compactado."; clearInterval(timer); } return; }
    try {
      const turn = (await lastTurns(j.threadId, 3)).find((t) => t.id === j.turnId);
      if (!turn) { if (++misses > 30) { j.status = "error"; j.error = "No encuentro el turno en el historial."; clearInterval(timer); } return; }
      if (turn.status === "completed" || turn.status === "failed") {
        const v = turnView(turn); j.activity = v.activity; j.partial = ""; j.text = v.text;
        if (turn.status === "failed") { j.status = "error"; j.error = (turn.error && (turn.error.message || JSON.stringify(turn.error))) || "El turno falló."; } else j.status = "done";
        clearInterval(timer);
      }
    } catch { /* un fallo suelto al leer no corta el seguimiento */ }
  }, 3000);
  timer.unref?.();
}
// Resumen barato del estado de una conversación: el teléfono lo consulta cada pocos segundos para enterarse de lo que se hace en la PC.
async function pollThread(threadId) {
  const state = await follower.ensure(threadId, 2500);
  if (state) {
    const run = turnsOf(state).filter((t) => !t.status || t.status === "inProgress").pop(), last = turnsOf(state).pop();
    const t = run || last;
    const v = t ? turnView(t) : { activity: [] };
    return { rev: String(t ? t.turnId + ":" + (t.status || "") + ":" + (t.items || []).length : "0"), running: isActive(state) || !!run, turnId: t ? t.turnId : "", activity: run ? v.activity : [], partial: run ? textOfLast(run) : "", live: true };
  }
  const t = (await lastTurns(threadId, 1))[0];
  if (!t) return { rev: "0", running: false, activity: [] };
  return { rev: `${t.id}:${t.status}:${(t.items || []).length}`, running: false, turnId: t.id, activity: [] };   // sin seguimiento en vivo no se sabe si corre (el disco marca «interrupted» durante el turno)
}
async function runningTurn(threadId) {
  const state = follower.get(threadId) || await follower.ensure(threadId, 1500);
  if (state) return turnsOf(state).filter((t) => !t.status || t.status === "inProgress").map((t) => ({ id: t.turnId })).pop() || (isActive(state) ? { id: "" } : null);
  try { return (await lastTurns(threadId, 1)).find((t) => t.status === "inProgress") || null; } catch { return null; }
}

async function start(workspaceId, sessionId, text, model, effort, attachments, fork, ephemeral) {
  model = (typeof model === "string" && model.trim()) || settings.model || "";
  const root = await rootOf(workspaceId);
  const input = [], files = [];
  for (const a of Array.isArray(attachments) ? attachments.slice(0, 8) : []) { const f = uploadedFile(a && a.id); files.push(f); input.push(IMAGE_EXT.test(f.path) ? { type: "localImage", path: f.path } : { type: "mention", name: f.name, path: f.path }); }
  const full = files.length ? `${text}\n\n[Archivos adjuntos]\n${files.map((f) => `- ${f.name}: ${f.path}`).join("\n")}` : text;
  input.unshift({ type: "text", text: full, text_elements: [] });
  const eff = typeof effort === "string" && /^[a-z]{3,10}$/.test(effort) ? effort : "";
  let threadId = sessionId;
  if (threadId) {
    if ([...jobs.values()].some((j) => j.threadId === threadId && j.status === "running")) throw new Error("Ya hay una tarea en curso en esta conversación. Espera o cancélala.");
    // Si la app de la PC tiene la conversación, la orden se la damos a ella (misma conversación, sin copias): ambos lados ven lo mismo al instante.
    let viaDesktop = await follower.owns(threadId);
    if (!viaDesktop) {
      try { await ensureLoaded(threadId); }
      catch (e) {
        if (!/active writer/i.test(String(e.message))) throw e;
        // La app de la PC tiene la conversación cargada (p. ej. una automatización) pero ninguna ventana la sigue: se le pide que la abra.
        viaDesktop = await openInDesktop(threadId);
        if (!viaDesktop) { const err = new Error("La app de la PC tiene bloqueada esta conversación y no se pudo abrir sola. Ábrela en la PC e inténtalo de nuevo."); err.code = "busy"; throw err; }
      }
    }
    if (viaDesktop) {
      await follower.ensure(threadId, 3000);
      if (await runningTurn(threadId)) throw new Error("La conversación está respondiendo en la PC. Espera a que termine o detenla.");
      const r = await ipc.call("thread-follower-start-turn", { conversationId: threadId, turnStart: { request: { threadId, input, ...(model ? { model } : {}), ...(eff ? { effort: eff } : {}) }, context: {} } }, { timeoutMs: 30000 });
      const jobId = newJob({ threadId, turnId: r.result.turn.id, sessionId: threadId, owner: true });
      watchOwnerJob(jobId);
      return { jobId, sessionId: threadId };
    }
  } else {
    const t = await codex.call("thread/start", { cwd: root, approvalPolicy: "never", sandbox: settings.permission, ...(ephemeral ? { ephemeral: true } : {}), ...(model ? { model } : {}) });
    threadId = t.thread.id; loaded.add(threadId);
  }
  const r = await codex.call("turn/start", { threadId, input, approvalPolicy: "never", ...(model ? { model } : {}), ...(eff ? { effort: eff } : {}) });
  const jobId = newJob({ threadId, turnId: r.turn.id, sessionId: threadId });
  return { jobId, sessionId: threadId };
}
async function cancel(workspaceId, sessionId) {
  const j = [...jobs.values()].find((x) => x.threadId === sessionId && x.status === "running");
  const turnId = (j ? j.turnId : (await runningTurn(sessionId) || {}).id) || undefined;
  if (!j && !turnId) return { cancelled: false };
  if (await ipc.ownsThread(sessionId)) await ipc.call("thread-follower-interrupt-turn", { conversationId: sessionId, mode: "user-stop", expectedTurnId: turnId });
  else await codex.call("turn/interrupt", { threadId: sessionId, turnId });
  return { cancelled: true };
}
function job(jobId) {
  const j = jobs.get(jobId);
  if (!j) return { status: "error", error: "No encuentro esa tarea (¿se reinició el agente?)." };
  return { status: j.status, sessionId: j.sessionId, error: j.error || undefined, result: j.text || undefined, partial: j.partial || undefined, activity: j.activity.length ? j.activity : undefined };
}

// ------------------------------------------------------------------ archivos que sube el teléfono
function uploadChunk(c) {
  const id = String(c.uploadId || ""), index = Number(c.index), total = Number(c.total);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total || total > 80) throw new Error("Trozo de archivo no válido.");
  const data = Buffer.from(String(c.data || ""), "base64");
  if (!data.length || data.length > MAX_CHUNK) throw new Error("Trozo de archivo demasiado grande.");
  const dir = path.join(UPLOADS, id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const part = path.join(dir, ".partial"), meta = path.join(dir, ".meta.json");
  if (index === 0) { fs.rmSync(part, { force: true }); fs.writeFileSync(meta, JSON.stringify({ name: safeName(c.name), total })); }
  const m = readJson(meta, null); if (!m) throw new Error("Subida desconocida.");
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (index > 0 && have === 0) throw new Error("Falta el principio del archivo.");
  if (have + data.length > MAX_FILE) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error("El archivo supera los 40 MB."); }
  fs.appendFileSync(part, data, { mode: 0o600 });
  if (index === total - 1) { const final = path.join(dir, m.name); fs.renameSync(part, final); fs.chmodSync(final, 0o600); return { done: true, name: m.name, size: fs.statSync(final).size }; }
  return { done: false };
}
function uploadedFile(id) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id))) throw new Error("Adjunto no válido.");
  const dir = path.join(UPLOADS, String(id)), m = readJson(path.join(dir, ".meta.json"), null);
  const f = m && path.join(dir, m.name);
  if (!f || !fs.existsSync(f)) throw new Error("El adjunto no llegó completo; vuelve a subirlo.");
  return { path: f, name: m.name };
}
function cleanUploads() { try { for (const d of fs.readdirSync(UPLOADS)) { const p = path.join(UPLOADS, d); if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400_000) fs.rmSync(p, { recursive: true, force: true }); } } catch {} }

// ------------------------------------------------------------------ archivos que ve el teléfono (solo dentro de zonas permitidas)
async function allowedRoots() {
  const roots = [path.join(CODEX_HOME, "generated_images"), UPLOADS];
  try { for (const w of await workspaces()) roots.push(w.root); } catch {}
  return roots.map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean);
}
async function readFileChunk(p, offset, length) {
  const file = String(p || "");
  if (!path.isAbsolute(file) || file.includes("\u0000")) throw new Error("Ruta no permitida.");
  let real; try { real = fs.realpathSync(file); } catch { throw new Error("No encuentro ese archivo."); }
  const roots = await allowedRoots();
  if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) throw new Error("Ese archivo está fuera de las carpetas de tus proyectos.");
  const st = fs.statSync(real); if (!st.isFile()) throw new Error("No es un archivo.");
  if (st.size > MAX_FILE) throw new Error("El archivo supera los 40 MB.");
  const off = Math.max(0, Number(offset) || 0), len = Math.min(MAX_CHUNK - 1000, Math.max(1, Number(length) || 600_000));
  const fd = fs.openSync(real, "r"); const buf = Buffer.alloc(Math.min(len, Math.max(0, st.size - off)));
  try { fs.readSync(fd, buf, 0, buf.length, off); } finally { fs.closeSync(fd); }
  return { name: path.basename(real), size: st.size, mime: mimeOf(real), offset: off, data: buf.toString("base64"), done: off + buf.length >= st.size };
}

// ------------------------------------------------------------------ automatizaciones (las mismas de la app de escritorio)
function parseToml(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/.exec(line); if (!m) continue;
    let v = m[2];
    if (/^"/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^-?\d+$/.test(v)) v = Number(v); else if (v === "true" || v === "false") v = v === "true";
    out[m[1]] = v;
  }
  return out;
}
const DAYS = { MO: "lunes", TU: "martes", WE: "miércoles", TH: "jueves", FR: "viernes", SA: "sábado", SU: "domingo" };
function humanRrule(rr) {
  const r = {}; for (const kv of String(rr || "").replace(/^RRULE:/, "").split(";")) { const [k, v] = kv.split("="); if (k) r[k] = v; }
  const hours = (r.BYHOUR || "").split(",").filter(Boolean).map(Number), min = Number(r.BYMINUTE || 0), iv = Number(r.INTERVAL || 1);
  const hh = (h) => String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
  const list = (a) => (a.length > 1 ? a.slice(0, -1).join(", ") + " y " + a.at(-1) : a[0] || "");
  const days = (r.BYDAY || "").split(",").filter(Boolean).map((d) => DAYS[d.replace(/^[-+]?\d+/, "")]).filter(Boolean);
  if (r.FREQ === "DAILY") return (iv > 1 ? `Cada ${iv} días` : "Todos los días") + (hours.length ? " a las " + list(hours.map(hh)) : "");
  if (r.FREQ === "WEEKLY") return (days.length ? "Cada " + list(days) : iv > 1 ? `Cada ${iv} semanas` : "Cada semana") + (hours.length ? " a las " + list(hours.map(hh)) : "");
  if (r.FREQ === "HOURLY") return iv > 1 ? `Cada ${iv} horas` : "Cada hora";
  if (r.FREQ === "MINUTELY") return `Cada ${iv} minutos`;
  if (r.FREQ === "MONTHLY") return (iv > 1 ? `Cada ${iv} meses` : "Cada mes") + (hours.length ? " a las " + list(hours.map(hh)) : "");
  return String(rr || "");
}
function runtimeState() {  // próxima/última ejecución que calcula la app de escritorio (su base de datos, solo lectura)
  const db = path.join(CODEX_HOME, "sqlite", "codex-dev.db");
  if (!fs.existsSync(db)) return {};
  const py = "import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=3)\nprint(json.dumps({r[0]:{'status':r[1],'next':r[2],'last':r[3]} for r in c.execute('select id,status,next_run_at,last_run_at from automations')}))";
  const r = cp.spawnSync("python3", ["-I", "-c", py, db], { timeout: 8000, encoding: "utf8" });
  try { return JSON.parse(r.stdout || "{}"); } catch { return {}; }
}
function automations() {
  const dir = path.join(CODEX_HOME, "automations"), rt = runtimeState(), out = [];
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) {
    let t; try { t = parseToml(fs.readFileSync(path.join(dir, n, "automation.toml"), "utf8")); } catch { continue; }
    if (!t.id) continue;
    const r = rt[t.id] || {};
    out.push({ id: t.id, name: String(t.name || t.id), status: String(r.status || t.status || "ACTIVE"), kind: String(t.kind || ""), schedule: humanRrule(t.rrule), rrule: String(t.rrule || ""), nextRunAt: r.next || null, lastRunAt: r.last || null,
      model: String(t.model || ""), effort: String(t.reasoning_effort || ""), threadId: String(t.target_thread_id || "") });
  }
  return out.sort((a, b) => (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity));
}

// ------------------------------------------------------------------ comandos «/» (los mismos de Codex que tienen equivalente en el teléfono)
async function needWriter(threadId) {
  try { await ensureLoaded(threadId); }
  catch (e) { if (/active writer/i.test(String(e.message))) { const err = new Error("Esa acción no se puede hacer desde el teléfono mientras la app de la PC tiene la conversación abierta. Hazla desde la PC (o usa /bifurcar para trabajar en una copia)."); err.code = "busy"; throw err; } throw e; }
}
const sid = (c) => { const v = typeof c.sessionId === "string" ? c.sessionId : ""; if (!/^[\w-]{4,64}$/.test(v)) throw new Error("Primero abre o crea una conversación."); return v; };
function newJob(extra) { const jobId = crypto.randomUUID(); jobs.set(jobId, { status: "running", error: "", text: "", partial: "", itemId: "", activity: [], at: Date.now(), ...extra }); for (const [k, j] of jobs) if (j.status !== "running" && Date.now() - j.at > 3600_000) jobs.delete(k); return jobId; }
async function slash(c) {
  switch (c.cmd) {
    case "compact": {
      const threadId = sid(c);
      let viaDesktop = await follower.owns(threadId);
      if (!viaDesktop) { try { await ensureLoaded(threadId); } catch (e) { if (/active writer/i.test(String(e.message))) viaDesktop = await openInDesktop(threadId); else throw e; } }
      if (viaDesktop) {
        await follower.ensure(threadId, 3000);
        const jobId = newJob({ kind: "compact", threadId, turnId: "", sessionId: threadId, owner: true });   // antes de la orden: así no se pierde el primer cambio de estado
        try { await ipc.call("thread-follower-compact-thread", { conversationId: threadId }); } catch (e) { jobs.delete(jobId); throw e; }
        watchOwnerJob(jobId);
        return { jobId, sessionId: threadId };
      }
      await needWriter(threadId); await codex.call("thread/compact/start", { threadId });
      const jobId = newJob({ kind: "compact", threadId, turnId: "", sessionId: threadId });
      setTimeout(() => { const j = jobs.get(jobId); if (j && j.status === "running") { j.status = "done"; j.text = "Contexto compactado."; } }, 120000).unref?.();
      return { jobId, sessionId: threadId };
    }
    case "review": {
      const threadId = sid(c), t = c.target || {}; let target;
      if (t.type === "uncommittedChanges") target = { type: "uncommittedChanges" };
      else if (t.type === "baseBranch" && /^[\w][\w./-]{0,199}$/.test(String(t.branch))) target = { type: "baseBranch", branch: String(t.branch) };
      else if (t.type === "commit" && /^[0-9a-fA-F]{7,40}$/.test(String(t.sha))) target = { type: "commit", sha: String(t.sha), title: null };
      else if (t.type === "custom" && typeof t.instructions === "string" && t.instructions.trim() && t.instructions.length < 2000) target = { type: "custom", instructions: t.instructions.trim() };
      else throw new Error("Elige qué revisar: cambios sin confirmar, una rama, un commit o instrucciones propias.");
      await needWriter(threadId);
      const r = await codex.call("review/start", { threadId, target, delivery: "inline" });
      const id = r.reviewThreadId || threadId; loaded.add(id);
      return { jobId: newJob({ threadId: id, turnId: r.turn.id, sessionId: id }), sessionId: id };
    }
    case "rename": { const name = String(c.name || "").trim().slice(0, 120); if (!name) throw new Error("Escribe el nombre nuevo: /renombrar mi nombre."); await codex.call("thread/name/set", { threadId: sid(c), name }); return { name }; }
    case "archive": { const threadId = sid(c); await codex.call("thread/archive", { threadId }); loaded.delete(threadId); return {}; }
    case "fork": { const f = await codex.call("thread/fork", { threadId: sid(c), excludeTurns: true, approvalPolicy: "never", sandbox: settings.permission }); loaded.add(f.thread.id); return { sessionId: f.thread.id, title: title(f.thread) }; }
    case "goal": {
      const threadId = sid(c), act = String(c.action || "get");
      if (act === "clear") { await codex.call("thread/goal/clear", { threadId }); return { goal: null }; }
      if (act === "set") { const objective = String(c.objective || "").trim().slice(0, 2000); if (!objective) throw new Error("Escribe el objetivo: /objetivo terminar la migración."); await needWriter(threadId); const r = await codex.call("thread/goal/set", { threadId, objective }); return { goal: r.goal || null }; }
      const r = await codex.call("thread/goal/get", { threadId }); return { goal: r.goal || null };
    }
    case "info": {
      const out = { permission: settings.permission, model: settings.model || "", relay: state ? state.relayUrl : "" };
      if (!out.model) { try { const m = /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(CODEX_HOME, "config.toml"), "utf8")); if (m) out.model = m[1]; } catch {} }
      if (typeof c.sessionId === "string" && /^[\w-]{4,64}$/.test(c.sessionId)) {
        await follower.ensure(c.sessionId, 1500).catch(() => null);
        try {
          const t = (await codex.call("thread/read", { threadId: c.sessionId, includeTurns: false })).thread;
          out.thread = { id: t.id, name: t.name || "", cwd: t.cwd, model: t.model || "", provider: t.modelProvider || "", createdAt: t.createdAt, updatedAt: t.updatedAt, status: t.status && t.status.type, branch: t.gitInfo && t.gitInfo.branch || "" };
        } catch (e) { out.threadError = e.message; }
        const u = usage.get(c.sessionId);
        if (u) out.context = { used: u.last && u.last.totalTokens || 0, total: u.total && u.total.totalTokens || 0, window: u.modelContextWindow || null };
      }
      try { out.rateLimits = await codex.call("account/rateLimits/read", {}, 8000); } catch { out.rateLimits = null; }
      return out;
    }
    case "mcp": {
      const r = await codex.call("mcpServerStatus/list", {}, 30000);
      return { servers: (r.data || []).map((x) => ({ name: x.name, status: typeof x.runtimeStatus === "string" ? x.runtimeStatus : (x.runtimeStatus && (x.runtimeStatus.status || x.runtimeStatus.state || x.runtimeStatus.type)) || "", auth: x.authStatus || "", tools: Object.keys(x.tools || {}).length, error: x.toolsError || "" })) };
    }
    case "skills": {
      const root = await rootOf(String(c.workspaceId || ""));
      const r = await codex.call("skills/list", { cwds: [root], forceReload: false }, 30000);
      const seen = new Set(), skills = [];
      for (const e of r.data || []) for (const k of e.skills || []) if (k.enabled && !seen.has(k.name)) { seen.add(k.name); skills.push({ name: k.name, description: String(k.shortDescription || k.description || "").slice(0, 160) }); }
      return { skills };
    }
    case "files": {
      const root = await rootOf(String(c.workspaceId || "")), q = String(c.query || "").trim().slice(0, 80);
      if (!q) return { files: [] };
      const r = await codex.call("fuzzyFileSearch", { query: q, roots: [root] }, 20000);
      return { files: (r.files || []).slice(0, 30).map((f) => ({ path: String(f.path), name: String(f.file_name || path.basename(f.path)) })) };
    }
    case "diff": {
      const root = await rootOf(String(c.workspaceId || ""));
      const git = (...a) => cp.spawnSync("git", ["-C", root, ...a], { encoding: "utf8", timeout: 15000, maxBuffer: 4_000_000 });
      const top = git("rev-parse", "--show-toplevel"); if (top.status !== 0) throw new Error("Esta carpeta no es un repositorio git.");
      const status = git("status", "--short").stdout || "", stat = git("diff", "--no-color", "--stat").stdout || "";
      let patch = git("diff", "--no-color").stdout || ""; const truncated = patch.length > 60000; if (truncated) patch = patch.slice(0, 60000);
      return { branch: (git("rev-parse", "--abbrev-ref", "HEAD").stdout || "").trim(), status, stat, patch, truncated };
    }
    case "permission": {
      const v = String(c.value || "");
      if (v === "danger-full-access") throw new Error("El acceso completo solo se activa desde Ajustes en la app de la PC.");
      if (v !== "read-only" && v !== "workspace-write") throw new Error("Permiso desconocido.");
      settings.permission = v; saveSettings(); loaded.clear(); return { permission: v };
    }
    default: throw new Error("Comando desconocido.");
  }
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
      const text = str("text").trim() || (Array.isArray(c.attachments) && c.attachments.length ? "Mira los archivos adjuntos." : "");
      if (!str("workspaceId") || !text) throw new Error("Faltan workspaceId y texto.");
      return { ok: true, ...(await start(str("workspaceId"), str("sessionId") || undefined, text, c.model, c.effort, c.attachments, c.fork === true, c.ephemeral === true)) };
    }
    case "models": return { ok: true, ...(await models()) };
    case "poll": { if (!str("sessionId")) throw new Error("Falta sessionId."); return { ok: true, ...(await pollThread(str("sessionId"))) }; }
    case "slash": return { ok: true, ...(await slash(c)) };
    case "automations": return { ok: true, automations: automations(), now: Date.now() };
    case "upload": return { ok: true, ...uploadChunk(c) };
    case "file": return { ok: true, ...(await readFileChunk(c.path, c.offset, c.length)) };
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
  cleanUploads();
  server.on("error", (e) => { console.error("agente remoto:", e.message); process.exit(1); });
  server.listen(PORT, "127.0.0.1", () => {
    if (state) { running = true; lastCommandAt = Date.now(); schedulePoll(); log("reanudado:", state.relayUrl); }
  });
  const bye = () => { codex.kill(); process.exit(0); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
}
module.exports = { humanRrule, handleCommand, startRemote, stopRemote, statusObj, encrypt, decrypt, _setState: (s) => { state = s; }, _jobs: jobs };
