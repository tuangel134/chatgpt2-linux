;(()=>{
// ChatGPT 2 · pestaña «ChatGPT Web» (lado interfaz). Con el modo «ChatGPT Web» activo: la vista de chatgpt.com ocupa todo el ancho
// bajo el título (se conservan el selector de modos, la campana y la lupa; el resto del panel lateral queda tapado y la barra de
// iconos se oculta). Si se abre un menú o diálogo, la vista se retira un momento para no taparlo. En otros modos no hace nada.
if (window.__chatgptWebOverlay) return;
window.__chatgptWebOverlay = true;
const ENDPOINT = 'http://127.0.0.1:8322/view', TOKEN = '__CGW_TOKEN__';
let shown = false, lastKey = '';
const hiddenNavs = new Set();
const post = (body) => fetch(ENDPOINT, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => undefined);
function titleRect() {
  for (const b of document.querySelectorAll('button')) {
    const label = b.textContent.trim();
    if (!label.startsWith('ChatGPT Web') || label.length > 30) continue;
    const r = b.getBoundingClientRect();
    if (r.x < 400 && r.y < 100 && r.width > 0) return r;
  }
  return null;
}
function setRail(hidden) {
  if (hidden) {
    for (const n of document.querySelectorAll('nav')) {
      const r = n.getBoundingClientRect();
      if (r.x <= 1 && r.width > 0 && r.width <= 60) { n.style.visibility = 'hidden'; hiddenNavs.add(n); }
    }
  } else { for (const n of hiddenNavs) n.style.visibility = ''; hiddenNavs.clear(); }
}
let cover = null;
function bgColor() {
  for (const el of [document.querySelector('main'), document.body, document.documentElement]) {
    if (!el) continue;
    const c = getComputedStyle(el).backgroundColor;
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
  }
  return '#181818';
}
function setCover(y) {
  if (y == null) { if (cover) cover.style.display = 'none'; return; }
  if (!cover) { cover = document.createElement('div'); cover.id = 'cgw-cover'; document.body.appendChild(cover); }
  Object.assign(cover.style, { position: 'fixed', left: '0', top: y + 'px', width: '100vw', height: 'calc(100vh - ' + y + 'px)', backgroundColor: bgColor(), zIndex: '40', display: 'block' });
}
let snapping = false;
async function snapThenHide() {
  if (snapping) return;
  if (!shown) return hide();
  snapping = true;
  try {
    const r = await fetch('http://127.0.0.1:8322/snap', { headers: { Authorization: 'Bearer ' + TOKEN } }).then((x) => x.json());
    if (r && r.ok && cover) { cover.style.backgroundImage = 'url(' + r.data + ')'; cover.style.backgroundSize = '100% 100%'; cover.style.backgroundRepeat = 'no-repeat'; }
  } catch {}
  snapping = false;
  hide();
}
function hide() { if (shown) { shown = false; lastKey = ''; post({ show: false }); } }
function tick() {
  let t = null;
  try { t = titleRect(); } catch { t = null; }
  if (!t) { setRail(false); setCover(null); hide(); return; }
  setRail(true);
  setCover(Math.round(t.bottom + 8));
  const popup = document.querySelector('[data-radix-popper-content-wrapper],[role=menu],[role=dialog]') != null;
  if (popup) { if (shown) snapThenHide(); return; }
  if (cover) cover.style.backgroundImage = '';
  const y = Math.round(t.bottom + 8);
  const w = window.innerWidth, h = window.innerHeight - y;
  if (w < 300 || h < 200) { hide(); return; }
  const key = [0, y, w, h].join(',');
  if (!shown || key !== lastKey) { shown = true; lastKey = key; post({ show: true, x: 0, y, width: w, height: h, bg: bgColor() }); }
}
setInterval(tick, 300);
// reacción inmediata: al pulsar el título, capturar la página y mostrarla como imagen bajo el menú antes de retirar la vista
document.addEventListener('pointerdown', (e) => { try { const t = titleRect(); if (t && shown && e.clientX >= t.left && e.clientX <= t.right && e.clientY >= t.top && e.clientY <= t.bottom) snapThenHide(); } catch {} }, true);
new MutationObserver(() => { if (shown && document.querySelector('[data-radix-popper-content-wrapper],[role=menu],[role=dialog]')) snapThenHide(); }).observe(document.body, { childList: true, subtree: true });
window.addEventListener('beforeunload', () => { setRail(false); setCover(null); if (shown) post({ show: false }); });
})();
