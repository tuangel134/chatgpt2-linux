
// ChatGPT 2: selector de modelos con buscador y grupos (Antigravity, OpenCode Go, OpenCode Free, otros).
// Se añade al final del paquete principal de la interfaz; solo reordena y filtra el menú con CSS (no toca los datos).
;(() => {
  try {
    if (window.__c2Picker) return; window.__c2Picker = true;
    const ORDER = ["Principal", "Antigravity", "OpenCode Go", "OpenCode Free"];
    const groupOf = (name) => {
      if (/^AUTO$/i.test(name.trim())) return "Principal";
      const m = /\(([^)]+)\)\s*$/.exec(name.trim());
      if (m) { const g = m[1].trim(); return ORDER.find((o) => o.toLowerCase() === g.toLowerCase()) || g; }
      return "Otros (APIs propias)";
    };
    const rank = (g) => { const i = ORDER.indexOf(g); return i >= 0 ? i : ORDER.length; };
    const titleOf = (el) => (el.innerText || "").split("\n")[0].trim();

    function enhance(menu) {
      const radios = [...menu.querySelectorAll('[role="menuitemradio"]')];
      if (radios.length < 8) return;
      const parent = radios[radios.length - 1].parentElement;
      if (!radios.every((r) => r.parentElement === parent)) return;
      if (getComputedStyle(parent).display !== "flex" || getComputedStyle(parent).flexDirection !== "column") { parent.style.display = "flex"; parent.style.flexDirection = "column"; }
      const entries = radios.map((el) => ({ el, name: titleOf(el), g: groupOf(titleOf(el)) }));
      const groups = [...new Set(entries.map((e) => e.g))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      parent.querySelectorAll("[data-c2h]").forEach((n) => n.remove());
      const collapsed = (parent.__c2collapsed ||= new Set());
      const heads = new Map();
      groups.forEach((g, gi) => {
        const items = entries.filter((e) => e.g === g).sort((a, b) => a.name.localeCompare(b.name));
        items.forEach((e, i) => { e.el.style.order = String(gi * 1000 + 1 + i); });
        const h = document.createElement("div");
        h.dataset.c2h = g; h.style.order = String(gi * 1000);
        h.style.cssText += ";display:flex;justify-content:space-between;align-items:center;padding:8px 12px 4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.6;cursor:pointer;user-select:none";
        h.innerHTML = "<span></span><span></span>"; h.firstChild.textContent = g;
        h.onclick = () => { collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); apply(); };
        parent.append(h); heads.set(g, { h, items });
      });
      // fila de ajustes (primera): se deja arriba
      let box = menu.querySelector("[data-c2s]");
      if (!box) {
        box = document.createElement("div"); box.dataset.c2s = "1";
        box.style.cssText = "position:sticky;top:0;z-index:2;padding:6px 8px;background:inherit;";
        const input = document.createElement("input");
        input.type = "search"; input.placeholder = "Buscar modelo…"; input.autocomplete = "off"; input.spellcheck = false;
        input.style.cssText = "width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit;font:inherit;font-size:13px;outline:0";
        for (const ev of ["keydown", "keyup", "keypress"]) input.addEventListener(ev, (e) => e.stopPropagation());
        input.addEventListener("input", () => apply());
        box.append(input);
        parent.parentElement.insertBefore(box, parent);
        setTimeout(() => input.focus(), 30);
      }
      const input = box.querySelector("input");
      function apply() {
        const q = input.value.trim().toLowerCase();
        for (const [g, { h, items }] of heads) {
          let shown = 0;
          for (const e of items) {
            const ok = (!q || e.name.toLowerCase().includes(q)) && !(collapsed.has(g) && !q);
            e.el.style.display = ok ? "" : "none"; if (ok) shown++;
          }
          const total = items.filter((e) => !q || e.name.toLowerCase().includes(q)).length;
          h.style.display = total ? "flex" : "none";
          h.lastChild.textContent = (collapsed.has(g) && !q ? "▸ " : "") + total;
        }
      }
      apply();
    }

    let timer = 0;
    const scan = () => { timer = 0; document.querySelectorAll('[role="menu"]').forEach((m) => { if (m.dataset.c2done) return; if (m.querySelectorAll('[role="menuitemradio"]').length >= 8) { m.dataset.c2done = "1"; enhance(m); } }); };
    new MutationObserver(() => { if (!timer) timer = setTimeout(scan, 60); }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { console.warn("c2 picker", e); }
})();
