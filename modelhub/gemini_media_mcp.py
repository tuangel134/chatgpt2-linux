#!/usr/bin/env python3
"""Servidor MCP (stdio) que da a cualquier modelo del clon generación/edición de imágenes con Gemini.

Herramientas:
  generate_image  - texto -> imagen (opcionalmente con imágenes de referencia para editar/combinar)
  list_image_models - modelos de imagen disponibles en el hub

Usa el proxy local (CLIProxyAPI, 127.0.0.1:8317) con las cuentas de Antigravity ya conectadas.
Sin dependencias externas.
"""
import base64
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path.home()
ROOT = Path(os.environ.get("CHATGPT2_HOME") or Path(__file__).resolve().parent.parent)
CODEX_HOME = Path(os.environ.get("CODEX_HOME") or HOME / ".codex-2")
CPA_CFG = Path(os.environ.get("CPA_DIR") or ROOT / "cliproxyapi") / "config.yaml"
CPA_URL = "http://127.0.0.1:8317"
OUT_DIR = CODEX_HOME / "generated_images/gemini"
DEFAULT_MODEL = "gemini-3.1-flash-image"
ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"]
MAGIC = {b"\x89PNG": ("png", "image/png"), b"\xff\xd8\xff": ("jpg", "image/jpeg"), b"RIFF": ("webp", "image/webp"), b"GIF8": ("gif", "image/gif")}


def key():
    m = re.search(r'"(sk-local-[a-f0-9]+)"', CPA_CFG.read_text())
    if not m:
        raise RuntimeError("No encuentro la clave local del proxy (config.yaml).")
    return m.group(1)


def http(method, path, body=None, timeout=240):
    req = urllib.request.Request(
        CPA_URL + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="ignore")
        raise RuntimeError(friendly_error(e.code, raw))
    except urllib.error.URLError as e:
        raise RuntimeError(f"El hub local no responde ({e.reason}). Revisa `systemctl --user status cliproxyapi`.")


def friendly_error(code, raw):
    if code == 429 or "RESOURCE_EXHAUSTED" in raw or "model_cooldown" in raw or "exhausted" in raw.lower():
        m = re.search(r"reset after ([0-9hms. ]+?)[\".]", raw) or re.search(r'"reset_time":\s*"([^"]+)"', raw)
        when = f" Se restablece en {m.group(1).strip()}." if m else ""
        return "Cuota agotada para este modelo de imagen en la cuenta de Antigravity." + when + " Prueba más tarde o conecta otra cuenta en Ajustes → Modelos personalizados."
    if code in (401, 403):
        return "El hub rechazó la petición (sesión de Antigravity caducada). Vuelve a iniciar sesión en Ajustes → Modelos personalizados."
    if code == 400 and "not supported" in raw:
        return "Ese modelo no admite generación de imágenes por este camino: " + raw[:200]
    return f"Error {code} del hub: {raw[:300]}"


def sniff(b):
    for sig, v in MAGIC.items():
        if b.startswith(sig):
            return v
    return None


