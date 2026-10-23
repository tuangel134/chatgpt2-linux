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
const { humanRrule } = require("../agent.cjs");

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
  const adir = path.join(TMP, "codex-home", "automations");
  for (const [id, name, rr, st] of [["a-tarde", "Publicar tarde", "RRULE:FREQ=DAILY;BYHOUR=15,21;BYMINUTE=0;BYSECOND=0", "ACTIVE"], ["a-lunes", "Resumen semanal", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9;BYMINUTE=30", "PAUSED"]]) {
    fs.mkdirSync(path.join(adir, id), { recursive: true });
    fs.writeFileSync(path.join(adir, id, "automation.toml"), `version = 1\nid = "${id}"\nkind = "heartbeat"\nname = "${name}"\nstatus = "${st}"\nrrule = "${rr}"\nmodel = "m-a"\nreasoning_effort = "high"\ntarget_thread_id = "t-alpha"\n`);
  }
  fs.mkdirSync(path.join(TMP, "codex-home", "sqlite"), { recursive: true });
  cp.spawnSync("python3", ["-I", "-c", "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('create table automations(id text,status text,next_run_at integer,last_run_at integer)');c.execute(\"insert into automations values('a-tarde','ACTIVE',2000000000000,1999999000000)\");c.execute(\"insert into automations values('a-lunes','PAUSED',1900000000000,null)\");c.commit()", path.join(TMP, "codex-home", "sqlite", "codex-dev.db")]);
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
  assert.deepEqual(web.sessions.map((s) => s.id), ["t-busy", "t-alpha"]);          // t-sub es de un subagente
  assert.equal(web.sessions.find((x) => x.id === "t-alpha").title, "Arreglar la página");
  const bot = r.workspaces.find((w) => w.name === "bot");
  assert.ok(bot.sessions[0].title.length <= 70);
});

test("mensajes: usuario, asistente y comandos, sin el ruido del navegador", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const r = await phone.ask({ type: "messages", workspaceId: ws.id, sessionId: "t-alpha" });
  assert.deepEqual(r.messages.map((m) => [m.role, m.message.parts[0].text]), [["user", "hola, arregla el título"], ["tool", "ls"], ["assistant", "Listo, cambié el título."]]);
  assert.equal(r.messages[1].kind, "command"); assert.equal(r.messages[1].exitCode, 0);
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

test("modelos: lista visible, esfuerzos y modelo por defecto", async () => {
  const r = await phone.ask({ type: "models" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models.map((m) => m.id), ["m-a", "m-b"]);                // el oculto no sale
  assert.deepEqual(r.models[0].efforts, ["low", "high"]); assert.deepEqual(r.models[1].efforts, ["medium"]);
  assert.equal(typeof r.default, "string");
});

test("enviar con modelo y esfuerzo elegidos desde el teléfono, texto parcial y actividad en vivo", async () => {
  await control("POST", "/settings", { model: "" });
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const s = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "algo lento", model: "m-b", effort: "high" });
  let st, saw = false;
  for (let i = 0; i < 60; i++) { st = (await phone.ask({ type: "job", jobId: s.jobId })).status; if (st.partial === "Hola mundo" && st.activity) saw = true; if (saw) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(saw, "debió verse el texto parcial");
  assert.deepEqual(st.activity.map((a) => [a.kind, a.text]), [["command", "ls -la"]]);
  await phone.ask({ type: "cancel", workspaceId: ws.id, sessionId: "t-alpha" });
  const s2 = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "fin", model: "m-b", effort: "high" });
  for (let i = 0; i < 40; i++) { st = (await phone.ask({ type: "job", jobId: s2.jobId })).status; if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.result, "Respuesta a: fin [m-b] {high}");
});

