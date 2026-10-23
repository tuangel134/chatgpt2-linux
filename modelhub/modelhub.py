#!/usr/bin/env python3
"""Servicio local del clon "ChatGPT 2": gestiona proveedores/modelos personalizados.

Escucha solo en 127.0.0.1:8318 y exige el token de ~/.codex-2/hub-token.
Escribe la configuración de CLIProxyAPI (proveedores openai-compatibility),
regenera el catálogo de modelos de Codex y lanza los inicios de sesión OAuth.
"""
import http.client
import json
import os
import pathlib
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # con «python -I» el directorio del script no está en sys.path
import opencode_go as ocgo  # noqa: E402

HOME = Path.home()
ROOT = Path(os.environ.get("CHATGPT2_HOME") or HOME / ".local/opt/chatgpt2")
CODEX_HOME = Path(os.environ.get("CODEX_HOME") or HOME / ".codex-2")
CPA_DIR = Path(os.environ.get("CPA_DIR") or ROOT / "cliproxyapi")
CPA_BIN = CPA_DIR / "cli-proxy-api"
CPA_CFG = CPA_DIR / "config.yaml"
AUTH_DIR = HOME / ".cli-proxy-api"
STATE = CODEX_HOME / "hub-providers.json"
TOKEN_FILE = CODEX_HOME / "hub-token"
MGMT_FILE = CODEX_HOME / "cpa-mgmt-key"  # clave de gestión local del proxy (solo la usa el hub, por loopback)
CATALOG = CODEX_HOME / "hub-models.json"
CODEX_TOML = CODEX_HOME / "config.toml"
PORT = 8318
CPA_PORT = 8317
DEFAULT_GO_MODEL = "go-deepseek-v4.1-flash"  # modelo principal por defecto cuando se conecta OpenCode Go
REMOTE_PORT = 8324  # agente de control remoto (móvil), ver remote/agent.cjs
ROUTER_PORT = 8323  # enrutador local (AUTO y saneado de cápsulas); solo escucha en 127.0.0.1
CPA_PID = CODEX_HOME / "cliproxyapi.pid"
LOGIN_FLAGS = {"codex": "-codex-login", "claude": "-claude-login", "antigravity": "-antigravity-login"}
SUFFIX = {"antigravity": "Antigravity", "openai": "ChatGPT", "codex": "ChatGPT", "anthropic": "Claude", "claude": "Claude"}

logins = {}  # kind -> {"proc": Popen, "log": Path, "started": float}
lock = threading.Lock()


def read_token():
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    if not TOKEN_FILE.exists():
        TOKEN_FILE.write_text(secrets.token_hex(24))
        TOKEN_FILE.chmod(0o600)
    return TOKEN_FILE.read_text().strip()


def mgmt_key():
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    if not MGMT_FILE.exists():
        MGMT_FILE.write_text(secrets.token_hex(24))
        MGMT_FILE.chmod(0o600)
    return MGMT_FILE.read_text().strip()


STRATEGIES = ("round-robin", "fill-first")


def strategy(st):
    s = (st.get("routing") or {}).get("strategy")
    return s if s in STRATEGIES else "round-robin"


def cpa_key():
    """Clave local del proxy; se genera la primera vez (config.yaml mínima) y se conserva después."""
    if CPA_CFG.exists():
        m = re.search(r'"(sk-local-[a-f0-9]+)"', CPA_CFG.read_text())
        if m:
            return m.group(1)
    key = "sk-local-" + secrets.token_hex(24)
    CPA_DIR.mkdir(parents=True, exist_ok=True)
    CPA_CFG.write_text(f'server:\n  host: "127.0.0.1"\n  port: {CPA_PORT}\naccess:\n  api-keys:\n    - "{key}"\n')
    CPA_CFG.chmod(0o600)
    return key


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"providers": [], "auto": {"models": []}}


def save_state(st):
    STATE.write_text(json.dumps(st, indent=2))
    STATE.chmod(0o600)


def yq(v):
    return json.dumps(v, ensure_ascii=False)


_go_cache = {"at": 0, "ents": []}


def go_key(st):
    return ((st.get("opencode_go") or {}).get("api_key") or "").strip()


def go_entries(st, refresh=False):
    """Modelos de OpenCode Go (lista pública), solo si hay clave. Se cachea 5 minutos."""
    if not go_key(st):
        return []
    if refresh or time.time() - _go_cache["at"] > 300 or not _go_cache["ents"]:
        _go_cache.update({"at": time.time(), "ents": ocgo.entries(cache=CODEX_HOME / "opencode-go-models.json")})
    return _go_cache["ents"]