def b64_candidates(obj, out):
    """Recorre cualquier JSON y junta imágenes en base64 (data URI, inlineData, image_generation_call...)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and k in ("b64_json", "result", "data", "image_base64", "bytesBase64Encoded") and len(v) > 200:
                out.append(v)
            else:
                b64_candidates(v, out)
    elif isinstance(obj, list):
        for v in obj:
            b64_candidates(v, out)
    elif isinstance(obj, str):
        for m in re.finditer(r"data:image/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=_-]{200,})", obj):
            out.append(m.group(1))
    return out


def extract_images(resp):
    imgs, seen = [], set()
    for c in b64_candidates(resp, []):
        try:
            raw = base64.b64decode(c + "=" * (-len(c) % 4), altchars=b"-_" if ("-" in c or "_" in c) else None)
        except Exception:
            continue
        kind = sniff(raw)
        if kind and raw[:64] not in seen:
            seen.add(raw[:64])
            imgs.append((raw, kind))
    return imgs


def extract_text(resp):
    try:
        c = resp["choices"][0]["message"].get("content")
        if isinstance(c, str):
            return re.sub(r"!\[[^\]]*\]\(data:image[^)]*\)", "", c).strip()
        if isinstance(c, list):
            return " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text").strip()
    except Exception:
        pass
    return ""


def ref_part(path):
    p = Path(path).expanduser()
    if not p.is_file():
        raise RuntimeError(f"La imagen de referencia no existe: {p}")
    mime = mimetypes.guess_type(p.name)[0] or "image/png"
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()}}


def generate_image(args):
    prompt = (args.get("prompt") or "").strip()
    if not prompt:
        raise RuntimeError("Falta `prompt`.")
    model = args.get("model") or DEFAULT_MODEL
    aspect = args.get("aspect_ratio")
    n = max(1, min(int(args.get("count") or 1), 4))
    text = prompt
    if aspect:
        if aspect not in ASPECTS:
            raise RuntimeError(f"aspect_ratio inválido. Usa uno de: {', '.join(ASPECTS)}")
        text += f"\n\nRelación de aspecto de la imagen: {aspect}."
    parts = [{"type": "text", "text": text}] + [ref_part(r) for r in (args.get("reference_images") or [])]
    saved, notes = [], []
    for i in range(n):
        resp = http("POST", "/v1/chat/completions", {
            "model": model, "modalities": ["image", "text"], "stream": False,
            "messages": [{"role": "user", "content": parts if len(parts) > 1 else text}]})
        imgs = extract_images(resp)
        if not imgs:
            t = extract_text(resp)
            raise RuntimeError("El modelo no devolvió ninguna imagen." + (f" Respondió: {t[:300]}" if t else ""))
        notes.append(extract_text(resp))
        for raw, (ext, mime) in imgs:
            out = args.get("output_path")
            if out:
                dest = Path(out).expanduser()
                if dest.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
                    dest = dest / f"gemini-{int(time.time())}-{i}.{ext}"
                elif n > 1 or len(imgs) > 1:
                    dest = dest.with_name(f"{dest.stem}-{len(saved) + 1}{dest.suffix}")
            else:
                dest = OUT_DIR / f"gemini-{time.strftime('%Y%m%d-%H%M%S')}-{len(saved) + 1}.{ext}"
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw)
            saved.append((str(dest), mime, len(raw), raw))
    fmt = lambda b: f"{b // 1024} KB" if b >= 1024 else f"{b} B"
    lines = [f"Imágenes generadas con {model}:"] + [f"- {p} ({mime}, {fmt(size)})" for p, mime, size, _ in saved]
    note = " ".join(dict.fromkeys(x for x in notes if x))
    if note:
        lines.append("Nota del modelo: " + note[:400])
    content = [{"type": "text", "text": "\n".join(lines)}]
    if args.get("return_image"):
        content += [{"type": "image", "data": base64.b64encode(raw).decode(), "mimeType": mime} for _, mime, _, raw in saved]
    return content


def list_image_models(_args):
    ids = [m["id"] for m in http("GET", "/v1/models", timeout=20).get("data", [])]
    imgs = [i for i in ids if "image" in i or "imagen" in i]
    return [{"type": "text", "text": "Modelos de imagen en el hub: " + (", ".join(imgs) or "(ninguno)") + f". Por defecto: {DEFAULT_MODEL}."}]


TOOLS = {
    "generate_image": (generate_image, {
        "description": "Genera (o edita, si das imágenes de referencia) una imagen con Gemini a partir de un texto y la guarda en disco. Devuelve la ruta del archivo.",
        "inputSchema": {"type": "object", "required": ["prompt"], "properties": {
            "prompt": {"type": "string", "description": "Descripción detallada de la imagen o de la edición."},
            "output_path": {"type": "string", "description": "Ruta del archivo (.png/.jpg/.webp) o carpeta donde guardar. Por defecto ~/.codex-2/generated_images/gemini/."},
            "aspect_ratio": {"type": "string", "enum": ASPECTS, "description": "Relación de aspecto deseada."},
            "reference_images": {"type": "array", "items": {"type": "string"}, "description": "Rutas de imágenes locales para editar o usar como referencia de estilo/personaje."},
            "count": {"type": "integer", "minimum": 1, "maximum": 4, "description": "Cuántas variantes generar (por defecto 1)."},
            "model": {"type": "string", "description": f"Modelo de imagen (por defecto {DEFAULT_MODEL})."},
            "return_image": {"type": "boolean", "description": "Adjuntar la imagen en la respuesta (solo si el modelo que llama admite imágenes). Por defecto false."}}}}),
    "list_image_models": (list_image_models, {
        "description": "Lista los modelos de generación de imágenes disponibles en el hub local.",
        "inputSchema": {"type": "object", "properties": {}}}),
}


def reply(i, result=None, error=None):
    m = {"jsonrpc": "2.0", "id": i}
    if error is not None:
        m["error"] = error
    else:
        m["result"] = result
    sys.stdout.write(json.dumps(m, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def serve():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid, method = msg.get("id"), msg.get("method")
        if method == "initialize":
            ver = (msg.get("params") or {}).get("protocolVersion") or "2025-03-26"
            reply(mid, {"protocolVersion": ver, "capabilities": {"tools": {}}, "serverInfo": {"name": "gemini-media", "version": "1.0.0"}})
        elif method == "ping":
            reply(mid, {})
        elif method == "tools/list":
            reply(mid, {"tools": [{"name": n, **spec} for n, (_, spec) in TOOLS.items()]})
        elif method == "tools/call":
            p = msg.get("params") or {}
            fn = TOOLS.get(p.get("name"))
            if not fn:
                reply(mid, error={"code": -32602, "message": "herramienta desconocida"})
                continue
            try:
                reply(mid, {"content": fn[0](p.get("arguments") or {})})
            except Exception as e:  # el error útil va al modelo, no se rompe el servidor
                reply(mid, {"isError": True, "content": [{"type": "text", "text": str(e)}]})
        elif mid is not None:
            reply(mid, error={"code": -32601, "message": "método no soportado"})


if __name__ == "__main__":
    serve()
