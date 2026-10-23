"""OpenCode Go (https://opencode.ai/docs/go/) como fuente de modelos del hub.

OpenCode Go es una suscripción con una sola clave API que da acceso a muchos modelos abiertos y de pago. Cada modelo
se sirve por uno de cuatro protocolos, y CLIProxyAPI tiene un tipo de proveedor para cada uno:

    chat       /openai/v1/chat/completions   -> openai-compatibility
    responses  /openai/v1/responses          -> api-keys.codex
    anthropic  /anthropic/v1/messages        -> api-keys.claude
    google     /google/v1beta/models/<id>    -> api-keys.gemini

La lista de modelos es pública (GET {BASE}/v1/models): se consulta al aplicar para exponer TODOS los que haya en ese momento.
"""
import json
import os
import urllib.request

BASE = (os.environ.get("OPENCODE_GO_BASE") or "https://opencode.ai/inference/go").rstrip("/")
PREFIX = "go-"  # los alias llevan este prefijo para no chocar con otros proveedores (p. ej. beam-free de OpenCode Free)
PROVIDER = "OpenCode Go"
# OpenCode Go exige un id de sesión estable por conversación (x-opencode-session) y un User-Agent propio. El enrutador local
# lo calcula a partir de la cabecera session_id de Codex y CLIProxyAPI lo copia a la petición saliente ("$cabecera").
HEADERS = {"x-opencode-session": "$x-opencode-session", "User-Agent": "chatgpt2-linux/1.0"}

# Protocolo de cada modelo según la documentación de OpenCode Go; el resto se deduce por familia (ver protocol()).
EXACT = {
    "grok-4.7": "responses", "gpt-6-luna": "responses", "gpt-5.6-luna": "responses",
    "muse-spark-1.3-contributor": "responses", "muse-spark-1.2-contributor": "responses",
    "claude-haiku-5-5": "anthropic", "minimax-m3": "anthropic",
    "qwen3.8-max": "anthropic", "qwen3.8-flash": "anthropic", "qwen3.7-plus": "anthropic",
    "gemini-4-argon-contributor": "google",
}
# Lista de respaldo por si no hay conexión al aplicar (los que documenta OpenCode Go).
FALLBACK = [
    "grok-4.7", "gpt-6-luna", "gpt-5.6-luna", "claude-haiku-5-5", "gemini-4-argon-contributor", "glm-5.3-flash", "glm-5.3",
    "glm-5.2", "kimi-k3", "kimi-k2.7-code", "longcat-2.0", "deepseek-v4.1-flash", "deepseek-v4-pro", "mimo-v2.6-flash",
    "mimo-v2.6-pro", "mimo-v2.5", "mimo-v2.5-pro", "minimax-m3.1-flash", "minimax-m3", "muse-spark-1.3-contributor",
    "muse-spark-1.2-contributor", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "hy4-preview", "hy3",
    "longcat-2.5-preview-free", "step-5-preview", "beam-free",
]


def protocol(mid):
    if mid in EXACT:
        return EXACT[mid]
    if mid.startswith(("gpt-", "grok-", "muse-")):
        return "responses"
    if mid.startswith(("claude-", "qwen", "minimax-m2")):  # minimax-m2.x: lo confirmó una prueba real («protocolo no soportado» por chat)
        return "anthropic"
    if mid.startswith("gemini-"):
        return "google"
    return "chat"


def meta(mid):
    """(contexto, acepta imágenes). Aproximaciones por familia: OpenCode Go no publica estos datos en su lista."""
    if mid.startswith("gemini-"):
        return 1000000, True
    if mid.startswith("claude-"):
        return 200000, True
    if mid.startswith(("gpt-", "grok-", "muse-")):
        return 400000, True
    if mid.startswith(("kimi-k3", "qwen")):
        return 262144, mid.startswith("kimi-k3")
    if mid.startswith(("deepseek", "longcat", "minimax", "mimo")):
        return 1000000, False
    return 200000, False


