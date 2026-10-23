#!/usr/bin/env node
"use strict";
// Falso «codex app-server» por stdio (JSON-RPC por líneas) con lo mínimo que usa el agente. Solo para pruebas.
const readline = require("node:readline");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const now = () => Math.floor(Date.now() / 1000);
const threads = [
  { id: "t-alpha", name: "Arreglar la página", preview: "Arreglar la página", cwd: "/work/web", updatedAt: now() - 10, status: { type: "idle" }, ephemeral: false, turns: [] },
  { id: "t-beta", name: null, preview: "Revisar el bot de polymarket con un texto muy largo ".repeat(4), cwd: "/work/bot", updatedAt: now() - 100, status: { type: "notLoaded" }, ephemeral: false, turns: [] },
  { id: "t-busy", name: "Automatización en uso", preview: "x", cwd: "/work/web", updatedAt: now() - 5, status: { type: "idle" }, ephemeral: false, turns: [] },
  { id: "t-sub", name: "subagente", preview: "x", cwd: "/work/web", updatedAt: now(), status: { type: "idle" }, ephemeral: false, parentThreadId: "t-alpha", turns: [] },
];
const turns = { "t-alpha": [{ id: "u1", status: "completed", items: [
  { type: "userMessage", content: [{ type: "text", text: "<in-app-browser-context source=\"x\">\nruido\n</in-app-browser-context>\n\n## My request:\nhola, arregla el título" }] },
  { type: "commandExecution", id: "x", command: "ls", status: "completed", exitCode: 0 },
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
    case "model/list": return ok({ data: [
      { id: "m-a", model: "m-a", displayName: "Modelo A", hidden: false, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" },
      { id: "m-b", model: "m-b", displayName: "Modelo B", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium" },
      { id: "m-hidden", model: "m-hidden", displayName: "Oculto", hidden: true, supportedReasoningEfforts: [] }] });
    case "thread/list": return ok({ data: threads, nextCursor: null });
    case "thread/turns/list": return ok({ data: (turns[p.threadId] || []).slice().reverse(), nextCursor: null });
    case "thread/resume":
      if (p.threadId === "t-busy") return out({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "thread t-busy already has an active writer" } });
      return ok({ thread: threads.find((t) => t.id === p.threadId) });
    case "thread/fork": { const t = { id: "t-fork-" + ++n, name: null, preview: "", cwd: "/work/web", updatedAt: now(), status: { type: "idle" }, ephemeral: false, turns: [] }; threads.push(t); return ok({ thread: t }); }
    case "thread/start": { const t = { id: "t-new-" + ++n, name: null, preview: "", cwd: p.cwd, updatedAt: now(), status: { type: "idle" }, ephemeral: false, turns: [] }; threads.push(t); global.lastStart = p; return ok({ thread: t }); }
    case "turn/start": {
      const id = "turn-" + ++n; ok({ turn: { id, status: "inProgress", items: [] } });
      const slow = JSON.stringify(p.input).includes("lento");
      active[p.threadId] = id;
      setTimeout(() => {
        out({ jsonrpc: "2.0", method: "item/started", params: { threadId: p.threadId, turnId: id, item: { type: "commandExecution", id: "c1", command: "ls -la", status: "inProgress" } } });
        out({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: p.threadId, turnId: id, itemId: "a", delta: "Hola " } });
        out({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: p.threadId, turnId: id, itemId: "a", delta: "mundo" } });
      }, 30);
      const t = setTimeout(() => {
        global.lastInput = p.input;
        const extra = p.input.length > 1 ? " <" + p.input.slice(1).map((i) => i.type).join(",") + ">" : "";
        const text = "Respuesta a: " + p.input[0].text.split("\n")[0] + (p.model ? " [" + p.model + "]" : "") + (p.effort ? " {" + p.effort + "}" : "") + extra;
        out({ jsonrpc: "2.0", method: "item/completed", params: { threadId: p.threadId, turnId: id, completedAtMs: 1, item: { type: "agentMessage", id: "a", text } } });
        if (JSON.stringify(p.input).includes("falla")) out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id, status: "failed", error: { message: "boom" }, items: [] } } });
        else out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id, status: "completed", items: [] } } });
        delete active[p.threadId];
      }, slow ? 5000 : 80);
      active[p.threadId + ":t"] = t; return;
    }
    case "turn/interrupt": { clearTimeout(active[p.threadId + ":t"]); ok({}); out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted", items: [] } } }); return; }
    case "thread/compact/start": ok({}); setTimeout(() => out({ jsonrpc: "2.0", method: "thread/compacted", params: { threadId: p.threadId, turnId: "c" } }), 40); return;
    case "review/start": { const id = "turn-" + ++n; ok({ reviewThreadId: p.threadId, turn: { id, status: "inProgress", items: [] }, echo: p.target });
      setTimeout(() => { out({ jsonrpc: "2.0", method: "item/completed", params: { threadId: p.threadId, turnId: id, completedAtMs: 1, item: { type: "agentMessage", id: "r", text: "Revisión: " + p.target.type } } }); out({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id, status: "completed", items: [] } } }); }, 60); return; }
    case "thread/name/set": { const t = threads.find((x) => x.id === p.threadId); if (t) t.name = p.name; return ok({}); }
    case "thread/archive": return ok({});
    case "thread/goal/set": global.goal = { threadId: p.threadId, objective: p.objective, status: "active", tokensUsed: 5, timeUsedSeconds: 3 }; return ok({ goal: global.goal });
    case "thread/goal/get": return ok({ goal: global.goal || null });
    case "thread/goal/clear": global.goal = null; return ok({});
    case "thread/read": return ok({ thread: { ...threads.find((t) => t.id === p.threadId), model: "gpt-fake", modelProvider: "openai" } });
    case "account/rateLimits/read": return ok({ rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: now() + 3600 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: now() + 86400 } } });
    case "mcpServerStatus/list": return ok({ data: [{ name: "master", runtimeStatus: null, authStatus: "unsupported", tools: { a: {}, b: {} } }], nextCursor: null });
    case "skills/list": return ok({ data: [{ cwd: p.cwds[0], skills: [{ name: "pdf", description: "x", shortDescription: "Leer PDFs", enabled: true }, { name: "off", description: "y", enabled: false }], errors: [] }] });
    case "fuzzyFileSearch": return ok({ files: [{ root: p.roots[0], path: "src/app.js", match_type: "file", file_name: "app.js", score: 9 }] });
    default: out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no soportado " + m.method } });
  }
});
