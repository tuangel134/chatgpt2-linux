#!/usr/bin/env python3
"""Pruebas del enrutador AUTO con un servidor «proxy» falso (no necesita cuentas ni red)."""
import http.client
import json
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import modelhub as m  # noqa: E402

UP, RT = 18317, 18320
seen = []       # (modelo, cuerpo) que llegó al proxy falso
behavior = {}   # modelo -> ("status", code) | ("sse",) | ("json",)


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        seen.append((body.get("model"), body))
        kind = behavior.get(body.get("model"), ("json",))
        if kind[0] == "status":
            out = b'{"error":"x"}'
            self.send_response(kind[1])
            if kind[1] == 429:
                self.send_header("Retry-After", "120")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers(); self.wfile.write(out)
        elif kind[0] == "sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for i in range(3):
                self.wfile.write(b"data: %d\n\n" % i); self.wfile.flush(); time.sleep(0.05)
        else:
            out = json.dumps({"model": body.get("model"), "ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(out)))
            self.end_headers(); self.wfile.write(out)


def post(payload, headers=None, path="/v1/responses"):
    c = http.client.HTTPConnection("127.0.0.1", RT, timeout=10)
    c.request("POST", path, json.dumps(payload), {"Content-Type": "application/json", **(headers or {})})
    r = c.getresponse()
    return r.status, r.read()


class AutoRouter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        m.CPA_PORT, m.ROUTER_PORT = UP, RT
        m.load_state = lambda: {"providers": [], "auto": {"models": ["a", "b", "c"]}}
        m.cpa_models = lambda: [{"id": x} for x in "abc"]
        cls.up = ThreadingHTTPServer(("127.0.0.1", UP), Fake)
        threading.Thread(target=cls.up.serve_forever, daemon=True).start()
        m.start_router()
        time.sleep(0.3)

    def setUp(self):
        seen.clear(); behavior.clear(); m.cooldown.clear()

    def test_primero_responde(self):
        st, out = post({"model": "auto", "input": []})
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(out)["model"], "a")
        self.assertEqual([s[0] for s in seen], ["a"])

    def test_pasa_al_siguiente_si_429_y_lo_recuerda(self):
        behavior["a"] = ("status", 429)
        st, out = post({"model": "auto", "input": [{"type": "reasoning", "encrypted_content": "zzz"}, {"type": "message"}]})
        self.assertEqual((st, json.loads(out)["model"]), (200, "b"))
        self.assertEqual([s[0] for s in seen], ["a", "b"])
        self.assertNotIn("reasoning", [x.get("type") for x in seen[-1][1]["input"]])  # sin razonamiento cifrado ajeno
        self.assertGreater(m.cooldown["a"], time.time() + 100)                          # respeta Retry-After
        seen.clear()
        post({"model": "auto", "input": []})
        self.assertEqual([s[0] for s in seen], ["b"])                                   # a se salta mientras se enfría

    def test_pasa_al_siguiente_si_401(self):
        behavior["a"] = ("status", 401)
        st, out = post({"model": "auto", "input": []})
        self.assertEqual((st, json.loads(out)["model"]), (200, "b"))

    def test_cae_hasta_el_ultimo_y_devuelve_su_error(self):
        for x in "abc":
            behavior[x] = ("status", 503)
        st, _ = post({"model": "auto", "input": []})
        self.assertEqual(st, 503)
        self.assertEqual([s[0] for s in seen], ["a", "b", "c"])

    def test_streaming_se_reenvia(self):
        behavior["a"] = ("sse",)
        c = http.client.HTTPConnection("127.0.0.1", RT, timeout=10)
        c.request("POST", "/v1/responses", json.dumps({"model": "auto", "stream": True}), {"Content-Type": "application/json"})
        r = c.getresponse()
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(r.read(), b"data: 0\n\ndata: 1\n\ndata: 2\n\n")

    def test_modelo_normal_pasa_sin_tocar(self):
        st, out = post({"model": "b", "input": [{"type": "reasoning"}]})
        self.assertEqual((st, json.loads(out)["model"]), (200, "b"))
        self.assertEqual(seen[0][1]["input"], [{"type": "reasoning"}])

    def test_rechaza_origen_web(self):
        st, _ = post({"model": "auto"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(st, 403)

    def test_sin_modelos_503(self):
        m.load_state = lambda: {"providers": [], "auto": {"models": []}}
        try:
            st, _ = post({"model": "auto"})
            self.assertEqual(st, 503)
        finally:
            m.load_state = lambda: {"providers": [], "auto": {"models": ["a", "b", "c"]}}


if __name__ == "__main__":
    unittest.main(verbosity=2)