NAMES = {  # nombres tal cual los publica la documentación de OpenCode Go
    "grok-4.7": "Grok 4.7", "gpt-6-luna": "GPT 6 Luna", "gpt-5.6-luna": "GPT 5.6 Luna", "claude-haiku-5-5": "Claude Haiku 5.5",
    "gemini-4-argon-contributor": "Gemini 4 Argon Contributor", "glm-5.3-flash": "GLM-5.3-Flash", "glm-5.3": "GLM-5.3",
    "glm-5.2": "GLM-5.2", "kimi-k3": "Kimi K3", "kimi-k2.7-code": "Kimi K2.7 Code", "longcat-2.0": "LongCat-2.0",
    "deepseek-v4.1-flash": "DeepSeek V4.1 Flash", "deepseek-v4-pro": "DeepSeek V4 Pro", "mimo-v2.6-flash": "MiMo-V2.6-Flash",
    "mimo-v2.6-pro": "MiMo-V2.6-Pro", "mimo-v2.5": "MiMo-V2.5", "mimo-v2.5-pro": "MiMo-V2.5-Pro",
    "minimax-m3.1-flash": "MiniMax M3.1 Flash", "minimax-m3": "MiniMax M3", "muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor",
    "muse-spark-1.2-contributor": "Muse Spark 1.2 Contributor", "qwen3.8-max": "Qwen3.8 Max", "qwen3.8-flash": "Qwen3.8 Flash",
    "qwen3.7-plus": "Qwen3.7 Plus", "hy4-preview": "Hy4 preview", "hy3": "Hy3", "longcat-2.5-preview-free": "LongCat 2.5 Preview Free",
    "step-5-preview": "Step 5 Preview", "beam-free": "Beam Free",
}
WORDS = {"gpt": "GPT", "glm": "GLM", "minimax": "MiniMax", "mimo": "MiMo", "deepseek": "DeepSeek", "longcat": "LongCat", "ai": "AI"}


def pretty(mid):
    if mid in NAMES:
        return NAMES[mid]
    return " ".join(WORDS.get(w.lower(), w[:1].upper() + w[1:]) for w in mid.replace("-", " ").split())


def fetch_ids(timeout=10, cache=None, strict=False):
    """Lista pública de modelos. Si falla, la última lista buena guardada en disco; y si no hay, la documentada."""
    last = None
    for _ in range(2):
        try:
            with urllib.request.urlopen(urllib.request.Request(BASE + "/v1/models", headers={"User-Agent": "chatgpt2-modelhub"}), timeout=timeout) as r:
                ids = [m["id"] for m in json.load(r).get("data", []) if m.get("id")]
            if ids:
                if cache:
                    try:
                        cache.write_text(json.dumps(ids))
                    except OSError:
                        pass
                return ids
        except Exception as e:
            last = e
    if strict:  # el botón y la actualización diaria necesitan saber si realmente se pudo consultar
        raise last or RuntimeError("lista vacía")
    if cache:
        try:
            ids = json.loads(cache.read_text())
            if ids:
                return ids
        except Exception:
            pass
    return list(FALLBACK)


def entries(ids=None, cache=None):
    out = []
    for mid in ids or fetch_ids(cache=cache):
        ctx, image = meta(mid)
        out.append({"name": mid, "alias": PREFIX + mid, "display": pretty(mid), "context": ctx, "image": image,
                    "proto": protocol(mid), "gpt": mid.startswith("gpt-")})
    return out


def _q(v):
    return json.dumps(v, ensure_ascii=False)


def chat_provider(api_key, ents):
    """Proveedor openai-compatibility (mismo formato que usa el hub para los proveedores con API)."""
    models = [e for e in ents if e["proto"] == "chat"]
    if not (api_key and models):
        return None
    return {"name": PROVIDER, "base_url": BASE + "/openai/v1", "api_key": api_key, "headers": HEADERS,
            "models": [{"name": e["name"], "alias": e["alias"], "display": e["display"], "context": e["context"], "image": e["image"]} for e in models]}


def cpa_groups(api_key, ents):
    """Bloque `api-keys:` de CLIProxyAPI v8 con los grupos codex / claude / gemini (modelos que no son chat)."""
    spec = [("responses", "codex", "/openai/v1"), ("anthropic", "claude", "/anthropic"), ("google", "gemini", "/google")]
    lines = []
    for proto, ptype, path in spec:
        models = [e for e in ents if e["proto"] == proto]
        if not models:
            continue
        lines += [f"  {ptype}:", f"    - name: {_q('opencode-go-' + proto)}", f"      base-url: {_q(BASE + path)}", "      headers:"]
        lines += [f"        {_q(k)}: {_q(v)}" for k, v in HEADERS.items()]
        lines += ["      keys:", f"        - api-key: {_q(api_key)}"]
        if ptype == "codex":
            lines.append("          disable-codex-cloaking: true")  # que se vea nuestro User-Agent, no uno de Codex inventado
        lines.append("      models:")
        for e in models:
            lines += [f"        - name: {_q(e['name'])}", f"          alias: {_q(e['alias'])}", f"          display-name: {_q(e['display'])}",
                      f"          max-context-length: {int(e['context'])}"]
    return (["api-keys:"] + lines) if lines else []