test("automatizaciones: lista con horario legible, estado y próxima ejecución", async () => {
  const r = await phone.ask({ type: "automations" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.automations.map((x) => x.id), ["a-lunes", "a-tarde"]);                 // orden: la que toca antes primero
  const t = r.automations.find((x) => x.id === "a-tarde"), l = r.automations.find((x) => x.id === "a-lunes");
  assert.equal(t.schedule, "Todos los días a las 15:00 y 21:00"); assert.equal(t.status, "ACTIVE");
  assert.equal(t.nextRunAt, 2000000000000); assert.equal(t.lastRunAt, 1999999000000); assert.equal(t.threadId, "t-alpha"); assert.equal(t.model, "m-a");
  assert.equal(l.schedule, "Cada lunes y miércoles a las 09:30"); assert.equal(l.status, "PAUSED");   // el estado lo manda la base de la app
  assert.equal(typeof r.now, "number");
});

test("humanRrule: formas habituales", () => {
  assert.equal(humanRrule("RRULE:FREQ=HOURLY;INTERVAL=24;BYMINUTE=0"), "Cada 24 horas");
  assert.equal(humanRrule("FREQ=DAILY;BYHOUR=8"), "Todos los días a las 08:00");
  assert.equal(humanRrule("FREQ=MINUTELY;INTERVAL=30"), "Cada 30 minutos");
  assert.equal(humanRrule("FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=15"), "Cada viernes a las 18:15");
  assert.equal(humanRrule("FREQ=YEARLY"), "FREQ=YEARLY");
});

test("subir archivos por trozos y enviarlos con el mensaje (imagen y archivo)", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const up = async (id, name, buf, chunk) => { const total = Math.ceil(buf.length / chunk); let last; for (let i = 0; i < total; i++) last = await phone.ask({ type: "upload", uploadId: id, name, index: i, total, data: buf.subarray(i * chunk, (i + 1) * chunk).toString("base64") }); return last; };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcXwAAAABJRU5ErkJggg==", "base64");
  const txt = Buffer.from("hola archivo ".repeat(300));
  const r1 = await up("img00001", "foto 1.png", png, 40); assert.equal(r1.done, true); assert.equal(r1.size, png.length);
  const r2 = await up("doc00001", "../../notas.txt", txt, 1000); assert.equal(r2.name, "notas.txt");              // el nombre se sanea
  const s = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "mira esto", attachments: [{ id: "img00001" }, { id: "doc00001" }] });
  assert.equal(s.ok, true, JSON.stringify(s));
  let st; for (let i = 0; i < 40; i++) { st = (await phone.ask({ type: "job", jobId: s.jobId })).status; if (st.status !== "running") break; await new Promise((r) => setTimeout(r, 50)); }
  assert.match(st.result, /^Respuesta a: mira esto.*<localImage,mention>$/);                                       // imagen → localImage, archivo → mention
  assert.equal((await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-alpha", text: "x", attachments: [{ id: "noexiste1" }] })).ok, false);
  assert.equal((await phone.ask({ type: "upload", uploadId: "mal", name: "a", index: 0, total: 1, data: "AA==" })).ok, false);   // id inválido
});

test("leer archivos: por trozos dentro de zonas permitidas; fuera de ellas, no", async () => {
  const up = path.join(TMP, "codex-home", "remote", "uploads", "doc00001", "notas.txt");
  const a = await phone.ask({ type: "file", path: up, offset: 0, length: 1000 });
  assert.equal(a.ok, true); assert.equal(a.name, "notas.txt"); assert.equal(a.mime, "text/plain"); assert.equal(a.done, false); assert.equal(a.size, 3900);
  const b = await phone.ask({ type: "file", path: up, offset: 1000, length: 5000 });
  assert.equal(b.done, true); assert.equal(Buffer.concat([Buffer.from(a.data, "base64"), Buffer.from(b.data, "base64")]).toString(), "hola archivo ".repeat(300).slice(0, 1000 + Buffer.from(b.data, "base64").length));
  for (const bad of ["/etc/passwd", path.join(os.homedir(), ".ssh", "id_rsa"), "relativo.txt", up + "/../../../../../../etc/passwd"]) {
    const r = await phone.ask({ type: "file", path: bad }); assert.equal(r.ok, false, bad);
  }
  const link = path.join(TMP, "codex-home", "remote", "uploads", "doc00001", "escape.txt");
  fs.symlinkSync("/etc/hostname", link);
  assert.equal((await phone.ask({ type: "file", path: link })).ok, false);                                       // un enlace simbólico no saca de la zona
});

