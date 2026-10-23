"use strict";
// Seguimiento en vivo de las conversaciones que tiene abiertas la app de escritorio.
// La app manda por el IPC una foto de la conversación (snapshot) y después parches (estilo JSON-Patch) con cada
// cambio: texto que se va escribiendo, comandos, estado «activo/inactivo»… Aquí se mantiene esa copia al día.
const FOLLOW_MS = 90_000;   // sin consultas durante este tiempo se deja de seguir

function applyPatches(root, patches) {
  for (const p of patches) {
    const path = p.path || [];
    if (!path.length) continue;
    let parent = root;
    for (let i = 0; i < path.length - 1; i++) { parent = parent == null ? undefined : parent[path[i]]; }
    if (parent == null || typeof parent !== "object") throw new Error("patch path");
    const key = path[path.length - 1];
    if (p.op === "add") { if (Array.isArray(parent)) parent.splice(key === "-" ? parent.length : Number(key), 0, p.value); else parent[key] = p.value; }
    else if (p.op === "replace") parent[key] = p.value;
    else if (p.op === "remove") { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
  }
}

// Turnos que la app tiene cargados, del más viejo al más nuevo (los pendientes sin id todavía no cuentan).
function turnsOf(state) {
  const e = state && state.turnHistory && state.turnHistory.history && state.turnHistory.history.entitiesByKey;
  return e ? Object.values(e).filter((t) => t && typeof t.turnId === "string" && t.turnId) : [];
}
const isActive = (state) => !!(state && state.threadRuntimeStatus && state.threadRuntimeStatus.type === "active");

class Follower {
  constructor(ipc, log, onChange) {
    this.ipc = ipc; this.log = log; this.onChange = onChange;
    this.threads = new Map();   // threadId -> {state, rev, touched, waiters:[]}
    this.owned = new Map();     // threadId -> {at, ok}
    ipc.onBroadcast = (m) => this._broadcast(m);
    ipc.onReset = () => { for (const f of this.threads.values()) { f.state = null; f.rev = 0; } this.owned.clear(); };
    this.timer = setInterval(() => this._sweep(), 15_000); this.timer.unref?.();
  }

  async owns(threadId, fresh) {
    const c = this.owned.get(threadId);
    if (!fresh && c && Date.now() - c.at < 5000) return c.ok;
    const ok = await this.ipc.ownsThread(threadId);
    this.owned.set(threadId, { at: Date.now(), ok });
    return ok;
  }

  // Empieza (o mantiene) el seguimiento y espera la foto inicial. Devuelve el estado o null si la app de la PC no tiene la conversación.
  async ensure(threadId, waitMs = 3000) {
    if (!(await this.owns(threadId))) return null;
    let f = this.threads.get(threadId);
    if (!f) { f = { state: null, rev: 0, touched: Date.now(), waiters: [] }; this.threads.set(threadId, f); }
    f.touched = Date.now();
    if (f.state) return f.state;
    await this._subscribe(threadId);
    if (!f.state) await new Promise((res) => { const t = setTimeout(res, waitMs); f.waiters.push(() => { clearTimeout(t); res(); }); });
    return f.state;
  }
  get(threadId) { const f = this.threads.get(threadId); if (f) f.touched = Date.now(); return f && f.state || null; }
  touch(threadId) { const f = this.threads.get(threadId); if (f) f.touched = Date.now(); }

  async _subscribe(threadId) {
    try { await this.ipc.broadcast("thread-stream-following-changed", { conversationId: threadId, hostId: "local", following: true }); await this.ipc.broadcast("thread-stream-following-status-requested", { conversationId: threadId, hostId: "local" }); }
    catch (e) { this.log("follow:", e.message); }
  }

  _broadcast(m) {
    if (m.method !== "thread-stream-state-changed" || !m.params) return;
    const { conversationId: id, change } = m.params, f = this.threads.get(id);
    if (!f || !change) return;
    if (change.type === "snapshot") { f.state = change.conversationState; f.rev = change.revision; }
    else if (change.type === "patches" && f.state) {
      if (change.revision !== f.rev + 1) { f.state = null; f.rev = 0; this._subscribe(id); return; }   // se perdió un parche: pedir foto nueva
      try { applyPatches(f.state, change.patches || []); f.rev = change.revision; } catch (e) { this.log("follow patch:", e.message); f.state = null; f.rev = 0; this._subscribe(id); return; }
    } else return;
    const w = f.waiters.splice(0); for (const fn of w) fn();
    if (f.state) try { this.onChange(id, f.state); } catch (e) { this.log("follow onChange:", e.message); }
  }

  _sweep() {
    for (const [id, f] of this.threads) {
      if (Date.now() - f.touched < FOLLOW_MS || this.keep(id)) continue;
      this.threads.delete(id);
      this.ipc.broadcast("thread-stream-following-changed", { conversationId: id, hostId: "local", following: false }).catch(() => {});
    }
  }
  keep() { return false; }   // el agente lo sustituye: no soltar conversaciones con tareas en curso
}

module.exports = { Follower, applyPatches, turnsOf, isActive };
