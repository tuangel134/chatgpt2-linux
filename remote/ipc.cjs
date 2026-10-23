"use strict";
// Cliente del IPC de la app de escritorio de ChatGPT 2 (el mismo que usan sus ventanas para seguirse unas a otras).
// Permite escribir en una conversación que la app de escritorio tiene abierta, sin copias y sin pelear por el
// bloqueo de escritura: la orden la ejecuta la propia app, así que ambos lados ven lo mismo.
// Protocolo: socket Unix en CODEX_HOME/ipc/ipc.sock, mensajes JSON con prefijo de longitud (uint32 LE).
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_FRAME = 268435456;
// Versión de cada petición «thread-follower-*» cuando se manda con hostId (así las pide la app: versión base + 1).
const VERSION = { "thread-owner-discovery": 1, "thread-follower-start-turn": 3, "thread-follower-compact-thread": 2, "thread-follower-interrupt-turn": 5, "thread-follower-steer-turn": 2 };

class IpcClient {
  constructor(codexHome, log = () => {}) { this.sock = path.join(codexHome, "ipc", "ipc.sock"); this.log = log; this.s = null; this.id = ""; this.pend = new Map(); this.buf = Buffer.alloc(0); this.connecting = null; this.onBroadcast = null; this.onReset = null; }

  _frame(o) { const j = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(j.length); return Buffer.concat([h, j]); }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32LE(0);
      if (n > MAX_FRAME) { this.s.destroy(); return; }
      if (this.buf.length < 4 + n) break;
      let m; try { m = JSON.parse(this.buf.subarray(4, 4 + n).toString("utf8")); } catch { this.s.destroy(); return; }
      this.buf = this.buf.subarray(4 + n);
      if (m.type === "response") { const f = this.pend.get(m.requestId); if (f) { this.pend.delete(m.requestId); f(m); } }
      else if (m.type === "broadcast") { if (this.onBroadcast) try { this.onBroadcast(m); } catch (e) { this.log("ipc broadcast:", e.message); } }
      else if (m.type === "client-discovery-request") this.s.write(this._frame({ type: "client-discovery-response", requestId: m.requestId, response: { canHandle: false } }));
    }
  }

  _raw(method, params, o = {}) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID(), t = setTimeout(() => { this.pend.delete(id); reject(new Error("timeout")); }, o.timeoutMs || 8000);
      this.pend.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.s.write(this._frame({ type: "request", requestId: id, sourceClientId: this.id || "initializing-client", version: o.version ?? 0, method, params, targetClientId: o.targetClientId, hostId: o.hostId, timeoutMs: o.timeoutMs }));
    });
  }

  connect() {
    if (this.s && !this.s.destroyed && this.id) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const s = net.connect(this.sock); this.s = s; this.id = ""; this.buf = Buffer.alloc(0);
      const fail = (e) => { this.connecting = null; reject(e); };
      s.once("error", fail);
      s.on("data", (d) => this._onData(d));
      s.on("close", () => { this.id = ""; this.connecting = null; if (this.onReset) try { this.onReset(); } catch {} for (const [k, f] of this.pend) { this.pend.delete(k); f({ resultType: "error", error: "connection-closed" }); } });
      s.once("connect", async () => {
        s.removeListener("error", fail); s.on("error", () => {});
        try { const r = await this._raw("initialize", { clientType: "chatgpt2-remote" }); if (r.resultType !== "success") throw new Error(r.error || "initialize"); this.id = r.result.clientId; this.connecting = null; resolve(); }
        catch (e) { this.connecting = null; s.destroy(); reject(e); }
      });
    });
    return this.connecting;
  }

  async request(method, params, o = {}) {
    await this.connect();
    return this._raw(method, params, { version: VERSION[method] ?? 0, hostId: "local", ...o });
  }

  // Difusión (sin respuesta): así se pide seguir una conversación y la app manda su estado en vivo.
  async broadcast(method, params) {
    await this.connect();
    this.s.write(this._frame({ type: "broadcast", method, sourceClientId: this.id, version: 1, params }));
  }

  // ¿La app de escritorio tiene esta conversación? Devuelve false si no está abierta o no hay app.
  async ownsThread(threadId) {
    try { const r = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, { timeoutMs: 3000 }); return r.resultType === "success"; }
    catch { return false; }
  }

  async call(method, params, o) {
    const r = await this.request(method, params, o);
    if (r.resultType !== "success") throw new Error(String(r.error || "ipc-error"));
    return r.result;
  }
}

module.exports = { IpcClient };
