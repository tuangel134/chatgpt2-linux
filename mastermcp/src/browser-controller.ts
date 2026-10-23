/* Independent Brave CDP browser. Browser actions execute in the webpage, never Node's VM. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

type Action = 'list' | 'open' | 'summary' | 'execute' | 'screenshot' | 'share' | 'unshare';
interface Page {
  id: string; targetId: string; ws: string; url: string; title: string; shared: boolean;
}
interface Input { url?: string; code?: string; args?: readonly unknown[]; timeoutMs?: number; fullPage?: boolean }
const URLS = new Set(['http:', 'https:']);
const delay = (n: number): Promise<void> => new Promise((ok) => setTimeout(ok, n));
const checkURL = (s: string): string => {
  const u = new URL(s);
  if (!URLS.has(u.protocol)) throw new Error('Browser only permits HTTP(S).');
  return u.href;
};

export class BrowserController {
  private pages = new Map<string, Page>();
  private child?: ChildProcess;
  private port = 0;
  private profile = resolve(process.env.CHATGPT2_MCP_BROWSER_PROFILE || resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex-2'), 'mastermcp-browser'));
  private busy?: Promise<void>;

  private async ensure(): Promise<void> {
    if (this.port) return;
    if (this.busy) return this.busy;
    this.busy = this.launch();
    try { await this.busy; } finally { this.busy = undefined; }
  }

  private async launch(): Promise<void> {
    if (process.env.CHATGPT2_MCP_HEADLESS !== '1' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
      throw new Error('Visible Brave needs desktop DISPLAY or WAYLAND_DISPLAY.');
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    const active = resolve(this.profile, 'DevToolsActivePort');
    await unlink(active).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    const flags = [
      '--user-data-dir=' + this.profile, '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      '--password-store=basic', '--new-window', 'about:blank'
    ];
    if (process.env.CHATGPT2_MCP_HEADLESS === '1') flags.unshift('--headless=new', '--disable-gpu');
    const bin = process.env.CHATGPT2_BROWSER || ['brave-browser', 'brave', 'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'microsoft-edge'].map((n) => (process.env.PATH || '').split(':').map((d) => d + '/' + n).find((p) => existsSync(p)) || '').find(Boolean);
    if (!bin) throw new Error('No encuentro un navegador Chromium (Brave, Chromium, Chrome...). Instálalo o define CHATGPT2_BROWSER.');
    const child = spawn(bin, flags, { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    this.child = child;
    for (let i = 0; i < 65; i++) {
      if (child.exitCode !== null) break;
      try {
        const contents = (await readFile(active, 'utf8')).split('\n');
        const port = Number(contents[0]);
        if (Number.isInteger(port) && port > 0) {
          const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(750) });
          if (response.ok) { this.port = port; return; }
        }
      } catch { /* startup */ }
      await delay(150);
    }
    throw new Error('Brave CDP did not start under its private profile.');
  }

  private async endpoint(path: string, method = 'GET'): Promise<any> {
    await this.ensure();
    const r = await fetch('http://127.0.0.1:' + this.port + path, { method, signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error('Brave CDP HTTP ' + r.status);
    return r.json();
  }

  private async send(page: Page, method: string, params: object = {}, timeout = 15000): Promise<any> {
    const current = await this.endpoint('/json/list');
    const target = current.find((x: any) => x.id === page.targetId && x.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('Brave tab was closed.');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    return new Promise((ok, fail) => {
      let done = false;
      const timer = setTimeout(() => finish(new Error('CDP timeout')), timeout);
      const finish = (err?: Error, value?: unknown) => {
        if (done) return;
        done = true; clearTimeout(timer); socket.close();
        if (err) fail(err); else ok(value);
      };
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
      socket.addEventListener('message', (event) => {
        try {
          const m = JSON.parse(String(event.data));
          if (m.id === 1) finish(m.error ? new Error(String(m.error.message)) : undefined, m.result);
        } catch (e) { finish(e as Error); }
      });
      socket.addEventListener('error', () => finish(new Error('CDP WebSocket connection failed')));
      socket.addEventListener('close', () => { if (!done) finish(new Error('CDP disconnected')); });
    });
  }

  list(ws?: string): Array<{ id: string; url: string; title: string; shared: boolean; workspaceId: string }> {
    return [...this.pages.values()]
      .filter((p) => ws === undefined || ws === p.ws)
      .map((p) => ({ id: p.id, url: p.url, title: p.title, shared: p.shared, workspaceId: p.ws }));
  }

  async open(url: string, shared = true, workspaceId = ''): Promise<unknown> {
    const safe = checkURL(url);
    const target = await this.endpoint('/json/new?' + encodeURIComponent(safe), 'PUT');
    if (!target?.id) throw new Error('Brave did not create the tab.');
    const page: Page = { id: 'page_' + randomUUID(), targetId: target.id, ws: workspaceId, url: safe, title: '', shared };
    this.pages.set(page.id, page);
    await delay(150);
    await this.summary(page).catch(() => undefined);
    return this.list().find((p) => p.id === page.id);
  }

  share(id: string, shared: boolean): unknown {
    const page = this.require(id);
    page.shared = shared;
    return this.list().find((p) => p.id === id);
  }

  private require(id: string): Page {
    const page = this.pages.get(id);
    if (!page) throw new Error('Unknown browser page.');
    return page;
  }

  private async evaluate(page: Page, expression: string, timeout = 15000): Promise<any> {
    const result = await this.send(page, 'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeout);
    if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.text || 'Browser JavaScript failed.'));
    return result.result?.value;
  }

  private async summary(page: Page): Promise<object> {
    const data = await this.evaluate(page, '({url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,60000)})');
    page.url = data?.url || page.url;
    page.title = data?.title || '';
    return { pageId: page.id, url: page.url, title: page.title, snapshot: data?.text || '' };
  }

  async request(id: string, action: Action, input: Input, workspaceId = ''): Promise<unknown> {
    if (action === 'list') return { pages: this.list(workspaceId).filter((p) => p.shared) };
    if (action === 'open') return this.open(input.url || '', true, workspaceId);
    const page = this.require(id);
    if (page.ws !== workspaceId) throw new Error('Browser tab belongs to a different workspace.');
    if (action === 'share') throw new Error('Share existing tabs manually in ChatGPT 2 Settings.');
    if (action === 'unshare') return this.share(id, false);
    if (!page.shared) throw new Error('Page is not shared with the connector.');
    if (action === 'summary') return this.summary(page);
    if (action === 'screenshot') {
      const data = await this.send(page, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return { pageId: page.id, mimeType: 'image/png', data: data.data, fullPage: false };
    }
    if (action !== 'execute') throw new Error('Unsupported browser action.');
    const code = input.code || '';
    if (!code || code.length > 40000 || (input.args?.length || 0) > 20) throw new Error('Invalid browser function.');
    const expression = ' (async () => { ' +
      'const specFind = (spec) => {' +
      'let xs = spec.kind==="css" ? [...document.querySelectorAll(spec.value)] : [...document.querySelectorAll("body *")];' +
      'if(spec.kind==="text")xs=xs.filter(x=>spec.exact ? (x.innerText||"").trim()===spec.value : (x.innerText||"").includes(spec.value));' +
      'if(spec.kind==="role")xs=xs.filter(x=>(x.getAttribute("role")||({BUTTON:"button",A:"link",INPUT:"textbox"}[x.tagName]||""))===spec.value);' +
      'if(spec.kind==="label")xs=[...document.querySelectorAll("label")].filter(x=>(x.innerText||"").trim()===spec.value).map(x=>x.control||x);' +
      'if(spec.name)xs=xs.filter(x=>{const n=(x.getAttribute("aria-label")||x.innerText||x.value||"").trim();return spec.exact?n===spec.name:n.includes(spec.name)});' +
      'return xs;};' +
      'const loc=(spec)=>({click:async()=>{const e=specFind(spec)[0];if(!e)throw Error("Not found");e.click()},' +
      'fill:async(v)=>{const e=specFind(spec)[0];if(!e)throw Error("Not found");e.focus();' +
      'const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),"value")?.set;' +
      'if(setter)setter.call(e,v);else e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))},' +
      'press:async(k)=>{const e=specFind(spec)[0];if(!e)throw Error("Not found");e.dispatchEvent(new KeyboardEvent("keydown",{key:k,bubbles:true}));e.dispatchEvent(new KeyboardEvent("keyup",{key:k,bubbles:true}))},' +
      'innerText:async()=>specFind(spec)[0]?.innerText||null,textContent:async()=>specFind(spec)[0]?.textContent||null,' +
      'count:async()=>specFind(spec).length,first:()=>loc(spec)});' +
      'const page={url:()=>location.href,title:()=>document.title,' +
      'goto:async(u)=>{const p=new URL(u);if(!["http:","https:"].includes(p.protocol))throw Error("Unsupported URL");location.assign(p.href);return p.href},' +
      'locator:(s)=>loc({kind:"css",value:s}),getByText:(s,o)=>loc({kind:"text",value:s,exact:o?.exact}),' +
      'getByRole:(s,o)=>loc({kind:"role",value:s,name:o?.name,exact:o?.exact}),getByLabel:(s)=>loc({kind:"label",value:s}),' +
      'waitForTimeout:(ms)=>new Promise(r=>setTimeout(r,Math.max(0,Math.min(ms,30000))))};' +
      'const fn=(' + code + ');return await fn(page,...' + JSON.stringify(input.args || []) + '); })()';
    const result = await this.evaluate(page, expression, Math.max(1000, Math.min(120000, input.timeoutMs || 120000)));
    const snapshot = await this.summary(page).catch(() => ({}));
    return { pageId: page.id, result, ...snapshot };
  }

  closeAll(): void {
    this.pages.clear();
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM');
    this.port = 0;
  }
}
