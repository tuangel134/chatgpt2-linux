"use strict";
// Prueba de punta a punta del agente remoto con un relay falso, un Codex falso y un «teléfono» falso que habla el protocolo
// de la app Android (emparejar por QR, órdenes cifradas AES-GCM, respuestas). Ejecuta: node --test remote/test/
const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRelay } = require("./fake-relay.cjs");
const { Phone } = require("./phone.cjs");

const RELAY_PORT = 18910, AGENT_PORT = 18911;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "c2remote-"));
const TOKEN = "hub-token-de-prueba";
let agent, relay, phone;

const control = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${AGENT_PORT}${p}`, { method, headers: { "X-Hub-Token": TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test.before(async () => {
  relay = createRelay();
  await new Promise((r) => relay.server.listen(RELAY_PORT, "127.0.0.1", r));
  fs.mkdirSync(path.join(TMP, "codex-home"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "codex-home", "hub-token"), TOKEN);
  agent = cp.spawn(process.execPath, [path.join(__dirname, "..", "agent.cjs")], {
    env: { ...process.env, CODEX_HOME: path.join(TMP, "codex-home"), HOME: TMP, CHATGPT2_REMOTE_PORT: String(AGENT_PORT), CHATGPT2_CODEX_BIN: path.join(__dirname, "fake-codex.cjs"),
      CHATGPT2_REMOTE_ALLOW_LOOPBACK: "1", CHATGPT2_REMOTE_POLL_FAST_MS: "60", CHATGPT2_REMOTE_POLL_IDLE_MS: "60" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${AGENT_PORT}/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const s = await control("POST", "/start", { relayUrl: `http://127.0.0.1:${RELAY_PORT}` });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.match(s.body.pairingPayload, /^F3\|http:\/\/127\.0\.0\.1:18910\|.{32}\|.{43}\|.{43}$/);
  assert.equal(s.body.qr.length, 49);
  phone = new Phone(s.body.pairingPayload);
  assert.equal((await phone.pair()).status, 200);
});
test.after(() => { agent && agent.kill(); relay && relay.server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test("control local exige el token del hub y rechaza páginas web", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${AGENT_PORT}/status`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${AGENT_PORT}/status`, { headers: { "X-Hub-Token": TOKEN, Origin: "https://evil.example" } })).status, 403);
});

test("el QR de emparejamiento solo sirve una vez", async () => {
  const again = new Phone((await control("GET", "/status")).body.pairingPayload);
  assert.equal((await again.pair()).status, 401);
});

test("sin el token de dispositivo el relay rechaza al teléfono", async () => {
  const stranger = new Phone("F3|" + phone.url + "|" + phone.inst + "|" + phone.pairKey + "|" + phone.encKey);
  stranger.token = "x".repeat(43);
  const r = await stranger.raw("command", { "X-Forja-Device-Token": stranger.token }, { id: "12345678", body: { iv: "a".repeat(16), ciphertext: "b".repeat(30) } });
  assert.equal(r.status, 401);
});

test("estado: carpetas y conversaciones de Codex (sin subagentes)", async () => {
  const r = await phone.ask({ type: "status" });
  assert.equal(r.ok, true);
  const names = r.workspaces.map((w) => w.name).sort();
  assert.deepEqual(names, ["bot", "web"]);
  const web = r.workspaces.find((w) => w.name === "web");
  assert.equal(web.root, "/work/web");
  assert.deepEqual(web.sessions.map((s) => s.id), ["t-alpha"]);          // t-sub es de un subagente
  assert.equal(web.sessions[0].title, "Arreglar la página");
  const bot = r.workspaces.find((w) => w.name === "bot");
  assert.ok(bot.sessions[0].title.length <= 70);
});

test("mensajes: texto de usuario y de asistente, sin ruido del navegador ni herramientas", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const r = await phone.ask({ type: "messages", workspaceId: ws.id, sessionId: "t-alpha" });
  assert.deepEqual(r.messages.map((m) => [m.role, m.message.parts[0].text]), [["user", "hola, arregla el título"], ["assistant", "Listo, cambié el título."]]);
});

test("enviar a una conversación existente: tarea, estado y resultado", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const s = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "Haz algo" });
  assert.equal(s.ok, true); assert.equal(s.sessionId, "t-alpha"); assert.ok(s.jobId);
  let st;
  for (let i = 0; i < 40; i++) { st = (await phone.ask({ type: "job", jobId: s.jobId })).status; if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.status, "done"); assert.equal(st.result, "Respuesta a: Haz algo"); assert.equal(st.sessionId, "t-alpha");
});

test("enviar sin conversación crea un hilo nuevo en esa carpeta", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "bot");
  const s = await phone.ask({ type: "send", workspaceId: ws.id, text: "Nueva" });
  assert.match(s.sessionId, /^t-new-/);
});

test("un fallo del turno llega como error", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const s = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "falla" });
  let st;
  for (let i = 0; i < 40; i++) { st = (await phone.ask({ type: "job", jobId: s.jobId })).status; if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.status, "error"); assert.equal(st.error, "boom");
});

test("cancelar una tarea en curso y no permitir dos a la vez", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const s = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "algo lento" });
  const dup = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "otra" });
  assert.equal(dup.ok, false); assert.match(dup.error, /tarea en curso/);
  const c = await phone.ask({ type: "cancel", workspaceId: ws.id, sessionId: "t-alpha" });
  assert.equal(c.cancelled, true);
  let st;
  for (let i = 0; i < 40; i++) { st = (await phone.ask({ type: "job", jobId: s.jobId })).status; if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.status, "cancelled");
});

test("modelo y permiso de los ajustes se aplican a las tareas nuevas", async () => {
  assert.equal((await control("POST", "/settings", { model: "go-deepseek-v4.1-flash", permission: "read-only" })).status, 200);
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const s = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "con modelo" });
  let st;
  for (let i = 0; i < 40; i++) { st = (await phone.ask({ type: "job", jobId: s.jobId })).status; if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.result, "Respuesta a: con modelo [go-deepseek-v4.1-flash]");
  assert.equal((await control("POST", "/settings", { permission: "root" })).status, 400);
});

test("órdenes desconocidas o de funciones que no existen dan error claro", async () => {
  assert.match((await phone.ask({ type: "browser", workspaceId: "x" })).error, /no existe en ChatGPT 2/);
  assert.match((await phone.ask({ type: "rm-rf" })).error, /desconocida/);
});

test("dispositivos: se listan y se pueden revocar", async () => {
  const d = (await control("GET", "/devices")).body.devices;
  assert.equal(d.length, 1); assert.equal(d[0].label, "Honor de prueba");
  assert.equal((await control("POST", "/revoke-device", { id: d[0].id })).status, 200);
  assert.equal((await phone.raw("responses", { "X-Forja-Device-Token": phone.token })).status, 401);
});

test("nuevo QR conserva la instalación y el cifrado; detener con revocación borra todo", async () => {
  const before = (await control("GET", "/status")).body.pairingPayload.split("|");
  const after = (await control("POST", "/start", {})).body.pairingPayload.split("|");
  assert.equal(after[2], before[2]); assert.equal(after[4], before[4]); assert.notEqual(after[3], before[3]);
  await control("POST", "/stop", { revoke: true });
  const s = (await control("GET", "/status")).body;
  assert.equal(s.configured, false); assert.equal(s.running, false);
});
