"use strict";
// Relay falso en memoria con la misma semántica que cloud/forja-relay (protocolo v3), solo para pruebas.
const http = require("node:http");
const crypto = require("node:crypto");
const sha = (v) => crypto.createHash("sha256").update(v).digest("base64url");
function createRelay() {
  const rooms = new Map();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/health") return send(200, { service: "forja-relay", protocol: 3, ready: true });
    const inst = u.searchParams.get("installation") || "";
    const action = u.pathname.replace("/v3/", "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let j = {}; try { j = JSON.parse(body || "{}"); } catch {}
      const dev = req.headers["x-forja-device"], key = req.headers["x-forja-pairing-key"] || "", tok = req.headers["x-forja-device-token"] || "";
      let room = rooms.get(inst);
      if (action === "register") {
        if (dev !== "desktop") return send(403, { error: "Only a desktop can register an installation." });
        if (room && room.keyHash !== sha(key)) return send(409, { error: "This installation is already registered." });
        if (!room) rooms.set(inst, (room = { keyHash: sha(key), commands: [], responses: [], devices: [] }));
        if (j.pairingKey) room.pairingKeyHash = sha(j.pairingKey);
        return send(200, { ok: true });
      }
      if (action === "pair") {
        if (!room || room.pairingKeyHash !== sha(key)) return send(401, { error: "Pairing expired." });
        const token = crypto.randomBytes(32).toString("base64url");
        room.devices.push({ id: crypto.randomBytes(8).toString("hex"), label: j.deviceName || "Forja Remote", platform: j.platform || "unknown", pairedAt: Date.now(), tokenHash: sha(token) });
        room.pairingKeyHash = undefined;
        return send(200, { token, deviceId: room.devices.at(-1).id });
      }
      if (action === "command" || action === "responses") {
        const d = room && room.devices.find((x) => x.tokenHash === sha(tok));
        if (!d) return send(401, { error: "This phone is no longer paired." });
        if (action === "command") { room.commands.push({ id: j.id, body: j.body, createdAt: Date.now() }); return send(200, { ok: true }); }
        const m = room.responses; room.responses = []; return send(200, { messages: m });
      }
      if (!room || room.keyHash !== sha(key)) return send(401, { error: "Pairing expired." });
      if (action === "commands") { const m = room.commands; room.commands = []; return send(200, { messages: m }); }
      if (action === "response") { room.responses.push({ id: j.id, body: j.body, createdAt: Date.now() }); return send(200, { ok: true }); }
      if (action === "devices") return send(200, { devices: room.devices.map(({ tokenHash, ...d }) => d) });
      if (action === "revoke-device") { room.devices = room.devices.filter((d) => d.id !== j.deviceId); return send(200, { ok: true }); }
      if (action === "revoke") { rooms.delete(inst); return send(200, { ok: true }); }
      send(404, { error: "Not found." });
    });
  });
  return { server, rooms };
}
module.exports = { createRelay };