def go_refresh():
    """Vuelve a pedir la lista de modelos de OpenCode Go y, si OpenCode añadió o retiró alguno, regenera catálogo y proxy."""
    st = load_state()
    if not go_key(st):
        return None
    cache = CODEX_HOME / "opencode-go-models.json"
    try:
        old = set(json.loads(cache.read_text()))
    except Exception:
        old = {e["name"] for e in _go_cache["ents"]}
    try:
        ids = ocgo.fetch_ids(cache=cache, strict=True)
    except Exception as e:
        raise RuntimeError("No se pudo consultar la lista de OpenCode Go (%s)" % e)
    added, removed = sorted(set(ids) - old), sorted(old - set(ids))
    _go_cache.update({"at": time.time(), "ents": ocgo.entries(ids)})
    st = load_state()
    st["opencode_go"] = {**st.get("opencode_go", {}), "updated": int(time.time()), "last_diff": {"added": added, "removed": removed}}
    save_state(st)
    if added or removed:
        apply_all()
    return {"added": added, "removed": removed, "total": len(ids), "updated": st["opencode_go"]["updated"]}


def go_daily():
    """Hilo: una vez al día (y al arrancar si la última vez fue hace más de 24 h) actualiza la lista de OpenCode Go."""
    time.sleep(45)
    while True:
        try:
            st = load_state()
            if go_key(st) and time.time() - (st.get("opencode_go") or {}).get("updated", 0) > 86400:
                go_refresh()
        except Exception as e:
            print("actualización diaria de OpenCode Go:", e, file=sys.stderr)
        time.sleep(1800)


def write_cpa_config(st):
    lines = [
        "config-version: 8",
        "server:",
        '  host: "127.0.0.1"',
        f"  port: {CPA_PORT}",
        "management:",
        "  allow-remote: false",
        f"  secret-key: {yq(mgmt_key())}",
        "access:",
        "  api-keys:",
        f"    - {yq(cpa_key())}",
        "oauth:",
        '  auth-dir: "~/.cli-proxy-api"',
        "routing:",
        f"  strategy: {yq(strategy(st))}",
    ]
    provs = [p for p in st["providers"] if not p.get("disabled") and p.get("models")]
    gents = go_entries(st)
    gchat = ocgo.chat_provider(go_key(st), gents)
    if gchat:
        provs = provs + [gchat]
    if provs:
        lines.append("openai-compatibility:")
        for p in provs:
            lines += [f"  - name: {yq(p['name'])}", f"    base-url: {yq(p['base_url'])}"]
            if p.get("headers"):
                lines.append("    headers:")
                lines += [f"      {yq(k)}: {yq(v)}" for k, v in p["headers"].items()]
            if p.get("api_key"):
                lines += ["    api-key-entries:", f"      - api-key: {yq(p['api_key'])}"]
            lines.append("    models:")
            for m in p["models"]:
                alias = m.get("alias") or m["name"]
                lines += [f"      - name: {yq(m['name'])}", f"        alias: {yq(alias)}"]
                if m.get("display"):
                    lines.append(f"        display-name: {yq(m['display'])}")
                if m.get("context"):
                    lines.append(f"        max-context-length: {int(m['context'])}")
                mods = ["text", "image"] if m.get("image") else ["text"]
                lines.append(f"        input-modalities: {json.dumps(mods)}")
    lines += ocgo.cpa_groups(go_key(st), gents)  # modelos de OpenCode Go que no son de chat (responses / anthropic / google)
    tmp = CPA_CFG.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n")
    tmp.chmod(0o600)
    tmp.replace(CPA_CFG)


def cpa_alive():
    import socket
    try:
        socket.create_connection(("127.0.0.1", CPA_PORT), 0.3).close()
        return True
    except OSError:
        return False


def restart_proxy():
    """Reinicia CLIProxyAPI (proceso propio, sin systemd): mata el anterior por pidfile y lanza uno nuevo."""
    try:
        os.kill(int(CPA_PID.read_text()), signal.SIGTERM)
    except (OSError, ValueError):
        pass
    for _ in range(20):
        if not cpa_alive():
            break
        time.sleep(0.2)
    if cpa_alive():  # arrancado sin pidfile (p. ej. por otra vía): buscarlo por su línea de comandos
        subprocess.run(["pkill", "-f", f"^{CPA_BIN} -config {CPA_CFG}$"], check=False)
        for _ in range(20):
            if not cpa_alive():
                break
            time.sleep(0.2)
    if not CPA_BIN.exists():
        return
    log = (CODEX_HOME / "cliproxyapi.log").open("ab")
    proc = subprocess.Popen([str(CPA_BIN), "-config", str(CPA_CFG)], cwd=str(CPA_DIR), stdout=log, stderr=log,
                            stdin=subprocess.DEVNULL, start_new_session=True)
    CPA_PID.write_text(str(proc.pid))
    for _ in range(40):
        if cpa_alive():
            break
        time.sleep(0.25)


