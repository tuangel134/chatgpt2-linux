// ChatGPT 2 · Master MCP (Ajustes). Misma estructura que el panel de Tessarion:
// Estado → 1. Conexión pública → 2. Proyectos y permisos → 3. Añadir el conector a tu IA.
// Solo app://- con X-Hub-Token puede usar la API local 127.0.0.1:8319.
const BASE = "http://127.0.0.1:8319";
const TOKEN = "__HUB_TOKEN__";

const PERMS = [
  ["forja:agent", "Control de agente", "Permite usar herramientas de escritura y ejecución dentro del proyecto autorizado."],
  ["forja:browser", "Controlar navegador (Brave aparte)", "Permite abrir, leer y controlar las pestañas que compartas. No es el navegador interno de Codex."],
  ["forja:outside-workspace", "Archivos fuera del proyecto", "Permite leer y editar rutas externas al proyecto."],
  ["forja:terminal-network", "Red en terminal", "Permite que los comandos del proyecto descarguen o se conecten a servicios."],
  ["forja:protected-files", "Archivos protegidos", "Permite leer .env y credenciales del proyecto. Solo para un conector de máxima confianza."],
  ["forja:host-terminal", "Terminal del host", "Permite comandos fuera del sandbox, con tus permisos de usuario.", true],
  ["forja:devices", "Dispositivos USB / ADB", "Controla dispositivos Android por ADB. Requiere también Terminal del host.", true],
  ["forja:system-write", "Sistema (/usr, /etc, /var)", "Permite modificar archivos del sistema desde la terminal del host.", true],
  ["forja:ssh", "Claves SSH", "Permite usar ~/.ssh desde comandos autorizados.", true],
  ["forja:docker", "Docker del host", "Permite usar Docker y su socket local.", true],
  ["forja:mounts", "Unidades montadas", "Permite acceder a /mnt y /media.", true],
  ["forja:sudo", "Solicitar sudo", "Permite ejecutar sudo; Linux seguirá pidiendo tu contraseña.", true]
];
const HIGH = new Set(PERMS.filter(p => p[3]).map(p => p[0]));
const LABEL = Object.fromEntries(PERMS.map(p => [p[0], p[1]]));
LABEL["forja:read"] = "Lectura";