test("conversación bloqueada por la app de escritorio: sigue sola en una copia y la recuerda", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const wait = async (id) => { let st; for (let i = 0; i < 40; i++) { st = (await phone.ask({ type: "job", jobId: id })).status; if (st.status !== "running") break; await new Promise((x) => setTimeout(x, 50)); } return st; };
  const f = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-busy", text: "sigue" });
  assert.equal(f.ok, true); assert.match(f.sessionId, /^t-fork-/); assert.equal(f.forkedFrom, "t-busy");   // sin error, en otro hilo
  assert.equal((await wait(f.jobId)).status, "done");
  const g = await phone.ask({ type: "send", workspaceId: ws.id, sessionId: "t-busy", text: "otra vez" });
  assert.equal(g.sessionId, f.sessionId);                                                                  // reutiliza la misma copia
  await wait(g.jobId);
});

test("comandos «/»: compactar, revisar, renombrar, objetivo, estado, mcp, skills, archivos, diff, permisos, fork, archivar", async () => {
  const ws = (await phone.ask({ type: "status" })).workspaces.find((w) => w.name === "web");
  const sl = (o) => phone.ask({ type: "slash", workspaceId: ws.id, sessionId: "t-alpha", ...o });
  const wait = async (id) => { let st; for (let i = 0; i < 60; i++) { st = (await phone.ask({ type: "job", jobId: id })).status; if (st.status !== "running") break; await new Promise((x) => setTimeout(x, 50)); } return st; };
  const c = await sl({ cmd: "compact" }); assert.equal(c.ok, true, JSON.stringify(c));
  const cs = await wait(c.jobId); assert.equal(cs.status, "done"); assert.equal(cs.result, "Contexto compactado.");
  const bad = await sl({ cmd: "review", target: { type: "commit", sha: "zz; rm" } }); assert.equal(bad.ok, false);
  const rv = await sl({ cmd: "review", target: { type: "baseBranch", branch: "main" } }); assert.equal(rv.ok, true);
  assert.match((await wait(rv.jobId)).result, /baseBranch/);
  assert.equal((await sl({ cmd: "rename", name: "Nuevo nombre" })).name, "Nuevo nombre");
  assert.equal((await sl({ cmd: "goal", action: "get" })).goal, null);
  assert.equal((await sl({ cmd: "goal", action: "set", objective: "terminar" })).goal.objective, "terminar");
  assert.equal((await sl({ cmd: "goal", action: "clear" })).goal, null);
  const info = await sl({ cmd: "info" }); assert.equal(info.thread.model, "gpt-fake"); assert.equal(info.rateLimits.rateLimits.primary.usedPercent, 30);
  assert.deepEqual((await sl({ cmd: "mcp" })).servers, [{ name: "master", status: "", auth: "unsupported", tools: 2, error: "" }]);
  assert.deepEqual((await sl({ cmd: "skills" })).skills.map((k) => k.name), ["pdf"]);
  assert.equal((await sl({ cmd: "files", query: "app" })).files[0].path, "src/app.js");
  assert.equal((await sl({ cmd: "permission", value: "danger-full-access" })).ok, false);          // el acceso completo no se activa desde el teléfono
  assert.equal((await sl({ cmd: "permission", value: "read-only" })).permission, "read-only");
  await sl({ cmd: "permission", value: "workspace-write" });
  assert.match((await sl({ cmd: "fork" })).sessionId, /^t-fork-/);
  assert.equal((await sl({ cmd: "archive" })).ok, true);
  assert.equal((await sl({ cmd: "nada" })).ok, false);
  assert.equal((await phone.ask({ type: "slash", workspaceId: ws.id, cmd: "compact" })).ok, false);   // sin conversación
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