def wait_models_stable(max_s=25):
    """Tras reiniciar el proxy las cuentas OAuth se cargan poco a poco: espera a que la lista de modelos deje de crecer."""
    last, same, end = -1, 0, time.time() + max_s
    while time.time() < end:
        try:
            n = len(cpa_models())
        except Exception:
            n = -1
        same = same + 1 if n == last and n > 0 else 0
        if same >= 3:
            return
        last = n
        time.sleep(1)


def cpa_models():
    req = urllib.request.Request(f"http://127.0.0.1:{CPA_PORT}/v1/models", headers={"Authorization": "Bearer " + cpa_key()})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r).get("data", [])


def meta_for(mid, custom):
    low = mid.lower()
    ctx = 128000
    image = False
    if "gemini" in low:
        ctx, image = 1000000, True
    elif "claude" in low:
        ctx, image = 200000, True
    elif low.startswith("gpt-5") or low.startswith("gpt-6") or low.startswith("o"):
        ctx, image = 400000, not low.startswith("gpt-oss")
    elif "gpt-oss" in low:
        ctx = 128000
    if custom:
        ctx = custom.get("context") or ctx
        image = bool(custom.get("image"))
    return ctx, image


def pretty(mid):
    mid = re.sub(r"(?<=\d)-(?=\d)", ".", mid)
    fix = {"gpt": "GPT", "oss": "OSS", "ai": "AI"}
    return " ".join(fix.get(w.lower(), w.capitalize()) for w in re.split(r"[-_]", mid))


LEVELS_BASE = [
    {"effort": "low", "description": "Respuestas rápidas con poco razonamiento"},
    {"effort": "medium", "description": "Equilibrio entre velocidad y razonamiento"},
    {"effort": "high", "description": "Más razonamiento para problemas difíciles"},
]
BASE_INSTR = (
    "You are Codex, a coding agent. Help the user understand, modify, test, and review code in their "
    "workspace. Follow the user's instructions, use tools when needed, and communicate concise progress and verification."
)


def build_catalog(st):
    custom = {}
    for p in st["providers"]:
        for m in p.get("models", []):
            custom[m.get("alias") or m["name"]] = {**m, "provider": p["name"]}
    for e in go_entries(st):
        custom[e["alias"]] = {**e, "provider": ocgo.PROVIDER}
    out = []
    for i, m in enumerate(cpa_models()):
        mid = m["id"]
        if "image" in mid.lower() and "flash-image" in mid.lower():
            continue
        c = custom.get(mid)
        ctx, image = meta_for(mid, c)
        owner = (m.get("owned_by") or "").lower()
        if c:
            label = c.get("display") or pretty(mid)
            suffix = c["provider"]
        else:
            label = pretty(mid)
            suffix = SUFFIX.get(owner, owner.capitalize() or None)
        name = f"{label} ({suffix})" if suffix and suffix.lower() not in label.lower() else label
        levels = LEVELS_BASE + ([{"effort": "xhigh", "description": "Razonamiento máximo"}] if (mid.startswith("gpt-") or (c and c.get("gpt"))) else [])
        out.append({
            "slug": mid, "display_name": name, "description": "Modelo servido por el hub local (CLIProxyAPI)",
            "default_reasoning_level": "medium", "supported_reasoning_levels": levels, "shell_type": "shell_command",
            "visibility": "list", "supported_in_api": True, "priority": i, "additional_speed_tiers": [], "service_tiers": [],
            "base_instructions": BASE_INSTR, "supports_reasoning_summaries": True, "default_reasoning_summary": "none",
            "support_verbosity": True, "default_verbosity": "low", "apply_patch_tool_type": "freeform",
            "web_search_tool_type": "text_and_image", "truncation_policy": {"mode": "tokens", "limit": 10000},
            "supports_parallel_tool_calls": True, "supports_image_detail_original": True, "context_window": ctx,
            "max_context_window": ctx, "effective_context_window_percent": 95, "experimental_supported_tools": [],
            "input_modalities": ["text", "image"] if image else ["text"], "supports_search_tool": False,
            "use_responses_lite": False,
        })
    auto = auto_entry(st, out)
    if auto:
        out.insert(0, auto)
        for i, m in enumerate(out):
            m["priority"] = i
    return out


def auto_pool(st, catalog=None):
    """Modelos de AUTO que siguen disponibles, en el orden elegido por el usuario."""
    wanted = [m for m in (st.get("auto") or {}).get("models", []) if isinstance(m, str) and m != "auto"]
    if catalog is not None:
        have = {m["slug"] for m in catalog}
    else:
        try:
            have = {m["id"] for m in cpa_models()}
        except Exception:
            have = set(wanted)
    return [m for m in wanted if m in have]


