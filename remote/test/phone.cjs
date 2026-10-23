"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

// Teléfono falso: lo mismo que hace la app Android (F3|relay|installation|pairingKey|encryptionKey)
class Phone {
  constructor(payload) { const f = payload.split("|"); [, this.url, this.inst, this.pairKey, this.encKey] = f; }
  async raw(action, headers, body) {
    const r = await fetch(`${this.url}/v3/${action}?installation=${this.inst}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forja-Device": "android", ...headers }, body: JSON.stringify(body || {}) });
    return { status: r.status, body: await r.json() };
  }
  async pair() { const r = await this.raw("pair", { "X-Forja-Pairing-Key": this.pairKey }, { deviceName: "Honor de prueba", platform: "android" }); if (r.status === 200) this.token = r.body.token; return r; }
  enc(v) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(this.encKey, "base64url"), iv); c.setAAD(Buffer.from(this.inst)); const ct = Buffer.concat([c.update(JSON.stringify(v)), c.final(), c.getAuthTag()]); return { iv: iv.toString("base64url"), ciphertext: ct.toString("base64url") }; }
  dec(p) { const b = Buffer.from(p.ciphertext, "base64url"); const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(this.encKey, "base64url"), Buffer.from(p.iv, "base64url")); d.setAAD(Buffer.from(this.inst)); d.setAuthTag(b.subarray(-16)); return JSON.parse(Buffer.concat([d.update(b.subarray(0, -16)), d.final()]).toString()); }
  async ask(command, timeout = 8000) {
    const id = crypto.randomUUID();
    const q = await this.raw("command", { "X-Forja-Device-Token": this.token }, { id, body: this.enc(command) });
    assert.equal(q.status, 200, JSON.stringify(q.body));
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const r = await this.raw("responses", { "X-Forja-Device-Token": this.token });
      for (const m of r.body.messages || []) if (m.id === id) return this.dec(m.body);
      await new Promise((x) => setTimeout(x, 60));
    }
    throw new Error("sin respuesta a " + command.type);
  }
}

module.exports = { Phone };
