#!/usr/bin/env python3
"""Varias cuentas: estado/uso por cuenta, pausar/reanudar y estrategia reparto, con CLIProxyAPI de verdad y cuentas falsas."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

CPA = 18700
TMP = Path(tempfile.mkdtemp(prefix="acct-test-"))
os.environ.update({"CODEX_HOME": str(TMP / "data"), "CHATGPT2_HOME": str(TMP / "app"), "HOME": str(TMP)})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import modelhub as m  # noqa: E402

BIN = Path(os.environ.get("CPA_BIN") or "/home/angel/.local/opt/chatgpt2/cliproxyapi/cli-proxy-api")


@unittest.skipUnless(BIN.exists(), "no hay binario de CLIProxyAPI")
class Accounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        m.CPA_PORT = CPA
        m.CPA_DIR = TMP / "app/cliproxyapi"; m.CPA_CFG = m.CPA_DIR / "config.yaml"; m.AUTH_DIR = TMP / ".cli-proxy-api"
        m.CPA_DIR.mkdir(parents=True); m.AUTH_DIR.mkdir(parents=True)
        for i, mail in enumerate(["a@example.com", "b@example.com"]):
            (m.AUTH_DIR / f"codex-{mail}.json").write_text(json.dumps({
                "type": "codex", "email": mail, "access_token": "x", "refresh_token": "x", "id_token": "x", "account_id": f"acc{i}",
                "expired": "2099-01-01T00:00:00Z", "last_refresh": "2026-10-23T00:00:00Z"}))
        m.write_cpa_config({"providers": [], "auto": {"models": []}, "routing": {"strategy": "fill-first"}})
        cls.cfg = m.CPA_CFG.read_text()
        cls.proc = subprocess.Popen([str(BIN), "-config", str(m.CPA_CFG)], cwd=str(m.CPA_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            if m.cpa_alive():
                break
            time.sleep(0.25)
        time.sleep(1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()

    def test_config_lleva_estrategia_y_clave_de_gestion(self):
        self.assertIn('strategy: "fill-first"', self.cfg)
        self.assertIn("secret-key:", self.cfg)
        self.assertEqual(m.strategy({"routing": {"strategy": "otra"}}), "round-robin")  # valor raro -> por defecto

    def test_lista_con_estado_y_uso(self):
        cs = {c["email"]: c for c in m.credentials()}
        self.assertEqual(set(cs), {"a@example.com", "b@example.com"})
        for c in cs.values():
            self.assertEqual(c["type"], "codex")
            self.assertFalse(c["disabled"])
            for k in ("ok_1h", "fail_1h", "ok_3h", "fail_3h", "ok_total", "fail_total"):
                self.assertIn(k, c)

    def test_pausar_y_reanudar(self):
        name = "codex-b@example.com.json"
        m.set_account_disabled(name, True)
        c = next(c for c in m.credentials() if c["file"] == name)
        self.assertTrue(c["disabled"])
        self.assertTrue(json.loads((m.AUTH_DIR / name).read_text()).get("disabled"))  # queda guardado en disco
        m.set_account_disabled(name, False)
        self.assertFalse(next(c for c in m.credentials() if c["file"] == name)["disabled"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