def auto_entry(st, catalog):
    pool = auto_pool(st, catalog)
    if not pool:
        return None
    by = {m["slug"]: m for m in catalog}
    members = [by[m] for m in pool]
    entry = json.loads(json.dumps(members[0]))  # parte del primero de la lista
    ctx = min(m["context_window"] for m in members)
    image = all("image" in m["input_modalities"] for m in members)
    names = ", ".join(m["display_name"] for m in members)
    entry.update({
        "slug": "auto", "display_name": "AUTO",
        "description": "Cambia solo de modelo: usa el primero de tu lista y, si falla o se queda sin cuota, pasa al siguiente. Orden: " + names,
        "supported_reasoning_levels": LEVELS_BASE, "default_reasoning_level": "medium",
        "context_window": ctx, "max_context_window": ctx,
        "input_modalities": ["text", "image"] if image else ["text"],
    })
    return entry


def patch_toml(first_model, use_router=True, force_model=None):
    s = CODEX_TOML.read_text() if CODEX_TOML.exists() else ""
    if s.startswith("["):
        s = "\n" + s
    key = cpa_key()
    block = (
        f'[model_providers.hub]\nname = "Hub local (CLIProxyAPI)"\nbase_url = "http://127.0.0.1:{ROUTER_PORT if use_router else CPA_PORT}/v1"\n'
        f'wire_api = "responses"\nexperimental_bearer_token = "{key}"\n'
    )
    # quitar el proveedor antiguo y el bloque hub previo
    s = re.sub(r"\[model_providers\.(antigravity|hub)\]\n(?:(?!\[).*\n)*", "", s)
    # quitar claves de nivel superior que gestionamos
    head, sep, rest = s.partition("\n[")
    for k in ("model_provider", "model_catalog_json"):
        head = re.sub(rf"(?m)^{k} = .*\n", "", head)
    cur = re.search(r'(?m)^model = "(.*)"', head)
    model_line = ""
    ids = []
    try:
        ids = [m["slug"] for m in json.loads(CATALOG.read_text())["models"]]
    except Exception:
        pass
    if force_model:  # el usuario pidió este modelo como principal
        head = re.sub(r"(?m)^model = .*\n", "", head)
        model_line = f'model = "{force_model}"\n'
    elif not cur or (ids and cur.group(1) not in ids):
        head = re.sub(r"(?m)^model = .*\n", "", head)
        if first_model:
            model_line = f'model = "{first_model}"\n'
    # Sin modelos (aún no hay cuentas) Codex rechaza un catálogo vacío: no se activa el proveedor hasta que haya alguno.
    top = (model_line + f'model_provider = "hub"\nmodel_catalog_json = "{CATALOG}"\n') if ids or first_model else ""
    new = top + head.lstrip("\n") + (sep + rest if sep else "")
    new = new.rstrip("\n") + "\n\n" + block
    CODEX_TOML.write_text(new)
    CODEX_TOML.chmod(0o600)


MCP_BLOCK = (
    '[mcp_servers.gemini_media]\n'
    f'command = "{sys.executable}"\n'
    f'args = ["-I", "{pathlib.Path(__file__).with_name("gemini_media_mcp.py")}"]\n'
    'startup_timeout_sec = 20\ntool_timeout_sec = 300\ndefault_tools_approval_mode = "approve"\n'
)


def ensure_mcp():
    s = CODEX_TOML.read_text()
    if "[mcp_servers.gemini_media]" not in s:
        CODEX_TOML.write_text(s.rstrip("\n") + "\n\n" + MCP_BLOCK)


def apply_all(restart_cpa=True):
    st = load_state()
    go_entries(st, refresh=True)
    write_cpa_config(st)
    if restart_cpa:
        restart_proxy()
        wait_models_stable()
    cat = build_catalog(st)
    CATALOG.write_text(json.dumps({"models": cat}, indent=2, ensure_ascii=False))
    slugs = [m["slug"] for m in cat]
    dm = st.get("default_model") or {}
    if go_key(st) and not dm:  # primera vez con OpenCode Go conectado: DeepSeek V4.1 Flash como principal
        dm = {"slug": DEFAULT_GO_MODEL, "pending": True}
    force = dm["slug"] if dm.get("pending") and dm.get("slug") in slugs else None
    first = DEFAULT_GO_MODEL if DEFAULT_GO_MODEL in slugs else (slugs[0] if slugs else None)
    patch_toml(first, use_router=True, force_model=force)
    if dm and (force or dm != st.get("default_model")):
        st2 = load_state()
        st2["default_model"] = {"slug": dm["slug"], "pending": False if force else bool(dm.get("pending"))}
        save_state(st2)
    ensure_mcp()
    return len(cat)


