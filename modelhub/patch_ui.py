#!/usr/bin/env python3
"""Aplica la sección «Modelos personalizados» al clon (parte siempre del app.asar original).

Pasos: extrae app.asar.orig -> parchea -> añade la página -> reempaqueta app.asar.
Es idempotente: se puede volver a ejecutar tras actualizar la app original.
"""
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("CHATGPT2_HOME") or Path.home() / ".local/opt/chatgpt2")
DATA = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex-2")
RES = ROOT / "resources"
HUB = ROOT / "modelhub"
SRC = RES / "app-src"
DATA.mkdir(parents=True, exist_ok=True)
_tok = DATA / "hub-token"
if not _tok.exists():
    _tok.write_text(secrets.token_hex(24))
    _tok.chmod(0o600)
TOKEN = _tok.read_text().strip()

sys.path.insert(0, str(HUB))
import asar_tools  # noqa: E402


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"parche '{label}': se esperaba 1 coincidencia y hay {n}")
    return text.replace(old, new)


def replace_work_logo(text):
    """El título del selector de modos es un SVG con el texto «ChatGPT Work» dibujado: se sustituye por texto real."""
    key = "w6o=e=>(0,C6o.jsx)(`svg`,"
    if text.count(key) != 1:
        raise SystemExit(f"parche 'work-logo': se esperaba 1 coincidencia y hay {text.count(key)}")
    start = text.index(key) + len("w6o=e=>")
    j, in_tpl = start, False
    for _ in range(2):  # grupo del callee «(0,C6o.jsx)» y grupo de argumentos «(`svg`,{...})»
        depth = 0
        while True:
            c = text[j]
            if c == "`":
                in_tpl = not in_tpl
            elif not in_tpl:
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
            j += 1
    return text[:start] + "(0,C6o.jsx)(`span`,{className:`font-semibold`,style:{whiteSpace:`nowrap`},children:`ChatGPT Web`})" + text[j:]


