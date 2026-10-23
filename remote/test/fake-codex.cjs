#!/usr/bin/env node
"use strict";
// Falso «codex app-server» por stdio (JSON-RPC por líneas) con lo mínimo que usa el agente. Solo para pruebas.
const readline = require("node:readline");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const now = () => Math.floor(Date.now() / 1000);
const threads = [
  { id: "t-alpha", name: "Arreglar la página", preview: "Arreglar la página", cwd: "/work/web", updatedAt: now() - 10, status: { type: "idle" }, ephemeral: false, turns: [] },
  { id: "t-beta", name: null, preview: "Revisar el bot de polymarket con un texto muy largo ".repeat(4), cwd: "/work/bot", updatedAt: now() - 100, status: { type: "notLoaded" }, ephemeral: false, turns: [] },
  { id: "t-sub", name: "subagente", preview: "x", cwd: "/work/web", updatedAt: now(), status: { type: "idle" }, ephemeral: false, parentThreadId: "t-alpha", turns: [] },
];
const turns = { "t-alpha": [{ id: "u1", status: "completed", items: [
  { type: "userMessage", content: [{ type: "text", text: "<in-app-browser-context source=\"x\">\nruido\n</in-app-browser-context>\n\n## My request:\nhola, arregla el título" }] },
  { type: "commandExecution", command: "ls" },
  { type: "agentMessage", text: "Listo, cambié el título." }] }] };
let n = 0;
const active = {};
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  const ok = (result) => out({ jsonrpc: "2.0", id: m.id, result });
  const p = m.params || {};
  switch (m.method) {
    case "initialize": return ok({ userAgent: "fake", codexHome: "/tmp" });
    case "thread/list": return ok({ data: threads, nextCursor: null });
    case "thread/turns/list": return ok({ data: (turns[p.threadId] || []).slice().reverse(), nextCursor: null });
    case "thread/resume": return ok({ thread: threads.find((t) => t.id === p.threadId) });
    case "thread/start": { const t = { id: "t-new-" + ++n, name: null, preview: "", cwd: p.cwd, updatedAt: now(), status: { type: "idle" }, ephemeral: false, turns: [] }; threads.push(t); global.lastStart = p; return ok({ thread: t }); }
    case "turn/start": {
      const id = "turn-" + ++n; ok({ turn: { id, status: "inProgress", items: [] } });
      const slow = JSON.stringify(p.input).includes("lento");
      active[p.threadId] = id;
      const t = setTimeout(() => {
        const text = "Respuesta a: " + p.input[0].text + (p.model ? " [" + p.model + "]" : "");
        out({ jsonrpc: "2.0", method: "item/completed", params: { threadId: p.threadId, turnId: id, completedAtMs: 1, item: { type: "agentMessage", id: "a", text } } });
        if (JSON.stringify(p.input).includes("falla")) out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id, status: "failed", error: { message: "boom" }, items: [] } } });
        else out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id, status: "completed", items: [] } } });
        delete active[p.threadId];
      }, slow ? 5000 : 80);
      active[p.threadId + ":t"] = t; return;
    }
    case "turn/interrupt": { clearTimeout(active[p.threadId + ":t"]); ok({}); out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted", items: [] } } }); return; }
    default: out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no soportado " + m.method } });
  }
});