const t = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") Object.assign(e.style, v);
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  // El CSS global de la app deja las casillas en 0x0 (appearance:none): se fuerza su aspecto.
  if (tag === "input" && e.type === "checkbox") Object.assign(e.style, { appearance: "auto", width: "16px", height: "16px", minWidth: "16px", margin: "0", accentColor: "#2563eb", cursor: e.disabled ? "not-allowed" : "pointer" });
  for (const k of kids.flat()) if (k != null) e.append(k?.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const BORDER = "1px solid color-mix(in srgb,currentColor 22%,transparent)";
const S = {
  root: { font: "inherit", color: "inherit", maxWidth: "900px", padding: "8px 20px 56px", display: "flex", flexDirection: "column", gap: "16px" },
  section: { padding: "16px", border: BORDER, borderRadius: "12px", display: "flex", flexDirection: "column", gap: "12px" },
  card: { padding: "12px", border: BORDER, borderRadius: "10px", display: "flex", flexDirection: "column", gap: "10px", background: "color-mix(in srgb,currentColor 4%,transparent)" },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" },
  field: { display: "flex", flexDirection: "column", gap: "4px" },
  input: { background: "transparent", color: "inherit", border: "1px solid #8888", borderRadius: "8px", padding: "7px 9px", font: "inherit", minWidth: "0", boxSizing: "border-box" },
  button: { border: "1px solid #8888", borderRadius: "8px", padding: "7px 12px", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" },
  primary: { border: "1px solid #2563eb", borderRadius: "8px", padding: "7px 14px", background: "#2563eb", color: "#fff", cursor: "pointer", font: "inherit" },
  danger: { border: "1px solid #ef444488", color: "#f87171" },
  title: { fontSize: "16px", fontWeight: "650", margin: 0 },
  hint: { opacity: ".7", fontSize: "12px" },
  code: { fontFamily: "ui-monospace,monospace", fontSize: "12px", wordBreak: "break-all" },
  perm: { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }
};
const h2 = (n) => t("h2", { style: S.title }, n);
const note = (n) => t("div", { style: S.hint }, n);
const code = (n) => t("code", { style: S.code }, n);
function field(name, help, input) { return t("label", { style: S.field }, t("span", { style: { fontSize: "13px", fontWeight: "600" } }, name), help ? note(help) : null, input); }

async function api(path, payload) {
  const r = await fetch(BASE + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "X-Hub-Token": TOKEN, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
  return data;
}

/** Lista de permisos con casillas; `allowed` limita cuáles se pueden marcar. Mantiene la regla ADB ⇒ terminal del host. */
function permissionChecks(selected, allowed, { quickAll = false } = {}) {
  const set = new Set(selected), ok = new Set(allowed), boxes = {};
  const wrap = t("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } });
  const read = t("label", { style: S.perm }, t("input", { type: "checkbox", checked: true, disabled: true }), t("span", {}, "Lectura (siempre incluida)"));
  wrap.append(read);
  for (const [scope, label, help, high] of PERMS) {
    const input = t("input", { type: "checkbox", checked: set.has(scope) && ok.has(scope), disabled: !ok.has(scope), title: help });
    boxes[scope] = input;
    wrap.append(t("label", { style: { ...S.perm, opacity: ok.has(scope) ? 1 : 0.45 }, title: help }, input, t("span", {}, label + (high ? " ⚠" : "")), t("span", { style: S.hint }, ok.has(scope) ? "" : " (no habilitado en Permisos globales)")));
  }
  boxes["forja:devices"].addEventListener("change", () => { if (boxes["forja:devices"].checked && !boxes["forja:host-terminal"].disabled) boxes["forja:host-terminal"].checked = true; });
  boxes["forja:host-terminal"].addEventListener("change", () => { if (!boxes["forja:host-terminal"].checked) boxes["forja:devices"].checked = false; });
  return { node: wrap, values: () => ["forja:read", ...PERMS.map(p => p[0]).filter(s => boxes[s].checked && !boxes[s].disabled && (s !== "forja:devices" || boxes["forja:host-terminal"].checked))] };
}

function mount(root) {
  if (!root) return;
  let state = null, closed = false, timer = 0;
  const main = t("div", { style: S.root });
  // Aviso siempre visible: pegado al borde inferior de la zona que se desplaza, aunque estés al final de la página.
  const msg = t("div", { role: "alert", style: { position: "sticky", bottom: "12px", alignSelf: "flex-end", zIndex: "50", maxWidth: "480px", padding: "12px 16px", borderRadius: "10px", border: "1px solid", background: "#1c1c1f", color: "#f4f4f5", boxShadow: "0 8px 28px rgba(0,0,0,.45)", fontSize: "13px", display: "none" } });
  root.replaceChildren(main);
  let msgTimer = 0;
  const say = (text, bad = false) => {
    clearTimeout(msgTimer);
    msg.textContent = (bad ? "⚠ " : "✓ ") + text;
    msg.style.borderColor = bad ? "#ef4444" : "#22c55e";
    msg.style.display = "block";
    msgTimer = setTimeout(() => { msg.style.display = "none"; }, bad ? 15000 : 5000);
  };
  const fail = (e) => say("Error: " + (e?.message || e), true);
  // Estado de los formularios que no se deben perder al refrescar en segundo plano.
  const form = { mode: null, domain: "", token: "" };
  const run = (fn, okText) => async () => { try { const r = await fn(); if (okText && r !== false) say(okText); if (!closed) await refresh(); } catch (e) { fail(e); } };
  const button = (name, fn, style = S.button, okText, disabled = false) => t("button", { style: disabled ? { ...style, opacity: ".45", cursor: "not-allowed" } : style, disabled, onClick: run(fn, okText) }, name);
  const armed = new Map();
  // Confirmación dentro de la pantalla: el primer clic avisa; el mismo botón, pulsado otra vez en 15 s, confirma.
  const confirmTwice = (key, message) => {
    if ((armed.get(key) || 0) > Date.now()) { armed.delete(key); return true; }
    armed.set(key, Date.now() + 15000);
    say(message + " Pulsa el mismo botón otra vez (en 15 segundos) para confirmar.", true);
    return false;
  };
  const copy = async (value) => { try { await navigator.clipboard.writeText(value); say("URL copiada al portapapeles."); } catch { fail(new Error("No se pudo copiar; selecciónala manualmente.")); } };

  async function refresh() {
    const next = await api("/state");
    if (closed) return;
    const signature = JSON.stringify([next.control, next.masterMcp, next.tunnel, next.workspaces, next.permissions, next.pendingAuthorizations, next.authorizations, next.browserPages]);
    if (state && state.__sig === signature) return;
    state = { ...next, __sig: signature };
    render();
  }

  function render() {
    const { control, masterMcp, tunnel, workspaces, permissions, pendingAuthorizations, authorizations, browserPages } = state;
    const endpoint = masterMcp.publicUrl ? masterMcp.publicUrl + "/mcp" : "";

    // ---- Estado de la conexión
    const status = t("section", { style: S.section }, h2("Estado de la conexión"),
      note("Aquí ves y copias la dirección que usarás en tu proveedor de IA. Funciona sin Tessarion."),
      t("div", { style: S.row }, t("b", {}, masterMcp.running ? (masterMcp.publicUrl ? "● Conector público activo" : "● Gateway local activo") : "○ Detenido")),
      t("div", { style: S.field }, t("span", { style: S.hint }, "Gateway local"), code(masterMcp.localUrl || "Aún no iniciado")),
      t("div", { style: S.field }, t("span", { style: S.hint }, "URL para el conector"), code(endpoint || "Inicia la conexión con ngrok para obtenerla.")));
    const actions = t("div", { style: S.row });
    if (endpoint) actions.append(button("Copiar URL del conector", () => copy(endpoint)));
    actions.append(button("Actualizar estado", async () => { state = null; }, S.button, "Estado actualizado."));
    actions.append(button("Probar conexión", async () => {
      const r = await api("/test");
      const text = [r.local?.detail, r.remote?.detail].filter(Boolean).join("  ·  ");
      say(text, !(r.local?.ok && (!r.remote || r.remote.ok)));
    }));
    status.append(actions);

    // ---- 1. Conexión pública
    const mode = t("select", { style: S.input },
      t("option", { value: "local", selected: control.mode === "local" }, "Solo local (sin internet)"),
      t("option", { value: "ngrok", selected: control.mode === "ngrok" }, "Automático con ngrok (ChatGPT web)"));
    if (form.mode) mode.value = form.mode;
    const domain = t("input", { style: { ...S.input, width: "100%" }, value: form.domain || control.domain || "", placeholder: "tu-dominio.ngrok-free.dev (opcional)", spellcheck: false });
    const secret = t("input", { style: { ...S.input, width: "100%" }, type: "password", autocomplete: "off", value: form.token, placeholder: tunnel.configured ? "••••••••  credencial guardada" : "Tu authtoken de ngrok" });
    const sync = () => { const local = mode.value === "local"; domain.disabled = local; secret.disabled = local; form.mode = mode.value; form.domain = domain.value; form.token = secret.value; };
    mode.addEventListener("change", sync); domain.addEventListener("input", sync); secret.addEventListener("input", sync);
    sync();
    const startStop = masterMcp.running
      ? button("Detener Master MCP", async () => { await api("/settings", { enabled: false, mode: control.mode, domain: control.domain || "" }); }, S.button, "Master MCP detenido.")
      : button("Guardar e iniciar", async () => {
        const data = { enabled: true, mode: mode.value, domain: domain.value.trim() };
        if (secret.value) data.ngrokToken = secret.value;
        await api("/settings", data); form.token = ""; form.mode = null;
      }, S.primary, "Master MCP iniciado. Copia la URL del conector y añádela a tu IA.");
    const connection = t("section", { style: S.section }, h2("1. Conexión pública"),
      note("Elige cómo publicar el gateway. Esta aplicación no cobra por esto; ngrok puede tener sus propios límites."),
      field("Método de conexión", "Solo local: únicamente programas de este equipo. ngrok: crea una URL HTTPS para ChatGPT web.", mode),
      field("Dominio reservado de ngrok", "Opcional. Si tu cuenta tiene un dominio propio, escríbelo aquí.", domain),
      field("Credencial de ngrok (authtoken)", tunnel.configured ? "Ya hay una credencial guardada, cifrada en este equipo. Déjalo vacío para conservarla o escribe otra para sustituirla." : "Pégala aquí. Se guarda cifrada y nunca vuelve a mostrarse.", secret),
      t("div", { style: S.row }, startStop, masterMcp.running && control.mode !== mode.value ? note("Cambiaste el método: detén e inicia de nuevo para aplicarlo.") : null));

    // ---- 2. Proyectos (entornos) y permisos
    const access = t("section", { style: S.section }, h2("2. Proyectos y permisos"),
      note("Cada conexión pide autorización antes de ver un proyecto. No se concede acceso a todo tu equipo. La instalación de ChatGPT 2 y su configuración quedan protegidas."));

    const folders = t("div", { style: S.card }, t("b", {}, "Carpetas de trabajo (entornos)"));
    if (!workspaces.length) folders.append(note("Aún no hay carpetas. Añade al menos una para poder aprobar conectores."));
    for (const w of workspaces) folders.append(t("div", { style: S.row }, t("span", {}, w.name), code(w.root), button("Quitar", () => api("/workspace/remove", { id: w.id }), { ...S.button, ...S.danger })));
    const folder = t("input", { style: { ...S.input, flex: "1 1 320px" }, placeholder: "Ruta absoluta de la carpeta" });
    folders.append(t("div", { style: S.row }, folder,
      t("button", { style: S.button, onClick: async () => { try { const r = await api("/folder/pick", {}); folder.value = r.path; } catch (e) { fail(e); } } }, "Seleccionar carpeta…"),
      button("Añadir", async () => { await api("/workspace/add", { path: folder.value }); }, S.primary, "Carpeta añadida.")));
    access.append(folders);

    const globalChecks = permissionChecks(permissions, PERMS.map(p => p[0]));
    access.append(t("div", { style: S.card }, t("b", {}, "Permisos globales disponibles"),
      note("Son el máximo que un conector podrá recibir. Los de riesgo elevado (⚠) están apagados por defecto. Cada conector sigue necesitando tu aprobación individual."),
      globalChecks.node,
      button("Guardar permisos globales", async () => {
        const chosen = globalChecks.values().filter(s => s !== "forja:read");
        const newRisk = chosen.filter(s => HIGH.has(s) && !permissions.includes(s));
        if (newRisk.length && !confirmTwice("global:" + newRisk.join(), "Vas a habilitar permisos de riesgo elevado: " + newRisk.map(s => LABEL[s]).join(", ") + ".")) return false;
        await api("/permissions", { scopes: ["forja:read", ...chosen] });
      }, S.button, "Permisos globales guardados.")));

    access.append(t("div", { style: { ...S.card, borderColor: pendingAuthorizations.length ? "#f59e0b" : undefined } },
      t("b", {}, "Solicitudes pendientes (" + pendingAuthorizations.length + ")"),
      pendingAuthorizations.length ? note("Ninguna conexión se aprueba sola. Elige carpetas y permisos, y acepta.") : note("No hay solicitudes de autorización pendientes.")));
    for (const p of pendingAuthorizations) {
      const ck = permissionChecks(p.scopes.filter(s => permissions.includes(s)), permissions);
      const boxes = workspaces.map(w => [w.id, t("input", { type: "checkbox", checked: workspaces.length === 1 })]);
      const wsBox = t("div", { style: S.row }, ...boxes.map(([id, input], i) => t("label", { style: S.perm }, input, workspaces[i].name)));
      const resolve = async (scopes) => {
        const ids = boxes.filter(([, input]) => input.checked).map(([id]) => id);
        if (!ids.length) throw new Error("Elige al menos una carpeta para este conector.");
        const risk = scopes.filter(s => HIGH.has(s));
        if (risk.length && !confirmTwice("approve:" + p.id + ":" + scopes.join(), "Vas a dar permisos de riesgo elevado a este conector: " + risk.map(s => LABEL[s]).join(", ") + ".")) return false;
        await api("/authorization/approve", { id: p.id, workspaceIds: ids, scopes });
      };
      access.append(t("div", { style: S.card },
        t("b", {}, p.clientName || "Conector MCP"), note("Pidió: " + p.scopes.map(s => LABEL[s] || s).join(", ") + ". Tú decides qué concederle: marca más permisos si quieres que pueda hacer más (solo los habilitados en Permisos globales)."),
        t("div", { style: S.field }, t("span", { style: { fontSize: "13px", fontWeight: "600" } }, "Carpetas que podrá ver"),
          workspaces.length ? wsBox : t("div", { style: { padding: "10px 12px", borderRadius: "8px", border: "1px solid #f59e0b", color: "#fbbf24", fontSize: "13px" } },
            "No hay ninguna carpeta de trabajo, así que no se puede aprobar todavía. Añade una en «Carpetas de trabajo» (arriba en esta misma sección: escribe la ruta y pulsa «Añadir») y vuelve aquí a marcarla.")),
        ck.node,
        t("div", { style: S.row },
          button("Solo lectura", () => resolve(["forja:read"]), S.button, "Conector aprobado (solo lectura).", !workspaces.length),
          button("Aceptar conexión y dar acceso", () => resolve(ck.values()), S.primary, "Conector aprobado.", !workspaces.length),
          button("Denegar", () => api("/authorization/deny", { id: p.id }), { ...S.button, ...S.danger }, "Solicitud denegada."))));
    }

    const active = t("div", { style: S.card }, t("b", {}, "Accesos activos (" + authorizations.length + ")"),
      authorizations.length ? note("Revocar corta el acceso de inmediato; para volver a conectar habrá que pasar OAuth otra vez.") : note("Todavía no hay conectores con acceso activo."));
    for (const g of authorizations) {
      const ck = permissionChecks(g.scopes, permissions);
      const wsChecks = g.workspaceIds.map(id => [id, t("input", { type: "checkbox", checked: true })]);
      active.append(t("div", { style: { ...S.card, background: "transparent" } },
        t("b", {}, g.clientName || "Conector MCP"),
        t("span", { style: S.hint }, (g.scopes.includes("forja:agent") ? "Acceso con escritura" : "Solo lectura") + " · " + g.workspaceIds.length + " carpeta(s)"),
        t("div", { style: S.row }, ...wsChecks.map(([id, input]) => t("label", { style: S.perm }, input, workspaces.find(w => w.id === id)?.name || id))),
        ck.node,
        t("div", { style: S.row },
          button("Guardar permisos", () => api("/authorization/update", { clientId: g.clientId, scopes: ck.values(), workspaceIds: wsChecks.filter(([, i]) => i.checked).map(([id]) => id) }), S.button, "Permisos actualizados."),
          button("Revocar acceso", async () => { if (!confirmTwice("revoke:" + g.clientId, "Vas a revocar el acceso de «" + (g.clientName || "este conector") + "».")) return false; await api("/authorization/revoke", { clientId: g.clientId }); }, { ...S.button, ...S.danger }, "Acceso revocado."))));
    }
    access.append(active);

    // ---- 3. Añadir el conector a tu IA
    const provider = (name, how) => t("div", { style: S.row }, t("b", {}, name), note(endpoint ? how : "Primero inicia la conexión con ngrok."), endpoint ? button("Copiar URL", () => copy(endpoint)) : null);
    const connect = t("section", { style: S.section }, h2("3. Añadir el conector a tu IA"),
      note("Con la URL activa, crea un conector MCP personalizado en tu proveedor y pega la URL tal cual aparece arriba. Después aprueba aquí la solicitud que llegue."),
      provider("ChatGPT", "Ajustes → Conectores → crear conector MCP personalizado (OAuth)."),
      provider("Perplexity", "Conector MCP personalizado con la misma URL."));

    // ---- Navegador
    const choice = t("select", { style: S.input }, t("option", { value: "" }, "Elegir carpeta…"), ...workspaces.map(w => t("option", { value: w.id }, w.name)));
    const url = t("input", { style: { ...S.input, flex: "1 1 320px" }, placeholder: "https://example.com" });
    const browsers = t("section", { style: S.section }, h2("Navegador (Brave aparte)"),
      note("No es la pestaña interna de Codex: tiene su propio perfil y solo comparte las páginas que indiques. Se controla por MCP con el permiso de navegador."),
      t("div", { style: S.row }, choice, url, button("Abrir y compartir", () => api("/browser/open", { workspaceId: choice.value, url: url.value }), S.button, "Página abierta.")));
    for (const p of browserPages) browsers.append(t("div", { style: S.row }, t("span", {}, (p.title || "Pestaña") + " · " + p.url),
      button(p.shared ? "Dejar de compartir" : "Compartir", () => api("/browser/share", { pageId: p.id, workspaceId: p.workspaceId, shared: !p.shared }))));

    // ---- Diagnóstico
    const diag = t("section", { style: S.section }, h2("Diagnóstico y compatibilidad"),
      t("div", { style: S.row }, t("span", {}, "Autorizaciones pendientes"), code(String(masterMcp.pendingAuthorizations ?? pendingAuthorizations.length))),
      note("Paridad con Codex: archivos, git, pruebas y terminal están sujetos al sandbox y a los permisos. Las automatizaciones (codex_app) y el navegador interno original de Codex NO están conectados."));

    main.replaceChildren(t("h1", { style: { fontSize: "22px", margin: 0 } }, "Master MCP"), status, connection, access, connect, browsers, diag, msg);
  }

  refresh().catch(fail);
  timer = setInterval(() => { if (!closed && !document.hidden) refresh().catch(() => undefined); }, 3000);
  return () => { closed = true; clearInterval(timer); };
}

export function MasterMcpSettings() {
  return {
    $$typeof: Symbol.for("react.transitional.element"), type: "div", key: null, ref: null,
    props: { ref: mount, style: { overflow: "auto", height: "100%", boxSizing: "border-box" } }, _owner: null, _store: {}
  };
}