def main():
    orig = RES / "app.asar.orig"
    if SRC.exists():
        shutil.rmtree(SRC)
    asar_tools.extract(str(orig), str(SRC))
    # lo desempaquetado vive aparte (app.asar.unpacked), no hace falta en SRC
    A = SRC / "webview/assets"

    init = next(A.glob("app-initial-*.js"))
    s = init.read_text()
    s = sub(s, ".mcp-settings.hooks-settings.connections", ".mcp-settings.custom-models.master-mcp.hooks-settings.connections", "slug-string")
    s = sub(s, "{slug:`mcp-settings`},{slug:`hooks-settings`}", "{slug:`mcp-settings`},{slug:`custom-models`},{slug:`master-mcp`},{slug:`hooks-settings`}", "slug-list")
    s = sub(s, '"hooks-settings":KR(async()=>(await G(',
            '"custom-models":KR(async()=>(await import(`./custom-models-settings.js`)).CustomModelsSettings),"master-mcp":KR(async()=>(await import(`./master-mcp-settings.js`)).MasterMcpSettings),"hooks-settings":KR(async()=>(await G(', "route-map")
    s = sub(s, '"hooks-settings":{id:`settings.nav.hooks-settings`,',
            '"custom-models":{id:`settings.nav.custom-models`,defaultMessage:`Modelos personalizados`,description:`Title for custom models settings section`},"master-mcp":{id:`settings.nav.master-mcp`,defaultMessage:`Master MCP`,description:`Master MCP settings section`},"hooks-settings":{id:`settings.nav.hooks-settings`,', "nav-title")
    s = sub(s, "case`hooks-settings`:{let e;return t[49]===",
            "case`custom-models`:return(0,$6.jsx)(Q,{id:`settings.section.custom-models`,defaultMessage:`Modelos personalizados`,description:`Title for custom models settings section`});case`master-mcp`:return(0,$6.jsx)(Q,{id:`settings.section.master-mcp`,defaultMessage:`Master MCP`,description:`Master MCP settings section`});case`hooks-settings`:{let e;return t[49]===", "page-title")
    # Pestaña «ChatGPT Web»: reemplaza el modo «ChatGPT Work» (nombre, descripción y vista de chatgpt.com en el área de contenido).
    s = sub(s, "id:`sidebarElectron.productMode.chatGptWork.unavailable`,defaultMessage:`ChatGPT Work`", "id:`sidebarElectron.productMode.chatGptWork.unavailable`,defaultMessage:`ChatGPT Web`", "work-label")
    s = sub(s, "defaultMessage:`Create, learn, and explore`,description:`Description beneath the ChatGPT Work option in the sidebar mode selector`", "defaultMessage:`Your chatgpt.com session, inside the app`,description:`Description beneath the ChatGPT Work option in the sidebar mode selector`", "work-desc")
    s = replace_work_logo(s)
    cgw_dir = DATA / "chatgptweb"
    cgw_dir.mkdir(parents=True, exist_ok=True)
    cgw_token_file = cgw_dir / "token"
    if not cgw_token_file.exists():
        cgw_token_file.write_text(secrets.token_hex(24)); cgw_token_file.chmod(0o600)
    s = s.rstrip("\n") + "\n" + (HUB / "chatgpt_web_overlay.js").read_text().replace("__CGW_TOKEN__", cgw_token_file.read_text().strip())
    init.write_text(s)
    es = next(f for f in A.glob("es-ES-*.js") if "sidebarElectron.productMode.chatGptWork.unavailable" in f.read_text())
    e = es.read_text()
    e = sub(e, '"sidebarElectron.productMode.chatGptWork.unavailable":`ChatGPT Work`', '"sidebarElectron.productMode.chatGptWork.unavailable":`ChatGPT Web`', "work-label-es")
    e = sub(e, '"sidebarElectron.productMode.work.description.recommended":`Crea, aprende y explora`', '"sidebarElectron.productMode.work.description.recommended":`Tu sesión de chatgpt.com, dentro de la app`', "work-desc-es")
    es.write_text(e)

    vis = next(A.glob("use-visible-settings-sections-*.js"))
    v = vis.read_text()
    hk = '"hooks-settings":{component:si,commandAsset:fe,navigation:{assets:{16:fe,20:Je},ariaHidden:!1}},'
    v = sub(v, hk, hk.replace('"hooks-settings"', '"custom-models"') + hk.replace('"hooks-settings"', '"master-mcp"') + hk, "section-meta")
    v = sub(v, "case`hooks-settings`:case`mcp-settings`:return{visible:!0,pending:!1};", "case`custom-models`:case`master-mcp`:case`hooks-settings`:case`mcp-settings`:return{visible:!0,pending:!1};", "visibility")
    v = sub(v, "Ta=[`profile`,`agent`,`personalization`,`mcp-settings`,", "Ta=[`profile`,`agent`,`personalization`,`mcp-settings`,`custom-models`,`master-mcp`,", "always-allowed")
    vis.write_text(v)

    for name in ("index.html", "detached-window.html"):
        p = SRC / "webview" / name
        t = p.read_text()
        t = sub(t, "connect-src &#39;self&#39;", "connect-src &#39;self&#39; http://127.0.0.1:8318 http://127.0.0.1:8319 http://127.0.0.1:8322", "csp-" + name)
        p.write_text(t)

    page = (HUB / "custom-models-settings.js").read_text().replace("__HUB_TOKEN__", TOKEN)
    (A / "custom-models-settings.js").write_text(page)
    master_page = (HUB / "master-mcp-settings.js").read_text().replace("__HUB_TOKEN__", TOKEN)
    (A / "master-mcp-settings.js").write_text(master_page)

    # Proceso principal: vista de chatgpt.com dentro de la ventana (pestaña «ChatGPT Web»).
    main_js = next((SRC / ".vite/build").glob("main-*.js"))
    mj = main_js.read_text()
    if "persist:chatgpt-web" not in mj:
        main_js.write_text(mj.rstrip("\n") + "\n" + (HUB / "chatgpt_web_view.js").read_text())

    # el asar necesita el árbol "unpacked" original para saber qué ficheros van fuera
    subprocess.run([sys.executable, "-I", str(HUB / "asar_tools.py"), "pack", str(orig), str(SRC), str(RES / "app.asar")], check=True)
    # The packaged Settings modules embed a loopback control token. Never make it world-readable.
    os.chmod(RES / "app.asar", 0o600)
    shutil.rmtree(SRC)
    print("ok")


if __name__ == "__main__":
    main()
