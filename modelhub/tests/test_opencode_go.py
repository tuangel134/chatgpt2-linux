#!/usr/bin/env python3
"""Prueba OpenCode Go de punta a punta SIN clave real: un «OpenCode Go» falso + CLIProxyAPI de verdad.
Comprueba que cada modelo sale por la ruta y el protocolo correctos, con la clave en la cabecera y el nombre real del modelo.
Necesita el binario cli-proxy-api (CPA_BIN o ~/.local/opt/chatgpt2/cliproxyapi/cli-proxy-api)."""
import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FAKE, CPA = 18500, 18417
KEY = "ocgo-test-key-123456"
seen = []

MODELS = ["glm-5.3", "gpt-6-luna", "claude-haiku-5-5", "gemini-4-argon-contributor", "kimi-k3", "minimax-m3", "grok-4.7"]
TMP = Path(tempfile.mkdtemp(prefix="ocgo-test-"))
os.environ.update({"OPENCODE_GO_BASE": f"http://127.0.0.1:{FAKE}/inference/go", "CODEX_HOME": str(TMP / "data"),
                   "CHATGPT2_HOME": str(TMP / "app"), "HOME": str(TMP)})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import modelhub as m  # noqa: E402

BIN = Path(os.environ.get("CPA_BIN") or Path.home().joinpath(".local/opt/chatgpt2/cliproxyapi/cli-proxy-api"))
if not BIN.exists():
    BIN = Path(os.environ.get("REAL_HOME", "/home/angel")) / ".local/opt/chatgpt2/cliproxyapi/cli-proxy-api"


class Fake(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def do_GET(self):
        out = json.dumps({"object": "list", "data": [{"id": x, "object": "model"} for x in MODELS]}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(out)))
        self.end_headers(); self.wfile.write(out)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            j = json.loads(body or b"{}")
        except ValueError:
            j = {}
        seen.append({"path": self.path, "auth": self.headers.get("Authorization", ""), "xkey": self.headers.get("x-api-key", ""),
                     "goog": self.headers.get("x-goog-api-key", ""), "model": j.get("model")})
        out = b'{"error":{"message":"fake upstream"}}'
        self.send_response(500); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(out)))
        self.end_headers(); self.wfile.write(out)


def post(path, payload):
    c = http.client.HTTPConnection("127.0.0.1", CPA, timeout=30)
    c.request("POST", path, json.dumps(payload), {"Authorization": "Bearer " + m.cpa_key(), "Content-Type": "application/json"})
    r = c.getresponse()
    return r.status, r.read()


@unittest.skipUnless(BIN.exists(), "no hay binario de CLIProxyAPI")
class OpenCodeGo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        m.CPA_PORT = CPA
        (TMP / "data").mkdir(parents=True, exist_ok=True)
        (TMP / "app/cliproxyapi").mkdir(parents=True, exist_ok=True)
        m.CPA_DIR = TMP / "app/cliproxyapi"; m.CPA_CFG = m.CPA_DIR / "config.yaml"; m.AUTH_DIR = TMP / "auth"
        cls.fake = ThreadingHTTPServer(("127.0.0.1", FAKE), Fake)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        st = {"providers": [], "auto": {"models": []}, "opencode_go": {"api_key": KEY}}
        m.write_cpa_config(st)
        cls.cfg = m.CPA_CFG.read_text()
        cls.proc = subprocess.Popen([str(BIN), "-config", str(m.CPA_CFG)], cwd=str(m.CPA_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            if m.cpa_alive():
                break
            time.sleep(0.25)
        cls.models = [x["id"] for x in m.cpa_models()]

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.fake.shutdown()

    def setUp(self):
        seen.clear()

    def test_todos_los_modelos_aparecen(self):
        for mid in MODELS:
            self.assertIn("go-" + mid, self.models, mid)

    def test_catalogo_con_nombres_y_xhigh(self):
        st = {"providers": [], "auto": {"models": []}, "opencode_go": {"api_key": KEY}}
        m._go_cache.update({"at": 0, "ents": []})
        cat = {e["slug"]: e for e in m.build_catalog(st)}
        self.assertEqual(cat["go-kimi-k3"]["display_name"], "Kimi K3 (OpenCode Go)")
        self.assertIn("xhigh", [l["effort"] for l in cat["go-gpt-6-luna"]["supported_reasoning_levels"]])
        self.assertNotIn("xhigh", [l["effort"] for l in cat["go-glm-5.3"]["supported_reasoning_levels"]])

    def test_chat(self):
        post("/v1/chat/completions", {"model": "go-glm-5.3", "messages": [{"role": "user", "content": "hola"}]})
        r = seen[-1]
        self.assertEqual((r["path"], r["model"], r["auth"]), ("/inference/go/openai/v1/chat/completions", "glm-5.3", "Bearer " + KEY))

    def test_responses(self):
        post("/v1/responses", {"model": "go-gpt-6-luna", "input": "hola"})
        r = seen[-1]
        self.assertEqual((r["path"], r["model"]), ("/inference/go/openai/v1/responses", "gpt-6-luna"))
        self.assertIn(KEY, r["auth"] + r["xkey"])

    def test_anthropic(self):
        post("/v1/chat/completions", {"model": "go-claude-haiku-5-5", "messages": [{"role": "user", "content": "hola"}]})
        r = seen[-1]
        self.assertEqual((r["path"].split("?")[0], r["model"]), ("/inference/go/anthropic/v1/messages", "claude-haiku-5-5"))
        self.assertIn(KEY, r["auth"] + r["xkey"])

    def test_google(self):
        post("/v1/chat/completions", {"model": "go-gemini-4-argon-contributor", "messages": [{"role": "user", "content": "hola"}]})
        r = seen[-1]
        self.assertTrue(r["path"].startswith("/inference/go/google/v1beta/models/gemini-4-argon-contributor"), r["path"])
        self.assertIn(KEY, r["auth"] + r["xkey"] + r["goog"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