def mgmt(method, path, body=None, timeout=8):
    req = urllib.request.Request(f"http://127.0.0.1:{CPA_PORT}/v8/management{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-Management-Key": mgmt_key(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def credentials():
    """Cuentas conectadas con su estado y uso reciente (API de gestión del proxy); sin proxy, solo lo que hay en disco."""
    try:
        out = []
        for f in mgmt("GET", "/credentials").get("files", []):
            if f.get("runtime_only") or f.get("source") != "file":
                continue
            rec = f.get("recent_requests") or []
            last = rec[-6:]  # ~ última hora (cubos de 10 min)
            cool = [c for c in (f.get("cooldowns") or []) if c]
            out.append({
                "file": f.get("name") or f.get("id"), "type": f.get("provider") or f.get("type"), "email": f.get("email") or f.get("label") or "",
                "disabled": bool(f.get("disabled")), "unavailable": bool(f.get("unavailable")), "status": f.get("status") or "",
                "status_message": f.get("status_message") or "", "cooldowns": cool,
                "ok_1h": sum(r.get("success", 0) for r in last), "fail_1h": sum(r.get("failed", 0) for r in last),
                "ok_3h": sum(r.get("success", 0) for r in rec), "fail_3h": sum(r.get("failed", 0) for r in rec),
                "ok_total": f.get("success", 0), "fail_total": f.get("failed", 0)})
        return out
    except Exception:
        return [{**a, "disabled": False, "unavailable": False, "status": "", "status_message": "", "cooldowns": [],
                 "ok_1h": 0, "fail_1h": 0, "ok_3h": 0, "fail_3h": 0, "ok_total": 0, "fail_total": 0} for a in accounts()]


def set_account_disabled(name, disabled):
    name = os.path.basename(name)
    try:
        mgmt("PATCH", "/credentials/status", {"name": name, "disabled": bool(disabled)})
        return
    except Exception:
        pass
    f = AUTH_DIR / name  # sin proxy: se edita el archivo y el proxy lo lee al arrancar
    d = json.loads(f.read_text())
    d["disabled"] = bool(disabled)
    f.write_text(json.dumps(d))


def accounts():
    out = []
    for f in sorted(AUTH_DIR.glob("*.json")):
        try:
            d = json.loads(f.read_text())
        except Exception:
            continue
        out.append({"file": f.name, "type": d.get("type") or f.name.split("-")[0], "email": d.get("email") or d.get("account") or ""})
    return out


def start_login(kind):
    if kind not in LOGIN_FLAGS:
        raise ValueError("proveedor desconocido")
    with lock:
        cur = logins.get(kind)
        if cur and cur["proc"].poll() is None:
            cur["proc"].terminate()
        log = Path(f"/tmp/modelhub-login-{kind}.log")
        proc = subprocess.Popen([str(CPA_BIN), "-config", str(CPA_CFG), LOGIN_FLAGS[kind]],
                                stdout=log.open("w"), stderr=subprocess.STDOUT, start_new_session=True)
        logins[kind] = {"proc": proc, "log": log, "started": time.time()}


def login_status(kind):
    cur = logins.get(kind)
    if not cur:
        return {"state": "idle"}
    running = cur["proc"].poll() is None
    text = cur["log"].read_text(errors="ignore") if cur["log"].exists() else ""
    ok = "successful" in text.lower() and not running
    return {"state": "running" if running else ("ok" if ok else "failed"), "tail": text[-300:] if not ok else ""}


def restart_clone():
    script = ROOT / "modelhub/restart-clone.sh"
    subprocess.Popen(["sh", str(script)], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ------------------------------------------------------------------ modo AUTO (respaldo por orden)
# Enrutador local: Codex habla con él (en vez de con el proxy) cuando existe el modelo «auto». Reenvía todo tal cual
# al proxy; si la petición pide model=="auto", prueba los modelos elegidos por orden y pasa al siguiente cuando uno
# falla ANTES de empezar a responder (sin cuota, límite, error del servidor, modelo no encontrado, sin conexión).
FAILOVER_STATUS = {401, 402, 403, 404, 408, 429}  # 401: sesión caducada o proveedor sin acceso para ese modelo
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade"}
PROC_SESSION = "chatgpt2-" + secrets.token_hex(8)  # último recurso si Codex no manda ninguna sesión
cooldown = {}   # modelo -> instante hasta el que se salta
auto_last = {"model": "", "at": 0, "skipped": []}


def cool(model, status=None, retry_after=None):
    secs = 60
    if status in (429, 403, 402, 401):
        secs = 300
    elif status == 404:
        secs = 600
    try:
        if retry_after:
            secs = max(10, min(3600, int(float(retry_after))))
    except ValueError:
        pass
    cooldown[model] = time.time() + secs


def auto_chain():
    pool = auto_pool(load_state())
    now = time.time()
    ready = [m for m in pool if cooldown.get(m, 0) <= now]
    if ready:
        return ready
    return sorted(pool, key=lambda m: cooldown.get(m, 0))  # todos enfriándose: reintenta el que antes se libera


COMPACTION_TYPES = {"compaction", "compaction_summary"}
LOST_CONTEXT = ("[Aviso de ChatGPT 2: un resumen anterior de esta conversación venía cifrado por otro proveedor y no se pudo "
                "recuperar; se descartó. Si hace falta, pide al usuario que repita el contexto importante.]")


def has_compaction(d):
    return isinstance(d.get("input"), list) and any(isinstance(x, dict) and x.get("type") in COMPACTION_TYPES for x in d["input"])


def strip_compaction(d):
    """Sustituye las cápsulas de compactación ilegibles por un aviso de texto (mejor que fallar la petición)."""
    out, noted = [], False
    for x in d["input"]:
        if isinstance(x, dict) and x.get("type") in COMPACTION_TYPES:
            if not noted:
                out.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text": LOST_CONTEXT}]})
                noted = True
            continue
        out.append(x)
    d["input"] = out
    return d


class Buffered:
    """Respuesta ya leída (se usa cuando hubo que mirar el cuerpo de un 400 antes de decidir)."""
    def __init__(self, status, body, headers):
        self.status, self._body, self._h, self._sent = status, body, headers, False

    def getheaders(self):
        return [(k, v) for k, v in self._h if k.lower() != "content-length"] + [("Content-Length", str(len(self._body)))]

    def getheader(self, name, default=None):
        return next((v for k, v in self._h if k.lower() == name.lower()), default)

    def read(self, *a):
        return b""

    def read1(self, *a):
        if self._sent:
            return b""
        self._sent = True
        return self._body


class Router(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # respuesta delimitada por cierre: sirve para streaming SSE

    def log_message(self, *a):
        pass

    def _fail(self, code, text):
        body = json.dumps({"error": {"message": text, "type": "auto_router_error"}}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if self.headers.get("Origin") or host not in ("127.0.0.1", "localhost"):
            return self._fail(403, "forbidden")  # nada de páginas web ni DNS rebinding
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        base = {k: v for k, v in self.headers.items() if k.lower() not in HOP | {"host", "content-length"}}
        data, chain = None, [None]
        if self.command == "POST" and body and "content-encoding" not in {k.lower() for k in base} \
                and self.path.split("?")[0].endswith(("/responses", "/chat/completions")):
            try:
                data = json.loads(body)
            except ValueError:
                data = None
            if not isinstance(data, dict):
                data = None
            if data and data.get("model") == "auto":
                chain = auto_chain()
                if not chain:
                    return self._fail(503, "AUTO no tiene modelos disponibles: elige modelos en Ajustes → Modelos personalizados.")
        if not any(k.lower() == "x-opencode-session" for k in base):
            sid = next((v for k, v in base.items() if k.lower() in ("session_id", "session-id", "conversation_id", "x-session-id")), "") \
                or ((data or {}).get("prompt_cache_key") if data else "") or PROC_SESSION
            base["x-opencode-session"] = str(sid)[:128]  # lo exige OpenCode Go (y es inocuo para los demás proveedores)
        skipped = []
        for i, model in enumerate(chain):
            payload = body
            if model:
                d = dict(data)
                d["model"] = model
                if isinstance(d.get("input"), list):  # el razonamiento cifrado de un modelo no vale para otro
                    d["input"] = [x for x in d["input"] if not (isinstance(x, dict) and x.get("type") == "reasoning")]
                payload = json.dumps(d).encode()
            try:
                conn = http.client.HTTPConnection("127.0.0.1", CPA_PORT, timeout=900)
                conn.request(self.command, self.path, payload, {**base, "Content-Length": str(len(payload))})
                resp = conn.getresponse()
                if resp.status == 400 and data and has_compaction(data):
                    err = resp.read(); conn.close()
                    if b"compaction capsule" in err:  # resumen de otro proveedor/versión que el proxy no reconoce
                        d = strip_compaction(dict(data))
                        if model:
                            d["model"] = model
                            if isinstance(d.get("input"), list):
                                d["input"] = [x for x in d["input"] if not (isinstance(x, dict) and x.get("type") == "reasoning")]
                        payload = json.dumps(d).encode()
                        conn = http.client.HTTPConnection("127.0.0.1", CPA_PORT, timeout=900)
                        conn.request(self.command, self.path, payload, {**base, "Content-Length": str(len(payload))})
                        resp = conn.getresponse()
                    else:
                        resp = Buffered(400, err, resp.getheaders())
            except Exception as e:
                if model and i < len(chain) - 1:
                    cool(model); skipped.append(model + " (sin conexión)")
                    continue
                return self._fail(502, "No se pudo contactar con el proxy: %s" % e)
            if model and resp.status in FAILOVER_STATUS | set(range(500, 600)) and i < len(chain) - 1:
                resp.read(); conn.close()
                cool(model, resp.status, resp.getheader("Retry-After")); skipped.append("%s (HTTP %d)" % (model, resp.status))
                continue
            if model:
                auto_last.update({"model": model, "at": int(time.time()), "skipped": skipped})
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            self.end_headers()
            try:
                while True:
                    chunk = resp.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                conn.close()
            return

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _handle


def start_router():
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", ROUTER_PORT), Router)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    except OSError as e:
        print("enrutador AUTO no iniciado:", e, file=sys.stderr)


def catalog_names():
    try:
        return [{"slug": m["slug"], "name": m["display_name"]} for m in json.loads(CATALOG.read_text())["models"]]
    except Exception:
        return []


def remote_alive():
    import socket
    try:
        socket.create_connection(("127.0.0.1", REMOTE_PORT), 0.3).close()
        return True
    except OSError:
        return False


def remote_call(method, path, body=None, timeout=30):
    """Habla con el agente remoto (loopback + token del hub); si no está en marcha, lo arranca."""
    import shutil
    if not remote_alive():
        node, agent = shutil.which("node"), ROOT / "remote/agent.cjs"
        if not node or not agent.exists():
            raise RuntimeError("El control remoto necesita node 18+ y la carpeta remote/ de la instalación.")
        subprocess.Popen([node, str(agent)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                         start_new_session=True, env={**os.environ, "CHATGPT2_HOME": str(ROOT), "CODEX_HOME": str(CODEX_HOME)})
        for _ in range(40):
            if remote_alive():
                break
            time.sleep(0.25)
    req = urllib.request.Request(f"http://127.0.0.1:{REMOTE_PORT}{path}", method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-Hub-Token": read_token(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error")
        except Exception:
            msg = None
        raise RuntimeError(msg or f"El agente remoto respondió {e.code}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"El agente remoto no responde ({e.reason})")


def go_status(st):
    k = go_key(st)
    ents = go_entries(st) if k else []
    g = st.get("opencode_go") or {}
    return {"configured": bool(k), "key_hint": ("…" + k[-4:]) if len(k) > 8 else "", "updated": g.get("updated", 0), "last_diff": g.get("last_diff") or {},
            "models": [{"name": e["name"], "alias": e["alias"], "display": e["display"], "proto": e["proto"]} for e in ents]}


def mask(p):
    q = dict(p)
    k = q.pop("api_key", "") or ""
    q["has_key"] = bool(k)
    q["key_hint"] = ("…" + k[-4:]) if len(k) > 8 else ""
    return q


class H(BaseHTTPRequestHandler):
    token = read_token()

    def log_message(self, *a):
        pass

    def _origin_ok(self):
        o = self.headers.get("Origin", "")
        return o in ("", "app://-") or o.startswith("app://")

    def _send(self, code, obj=None):
        body = json.dumps(obj if obj is not None else {}).encode()
        self.send_response(code)
        o = self.headers.get("Origin")
        if o and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        o = self.headers.get("Origin")
        if o and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Access-Control-Allow-Headers", "content-type, x-hub-token")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _guard(self):
        if not self._origin_ok() or self.headers.get("X-Hub-Token") != self.token:
            self._send(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        if not self._guard():
            return
        try:
            if self.path == "/state":
                st = load_state()
                try:
                    models = [m["id"] for m in cpa_models()]
                except Exception:
                    models = []
                self._send(200, {"providers": [mask(p) for p in st["providers"]], "accounts": accounts(), "models": models,
                                 "auto": (st.get("auto") or {}).get("models", []), "auto_last": auto_last,
                                 "opencode_go": go_status(st), "credentials": credentials(), "routing": strategy(st),
                                 "catalog": catalog_names(), "default_model": (st.get("default_model") or {}).get("slug", "")})
            elif self.path in ("/remote/status", "/remote/devices"):
                self._send(200, remote_call("GET", self.path[len("/remote"):]))
            elif self.path.startswith("/login/"):
                self._send(200, login_status(self.path.split("/")[2]))
            else:
                self._send(404)
        except Exception as e:
            self._send(500, {"error": str(e)})

    def do_PUT(self):
        if not self._guard():
            return
        try:
            if self.path == "/providers":
                incoming = self._body().get("providers", [])
                old = {p["name"]: p for p in load_state()["providers"]}
                clean = []
                for p in incoming:
                    name = str(p.get("name", "")).strip()
                    base = str(p.get("base_url", "")).strip().rstrip("/")
                    if not name or not base.startswith(("http://", "https://")):
                        raise ValueError(f"proveedor inválido: {name or '(sin nombre)'}")
                    key = p.get("api_key") or old.get(p.get("orig_name") or name, {}).get("api_key", "")
                    models = []
                    for m in p.get("models", []):
                        n = str(m.get("name", "")).strip()
                        if n:
                            models.append({"name": n, "alias": (m.get("alias") or "").strip() or n,
                                           "display": (m.get("display") or "").strip(),
                                           "context": int(m.get("context") or 0) or None, "image": bool(m.get("image"))})
                    clean.append({"name": name, "base_url": base, "api_key": key, "models": models, "disabled": bool(p.get("disabled"))})
                save_state({**load_state(), "providers": clean})
                self._send(200, {"ok": True})
            elif self.path == "/default-model":
                slug = str(self._body().get("slug", "")).strip()
                if slug not in {m["slug"] for m in catalog_names()}:
                    raise ValueError("ese modelo no está en el catálogo (aplica los cambios primero)")
                save_state({**load_state(), "default_model": {"slug": slug, "pending": True}})
                self._send(200, {"ok": True})
            elif self.path == "/routing":
                s_ = str(self._body().get("strategy", ""))
                if s_ not in STRATEGIES:
                    raise ValueError("estrategia desconocida")
                save_state({**load_state(), "routing": {"strategy": s_}})
                self._send(200, {"ok": True})
            elif self.path == "/opencode-go":
                key = str(self._body().get("api_key", "")).strip()
                if not key:
                    raise ValueError("falta la clave API de OpenCode Go")
                if len(key) > 300 or any(c.isspace() for c in key):
                    raise ValueError("la clave no parece válida")
                save_state({**load_state(), "opencode_go": {"api_key": key}})
                self._send(200, {"ok": True})
            elif self.path == "/auto":
                models = [str(m) for m in self._body().get("models", []) if str(m).strip() and str(m) != "auto"]
                seen = []
                for m in models:
                    if m not in seen:
                        seen.append(m)
                cooldown.clear()
                save_state({**load_state(), "auto": {"models": seen}})
                self._send(200, {"ok": True})
            else:
                self._send(404)
        except Exception as e:
            self._send(400, {"error": str(e)})

    def do_POST(self):
        if not self._guard():
            return
        try:
            if self.path == "/apply":
                n = apply_all()
                self._send(200, {"ok": True, "models": n})
            elif self.path in ("/remote/start", "/remote/stop", "/remote/rotate", "/remote/revoke-device", "/remote/settings"):
                self._send(200, remote_call("POST", self.path[len("/remote"):], self._body()))
            elif self.path == "/opencode-go/refresh":
                r = go_refresh()
                if r is None:
                    raise ValueError("OpenCode Go no está conectado")
                self._send(200, r)
            elif self.path == "/account-status":
                b = self._body()
                set_account_disabled(str(b.get("name", "")), bool(b.get("disabled")))
                self._send(200, {"ok": True})
            elif self.path == "/restart":
                restart_clone()
                self._send(200, {"ok": True})
            elif self.path.startswith("/login/"):
                start_login(self.path.split("/")[2])
                self._send(200, {"ok": True})
            else:
                self._send(404)
        except Exception as e:
            self._send(500, {"error": str(e)})

    def do_DELETE(self):
        if not self._guard():
            return
        try:
            if self.path == "/opencode-go":
                st = load_state()
                st.pop("opencode_go", None)
                save_state(st)
                _go_cache.update({"at": 0, "ents": []})
                self._send(200, {"ok": True})
            elif self.path.startswith("/account/"):
                f = AUTH_DIR / os.path.basename(self.path[len("/account/"):])
                if f.suffix == ".json" and f.exists():
                    f.unlink()
                self._send(200, {"ok": True})
            else:
                self._send(404)
        except Exception as e:
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    CODEX_HOME.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    if len(sys.argv) > 1 and sys.argv[1] == "apply":
        print("modelos:", apply_all())
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == "init":  # instalación: clave local + config del proxy + token
        read_token()
        cpa_key()
        write_cpa_config(load_state())
        print("hub inicializado")
        sys.exit(0)
    start_router()
    threading.Thread(target=go_daily, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
