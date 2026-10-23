;(()=>{
// ChatGPT 2 · pestaña «ChatGPT Web» (se añade al final del proceso principal con patch_ui.py).
// Muestra chatgpt.com TAL CUAL dentro de la ventana de la app, encima del área de contenido, cuando el modo
// «ChatGPT Web» está activo. Sesión persistente (partición aparte). NO automatiza ni lee la página: es solo una vista.
// El renderizador le dice dónde ponerla por 127.0.0.1:8322 (token en ~/.codex-2/chatgptweb/token).
try {
  const { app, BrowserWindow, WebContentsView, session, shell } = require('electron');
  const http = require('node:http'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const PART = 'persist:chatgpt-web';
  const OAUTH = /^https:\/\/(chatgpt\.com|auth\.openai\.com|auth0\.openai\.com|openai\.com|accounts\.google\.com|appleid\.apple\.com|login\.live\.com|login\.microsoftonline\.com)\//;
  let view = null, host = null, cssKey = null, bgCss = '', applyCss = null;
  const mainWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /^app:\/\/-\/index\.html/.test(w.webContents.getURL()) && !w.webContents.getURL().includes('avatar'));
  const cleanUA = () => { try { return session.fromPartition(PART).getUserAgent().replace(/\sElectron\/\S+/, '').replace(/\sChatGPT\/\S+/, '').replace(/\sCodex\S*\/\S+/, ''); } catch { return undefined; } };
  function ensureView(w) {
    if (view && !view.webContents.isDestroyed() && host === w) return view;
    bgCss = ''; cssKey = null;
    view = new WebContentsView({ webPreferences: { partition: PART, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
    const ua = cleanUA(); if (ua) view.webContents.setUserAgent(ua);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (OAUTH.test(url)) return { action: 'allow' };
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    view.webContents.on('did-fail-load', (_e, code, _d, _u, isMain) => { if (isMain && code !== -3) setTimeout(() => { if (view && !view.webContents.isDestroyed()) view.webContents.loadURL('https://chatgpt.com/'); }, 5000); });
    view.webContents.loadURL('https://chatgpt.com/');
    host = w;
    w.contentView.addChildView(view);
    w.once('closed', () => { view = null; host = null; });
    return view;
  }
  app.whenReady().then(() => {
    const readToken = () => { try { return fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex-2'), 'chatgptweb/token'), 'utf8').trim(); } catch { return ''; } };
    const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    http.createServer((req, res) => {
      if (req.headers.origin === 'app://-') {
        res.setHeader('Access-Control-Allow-Origin', 'app://-'); res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const token = readToken();
      if (!token || req.headers.authorization !== 'Bearer ' + token) return send(res, 401, { error: 'token' });
      if (req.method === 'GET' && req.url === '/snap') {
        if (!view || view.webContents.isDestroyed()) return send(res, 200, { ok: false });
        return view.webContents.capturePage().then((img) => send(res, 200, { ok: true, data: 'data:image/jpeg;base64,' + img.toJPEG(85).toString('base64') }), () => send(res, 200, { ok: false }));
      }
      if (req.method !== 'POST' || req.url !== '/view') return send(res, 404, { error: 'no encontrado' });
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const { show, x, y, width, height, bg } = JSON.parse(body || '{}');
          const w = mainWindow(); if (!w) return send(res, 200, { ok: false });
          if (!show) { if (view && !view.webContents.isDestroyed()) view.setVisible(false); return send(res, 200, { ok: true }); }
          const v = ensureView(w);
          const n = (k) => Math.max(0, Math.round(Number(k) || 0));
          v.setBounds({ x: n(x), y: n(y), width: n(width), height: n(height) });
          if (typeof bg === 'string' && /^[#a-z0-9(),.\s%]{3,40}$/i.test(bg) && bg !== bgCss) {
            bgCss = bg;
            const m = bg.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            const hex = m ? '#' + [m[1], m[2], m[3]].map((c) => Math.min(255, +c).toString(16).padStart(2, '0')).join('') : bg;
            try { v.setBackgroundColor(hex); } catch {}
            const vars = ['--main-surface-primary', '--bg-primary', '--sidebar-surface-primary', '--color-token-bg-primary', '--color-token-main-surface-primary', '--color-token-side-bar-background', '--color-surface-secondary', '--color-background-panel', '--app-color-background-surface', '--app-color-background-surface-under', '--codex-base-surface', '--wb-surface-secondary'];
            const css = 'html,html.dark,html.light,:root,body{' + vars.map((k) => k + ':' + bg + '!important').join(';') + ';background:' + bg + '!important}';
            const wc = v.webContents, old = cssKey; cssKey = null;
            applyCss = () => wc.insertCSS(css).then((k) => { cssKey = k; }).catch(() => {});
            if (old) wc.removeInsertedCSS(old).catch(() => {});
            applyCss();
            if (!wc.__cgwNav) { wc.__cgwNav = true; const again = () => { cssKey = null; if (applyCss) applyCss(); }; wc.on('did-navigate', again); wc.on('dom-ready', again); }
          }
          v.setVisible(true);
          return send(res, 200, { ok: true });
        } catch { return send(res, 400, { error: 'json' }); }
      });
    }).on('error', () => {}).listen(8322, '127.0.0.1');
  });
} catch (e) { console.error('pestaña ChatGPT Web:', e); }
})();
