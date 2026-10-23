"use strict";
// Falso IPC de la app de escritorio: dueña de la conversación «t-busy». Atiende descubrimiento de dueño, seguimiento en vivo
// (foto + parches con el texto que va saliendo) y las órdenes thread-follower-*. Solo para pruebas.
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function createFakeIpc(codexHome) {
  const sock = path.join(codexHome, "ipc", "ipc.sock");
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const calls = [];                       // {method, params, version, hostId}
  const clients = new Map();              // socket -> {id, following:Set}
  const state = { rev: 1, turns: {} };    // turnId -> entidad de turno
  const KEY = (id) => "tail:0:local:" + id;
  const frame = (o) => { const j = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(j.length); return Buffer.concat([h, j]); };
  const snapshot = () => ({ id: "t-busy", threadRuntimeStatus: { type: "idle" }, turnHistory: { kind: "x", history: { entitiesByKey: Object.fromEntries(Object.entries(state.turns).map(([k, v]) => [KEY(k), JSON.parse(JSON.stringify(v))])), isComplete: false } } });
  const send = (c, o) => { try { c.write(frame(o)); } catch {} };
  const cast = (change) => { for (const [s, c] of clients) if (c.following.has("t-busy")) send(s, { type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "owner", version: 1, targetClientIds: [c.id], params: { conversationId: "t-busy", hostId: "local", change } }); };
  const patches = (p) => cast({ type: "patches", revision: ++state.rev, patches: p });
  const base = (id) => ["turnHistory", "history", "entitiesByKey", KEY(id)];

  function runTurn(id, text) {
    const slow = /lento/.test(text);
    state.turns[id] = { turnId: id, status: "inProgress", items: [{ type: "userMessage", id: "u" + id, content: [{ type: "text", text, text_elements: [] }] }] };
    cast({ type: "snapshot", revision: ++state.rev, conversationState: snapshot() });
    patches([{ op: "replace", path: ["threadRuntimeStatus"], value: { type: "active", activeFlags: [] } }]);
    setTimeout(() => {
      const it = state.turns[id].items;
      it.push({ type: "commandExecution", id: "c" + id, command: "ls", status: "inProgress" });
      patches([{ op: "add", path: [...base(id), "items", it.length - 1], value: it[it.length - 1] }]);
    }, 40);
    setTimeout(() => { const it = state.turns[id].items; it.push({ type: "agentMessage", id: "a" + id, text: "Hola " }); patches([{ op: "add", path: [...base(id), "items", it.length - 1], value: it[it.length - 1] }]); }, 90);
    setTimeout(() => { const it = state.turns[id].items, i = it.length - 1; it[i].text = "Hola desde la PC"; patches([{ op: "replace", path: [...base(id), "items", i, "text"], value: it[i].text }]); }, 140);
    state.timers = state.timers || {};
    state.timers[id] = setTimeout(() => {
      state.turns[id].status = "completed";
      patches([{ op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } }, { op: "replace", path: [...base(id), "status"], value: "completed" }]);
    }, slow ? 5000 : 260);
  }

  const server = net.createServer((s) => {
    const me = { id: crypto.randomUUID(), following: new Set() }; clients.set(s, me);
    let buf = Buffer.alloc(0);
    s.on("close", () => clients.delete(s)); s.on("error", () => {});
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const n = buf.readUInt32LE(0); if (buf.length < 4 + n) break;
        const m = JSON.parse(buf.subarray(4, 4 + n).toString()); buf = buf.subarray(4 + n);
        const ok = (result) => send(s, { type: "response", requestId: m.requestId, resultType: "success", method: m.method, handledByClientId: "owner", result });
        const err = (e) => send(s, { type: "response", requestId: m.requestId, resultType: "error", error: e });
        if (m.type === "broadcast") {
          if (m.method === "thread-stream-following-changed") { if (m.params.following) me.following.add(m.params.conversationId); else me.following.delete(m.params.conversationId); }
          if (m.method === "thread-stream-following-status-requested" && me.following.has(m.params.conversationId)) send(s, { type: "broadcast", method: "thread-stream-state-changed", sourceClientId: "owner", version: 1, targetClientIds: [me.id], params: { conversationId: m.params.conversationId, hostId: "local", change: { type: "snapshot", revision: ++state.rev, conversationState: snapshot() } } });
          continue;
        }
        if (m.type !== "request") continue;
        if (m.method === "initialize") { ok({ clientId: me.id }); continue; }
        calls.push({ method: m.method, params: m.params, version: m.version, hostId: m.hostId });
        const tid = m.params && (m.params.conversationId || m.params.threadId);
        const opened = tid === "t-lock" && fs.existsSync(path.join(codexHome, "opened-t-lock"));
        if (m.method === "thread-owner-discovery") { if ((tid === "t-busy" || opened) && m.params.hostId === "local") ok({ supportsUntrustedAppInput: true }); else err("no-client-found"); }
        else if (m.method === "thread-follower-start-turn") { const id = "tt" + (calls.length); ok({ result: { turn: { id, status: "inProgress", items: [] } } }); runTurn(id, m.params.turnStart.request.input[0].text); }
        else if (m.method === "thread-follower-interrupt-turn") { clearTimeout(state.timers && state.timers[m.params.expectedTurnId]); const t = state.turns[m.params.expectedTurnId]; if (t) { t.status = "interrupted"; patches([{ op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } }, { op: "replace", path: [...base(m.params.expectedTurnId), "status"], value: "interrupted" }]); } ok({ interruptedTurnId: m.params.expectedTurnId, ok: true }); }
        else if (m.method === "thread-follower-compact-thread") { ok({ ok: true }); patches([{ op: "replace", path: ["threadRuntimeStatus"], value: { type: "active", activeFlags: [] } }]); setTimeout(() => patches([{ op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } }]), 150); }
        else err("no-handler");
      }
    });
  });
  return { calls, state, listen: () => new Promise((r) => server.listen(sock, r)), close: () => { for (const s of clients.keys()) s.destroy(); server.close(); } };
}

module.exports = { createFakeIpc };
