// Sección "Modelos personalizados" de Ajustes del clon ChatGPT 2.
// Habla con el modelhub local (127.0.0.1:8318); no depende de internals de React.
const HUB = "http://127.0.0.1:8318";
const TOKEN = "__HUB_TOKEN__";

const TEMPLATES = [
  { label: "OpenRouter", name: "openrouter", base_url: "https://openrouter.ai/api/v1" },
  { label: "OpenCode Zen (con tu API key)", name: "opencode-zen", base_url: "https://opencode.ai/zen/v1" },
  { label: "DeepSeek", name: "deepseek", base_url: "https://api.deepseek.com/v1" },
  { label: "Groq", name: "groq", base_url: "https://api.groq.com/openai/v1" },
  { label: "Ollama (local)", name: "ollama", base_url: "http://127.0.0.1:11434/v1" },
  { label: "LM Studio (local)", name: "lmstudio", base_url: "http://127.0.0.1:1234/v1" },
  { label: "Otro (en blanco)", name: "", base_url: "" },
];
const LOGINS = [
  ["codex", "ChatGPT"],
  ["claude", "Claude"],
  ["antigravity", "Antigravity (Gemini)"],
];

async function api(method, path, body) {
  const r = await fetch(HUB + path, {
    method,
    headers: { "X-Hub-Token": TOKEN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}

const BORDER = "1px solid color-mix(in srgb, currentColor 20%, transparent)";
const CARD = "color-mix(in srgb, currentColor 5%, transparent)";

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "style") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  // El CSS global de la app deja las casillas en 0x0 (appearance:none): se fuerza su aspecto.
  if (tag === "input" && el.type === "checkbox") Object.assign(el.style, { appearance: "auto", width: "16px", height: "16px", minWidth: "16px", margin: "0", accentColor: "#2563eb", cursor: "pointer" });
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const S = {
  input: { background: "transparent", color: "inherit", border: BORDER, borderRadius: "8px", padding: "6px 10px", font: "inherit", fontSize: "13px", minWidth: "0", width: "100%", boxSizing: "border-box" },
  btn: { background: "transparent", color: "inherit", border: BORDER, borderRadius: "8px", padding: "6px 12px", font: "inherit", fontSize: "13px", cursor: "pointer" },
  primary: { background: "#2563eb", color: "#fff", border: "1px solid #2563eb", borderRadius: "8px", padding: "7px 14px", font: "inherit", fontSize: "13px", cursor: "pointer" },
  card: { background: CARD, border: BORDER, borderRadius: "12px", padding: "14px", display: "flex", flexDirection: "column", gap: "10px" },
  muted: { opacity: ".65", fontSize: "12px" },
  h2: { fontSize: "15px", fontWeight: "600", margin: "0" },
};

function mount(root) {
  if (!root) return;
  let state = { providers: [], accounts: [], models: [] };
  let dirty = false;
  let msg = { text: "", err: false };
  const timers = new Set();
  let dead = false;

  const say = (text, err = false) => { msg = { text, err }; paintMsg(); };
  const msgEl = h("div", { style: { fontSize: "13px", minHeight: "18px" } });
  const paintMsg = () => { msgEl.textContent = msg.text; msgEl.style.color = msg.err ? "#ef4444" : "inherit"; msgEl.style.opacity = msg.err ? "1" : ".8"; };

  const accountsBox = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
  const provBox = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } });
  const imageBox = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } });
  const modelsBox = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } });

  async function refresh(keepEdits) {
    try {
      const s = await api("GET", "/state");
      state.accounts = s.accounts; state.models = s.models;
      if (!keepEdits) state.providers = s.providers.map((p) => ({ ...p, orig_name: p.name }));
      paint();
    } catch (e) {
      say("No se pudo contactar con el servicio local de modelos (127.0.0.1:8318). Ábrelo con el comando chatgpt2. " + e.message, true);
    }
  }

  function paint() {
    // cuentas
    accountsBox.replaceChildren(
      ...(state.accounts.length
        ? state.accounts.map((a) =>
            h("div", { style: { display: "flex", alignItems: "center", gap: "10px", justifyContent: "space-between" } },
              h("div", {}, h("b", {}, a.type), "  ", h("span", { style: S.muted }, a.email)),
              h("button", { style: S.btn, onClick: async () => {
                if (!confirm("¿Quitar la cuenta " + (a.email || a.type) + "?")) return;
                await api("DELETE", "/account/" + encodeURIComponent(a.file)); await applyNow("Cuenta eliminada."); }, }, "Quitar")))
        : [h("div", { style: S.muted }, "Aún no hay cuentas conectadas.")]),
    );
    // modelos disponibles
    modelsBox.replaceChildren(...state.models.map((m) => h("span", { style: { border: BORDER, borderRadius: "999px", padding: "2px 10px", fontSize: "12px" } }, m)));
    const imgs = state.models.filter((m) => /image/i.test(m));
    imageBox.replaceChildren(...(imgs.length ? imgs.map((m) => h("span", { style: { border: BORDER, borderRadius: "999px", padding: "2px 10px", fontSize: "12px" } }, m)) : [h("span", { style: S.muted }, "Ningún modelo de imagen disponible: conecta Antigravity arriba.")]));
    // proveedores
    provBox.replaceChildren(...state.providers.map(providerCard));
  }

  function field(label, input, grow) {
    return h("label", { style: { display: "flex", flexDirection: "column", gap: "4px", flex: grow || "1 1 180px", minWidth: "0" } }, h("span", { style: S.muted }, label), input);
  }

  function providerCard(p, pi) {
    const bind = (obj, key, extra) => (e) => { obj[key] = extra ? extra(e.target) : e.target.value; dirty = true; };
    const models = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
    const paintModels = () => models.replaceChildren(...p.models.map((m, mi) =>
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "flex-end", borderTop: BORDER, paddingTop: "8px" } },
        field("ID del modelo (tal cual lo espera la API)", h("input", { style: S.input, value: m.name || "", placeholder: "p. ej. moonshotai/kimi-k2", onInput: bind(m, "name") }), "2 1 240px"),
        field("Nombre en el selector", h("input", { style: S.input, value: m.display || "", placeholder: "(opcional)", onInput: bind(m, "display") })),
        field("Contexto (tokens)", h("input", { style: { ...S.input }, type: "number", value: m.context || "", placeholder: "128000", onInput: bind(m, "context") }), "0 1 130px"),
        h("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", paddingBottom: "7px" } },
          h("input", { type: "checkbox", checked: !!m.image, onChange: (e) => { m.image = e.target.checked; dirty = true; } }), "Imágenes"),
        h("button", { style: S.btn, onClick: () => { p.models.splice(mi, 1); dirty = true; paintModels(); } }, "✕"))));
    paintModels();
    return h("div", { style: S.card },
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "flex-end" } },
        field("Nombre del proveedor", h("input", { style: S.input, value: p.name || "", placeholder: "openrouter", onInput: bind(p, "name") })),
        field("URL base (API compatible con OpenAI)", h("input", { style: S.input, value: p.base_url || "", placeholder: "https://…/v1", onInput: bind(p, "base_url") }), "2 1 280px"),
        field("API key", h("input", { style: S.input, type: "password", value: p.api_key || "", placeholder: p.has_key ? "guardada " + p.key_hint + " (déjalo vacío para conservarla)" : "sk-…", onInput: bind(p, "api_key"), autocomplete: "off" }), "2 1 240px"),
        h("button", { style: { ...S.btn, color: "#ef4444" }, onClick: () => { if (confirm("¿Quitar el proveedor " + (p.name || "") + "?")) { state.providers.splice(pi, 1); dirty = true; paint(); } } }, "Quitar proveedor")),
      models,
      h("div", {}, h("button", { style: S.btn, onClick: () => { p.models.push({ name: "", image: false }); dirty = true; paintModels(); } }, "+ Añadir modelo")));
  }

  async function applyNow(okText) {
    say("Aplicando…");
    try {
      const r = await api("POST", "/apply");
      await refresh(true);
      say((okText ? okText + " " : "") + "Listo: " + r.models + " modelos. Pulsa «Reiniciar ChatGPT 2» para verlos en el selector.");
    } catch (e) { say("Error: " + e.message, true); }
  }

  async function save() {
    say("Guardando…");
    try {
      await api("PUT", "/providers", { providers: state.providers });
      dirty = false;
      await applyNow("Guardado.");
      await refresh(false);
    } catch (e) { say("Error: " + e.message, true); }
  }

  function loginButton([kind, label]) {
    const b = h("button", { style: S.btn }, "Iniciar sesión con " + label);
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api("POST", "/login/" + kind);
        say("Termina el inicio de sesión de " + label + " en el navegador que se abrió…");
        const t = setInterval(async () => {
          if (dead) return clearInterval(t);
          try {
            const st = await api("GET", "/login/" + kind);
            if (st.state === "running") return;
            clearInterval(t); timers.delete(t); b.disabled = false;
            if (st.state === "ok") await applyNow(label + " conectado.");
            else say("No se completó el inicio de sesión de " + label + ". " + (st.tail || ""), true);
          } catch (e) { clearInterval(t); b.disabled = false; say(e.message, true); }
        }, 2000);
        timers.add(t);
      } catch (e) { b.disabled = false; say("Error: " + e.message, true); }
    });
    return b;
  }

  const tplSelect = h("select", { style: { ...S.btn }, onChange: (e) => {
    const i = Number(e.target.value); e.target.value = "";
    if (Number.isNaN(i)) return;
    const t = TEMPLATES[i];
    state.providers.push({ name: t.name, base_url: t.base_url, api_key: "", models: [{ name: "", image: false }] });
    dirty = true; paint();
  } }, h("option", { value: "" }, "+ Añadir proveedor…"), ...TEMPLATES.map((t, i) => h("option", { value: String(i) }, t.label)));

  root.replaceChildren(
    h("div", { style: { display: "flex", flexDirection: "column", gap: "22px", maxWidth: "860px", padding: "4px 2px 40px" } },
      h("div", {}, h("h1", { style: { fontSize: "20px", fontWeight: "600", margin: "0 0 6px" } }, "Modelos personalizados"),
        h("div", { style: S.muted }, "Todo pasa por el hub local de este clon: los modelos usan las herramientas de Codex (shell, edición de archivos, plugins) como si fueran nativos.")),
      h("section", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("h2", { style: S.h2 }, "Cuentas conectadas"), accountsBox,
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px" } }, ...LOGINS.map(loginButton))),
      h("section", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("h2", { style: S.h2 }, "Proveedores con API (URL base + clave)"), provBox, h("div", {}, tplSelect)),
      h("section", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("h2", { style: S.h2 }, "Modelos disponibles ahora"), modelsBox),
      h("section", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("h2", { style: S.h2 }, "Generación de imágenes (Gemini)"), imageBox,
        h("div", { style: S.muted }, "Cualquier modelo del clon puede pedir imágenes con la herramienta «generate_image» (también edita con imágenes de referencia y elige relación de aspecto). Las guarda en ~/.codex-2/generated_images/gemini/. Si la cuota de la cuenta se agota, la herramienta avisa cuándo se restablece.")),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" } },
        h("button", { style: S.primary, onClick: save }, "Guardar y aplicar"),
        h("button", { style: S.btn, onClick: async () => { try { await api("POST", "/restart"); say("Reiniciando…"); } catch (e) { say(e.message, true); } } }, "Reiniciar ChatGPT 2"),
        h("button", { style: S.btn, onClick: () => refresh(false) }, "Recargar")),
      msgEl));

  refresh(false);
  return () => { dead = true; timers.forEach(clearInterval); };
}

export function CustomModelsSettings() {
  return {
    $$typeof: Symbol.for("react.transitional.element"),
    type: "div", key: null, ref: null,
    props: { ref: mount, style: { padding: "16px 20px", overflow: "auto", height: "100%", boxSizing: "border-box" } },
    _owner: null, _store: {},
  };
}
