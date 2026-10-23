var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../../.local/opt/chatgpt2/mastermcp/src/browser-controller.ts
var browser_controller_exports = {};
__export(browser_controller_exports, {
  BrowserController: () => BrowserController
});
module.exports = __toCommonJS(browser_controller_exports);
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var URLS = /* @__PURE__ */ new Set(["http:", "https:"]);
var delay = (n) => new Promise((ok) => setTimeout(ok, n));
var checkURL = (s) => {
  const u = new URL(s);
  if (!URLS.has(u.protocol)) throw new Error("Browser only permits HTTP(S).");
  return u.href;
};
var BrowserController = class {
  pages = /* @__PURE__ */ new Map();
  child;
  port = 0;
  profile = (0, import_node_path.resolve)(process.env.CHATGPT2_MCP_BROWSER_PROFILE || (0, import_node_path.resolve)((0, import_node_os.homedir)(), ".codex-2/mastermcp-browser"));
  busy;
  async ensure() {
    if (this.port) return;
    if (this.busy) return this.busy;
    this.busy = this.launch();
    try {
      await this.busy;
    } finally {
      this.busy = void 0;
    }
  }
  async launch() {
    if (process.env.CHATGPT2_MCP_HEADLESS !== "1" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
      throw new Error("Visible Brave needs desktop DISPLAY or WAYLAND_DISPLAY.");
    await (0, import_promises.mkdir)(this.profile, { recursive: true, mode: 448 });
    const active = (0, import_node_path.resolve)(this.profile, "DevToolsActivePort");
    await (0, import_promises.unlink)(active).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    const flags = [
      "--user-data-dir=" + this.profile,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--new-window",
      "about:blank"
    ];
    if (process.env.CHATGPT2_MCP_HEADLESS === "1") flags.unshift("--headless=new", "--disable-gpu");
    const child = (0, import_node_child_process.spawn)("/usr/bin/brave", flags, { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    this.child = child;
    for (let i = 0; i < 65; i++) {
      if (child.exitCode !== null) break;
      try {
        const contents = (await (0, import_promises.readFile)(active, "utf8")).split("\n");
        const port = Number(contents[0]);
        if (Number.isInteger(port) && port > 0) {
          const response = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(750) });
          if (response.ok) {
            this.port = port;
            return;
          }
        }
      } catch {
      }
      await delay(150);
    }
    throw new Error("Brave CDP did not start under its private profile.");
  }
  async endpoint(path, method = "GET") {
    await this.ensure();
    const r = await fetch("http://127.0.0.1:" + this.port + path, { method, signal: AbortSignal.timeout(7e3) });
    if (!r.ok) throw new Error("Brave CDP HTTP " + r.status);
    return r.json();
  }
  async send(page, method, params = {}, timeout = 15e3) {
    const current = await this.endpoint("/json/list");
    const target = current.find((x) => x.id === page.targetId && x.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error("Brave tab was closed.");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    return new Promise((ok, fail) => {
      let done = false;
      const timer = setTimeout(() => finish(new Error("CDP timeout")), timeout);
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        if (err) fail(err);
        else ok(value);
      };
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
      socket.addEventListener("message", (event) => {
        try {
          const m = JSON.parse(String(event.data));
          if (m.id === 1) finish(m.error ? new Error(String(m.error.message)) : void 0, m.result);
        } catch (e) {
          finish(e);
        }
      });
      socket.addEventListener("error", () => finish(new Error("CDP WebSocket connection failed")));
      socket.addEventListener("close", () => {
        if (!done) finish(new Error("CDP disconnected"));
      });
    });
  }
  list(ws) {
    return [...this.pages.values()].filter((p) => ws === void 0 || ws === p.ws).map((p) => ({ id: p.id, url: p.url, title: p.title, shared: p.shared, workspaceId: p.ws }));
  }
  async open(url, shared = true, workspaceId = "") {
    const safe = checkURL(url);
    const target = await this.endpoint("/json/new?" + encodeURIComponent(safe), "PUT");
    if (!target?.id) throw new Error("Brave did not create the tab.");
    const page = { id: "page_" + (0, import_node_crypto.randomUUID)(), targetId: target.id, ws: workspaceId, url: safe, title: "", shared };
    this.pages.set(page.id, page);
    await delay(150);
    await this.summary(page).catch(() => void 0);
    return this.list().find((p) => p.id === page.id);
  }
  share(id, shared) {
    const page = this.require(id);
    page.shared = shared;
    return this.list().find((p) => p.id === id);
  }
  require(id) {
    const page = this.pages.get(id);
    if (!page) throw new Error("Unknown browser page.");
    return page;
  }
  async evaluate(page, expression, timeout = 15e3) {
    const result = await this.send(
      page,
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeout
    );
    if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.text || "Browser JavaScript failed."));
    return result.result?.value;
  }
  async summary(page) {
    const data = await this.evaluate(page, '({url:location.href,title:document.title,text:(document.body?.innerText||"").slice(0,60000)})');
    page.url = data?.url || page.url;
    page.title = data?.title || "";
    return { pageId: page.id, url: page.url, title: page.title, snapshot: data?.text || "" };
  }
  async request(id, action, input, workspaceId = "") {
    if (action === "list") return { pages: this.list(workspaceId).filter((p) => p.shared) };
    if (action === "open") return this.open(input.url || "", true, workspaceId);
    const page = this.require(id);
    if (page.ws !== workspaceId) throw new Error("Browser tab belongs to a different workspace.");
    if (action === "share") throw new Error("Share existing tabs manually in ChatGPT 2 Settings.");
    if (action === "unshare") return this.share(id, false);
    if (!page.shared) throw new Error("Page is not shared with the connector.");
    if (action === "summary") return this.summary(page);
    if (action === "screenshot") {
      const data = await this.send(page, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      return { pageId: page.id, mimeType: "image/png", data: data.data, fullPage: false };
    }
    if (action !== "execute") throw new Error("Unsupported browser action.");
    const code = input.code || "";
    if (!code || code.length > 4e4 || (input.args?.length || 0) > 20) throw new Error("Invalid browser function.");
    const expression = ' (async () => { const specFind = (spec) => {let xs = spec.kind==="css" ? [...document.querySelectorAll(spec.value)] : [...document.querySelectorAll("body *")];if(spec.kind==="text")xs=xs.filter(x=>spec.exact ? (x.innerText||"").trim()===spec.value : (x.innerText||"").includes(spec.value));if(spec.kind==="role")xs=xs.filter(x=>(x.getAttribute("role")||({BUTTON:"button",A:"link",INPUT:"textbox"}[x.tagName]||""))===spec.value);if(spec.kind==="label")xs=[...document.querySelectorAll("label")].filter(x=>(x.innerText||"").trim()===spec.value).map(x=>x.control||x);if(spec.name)xs=xs.filter(x=>{const n=(x.getAttribute("aria-label")||x.innerText||x.value||"").trim();return spec.exact?n===spec.name:n.includes(spec.name)});return xs;};const loc=(spec)=>({click:async()=>{const e=specFind(spec)[0];if(!e)throw Error("Not found");e.click()},fill:async(v)=>{const e=specFind(spec)[0];if(!e)throw Error("Not found");e.focus();const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),"value")?.set;if(setter)setter.call(e,v);else e.value=v;e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))},press:async(k)=>{const e=specFind(spec)[0];if(!e)throw Error("Not found");e.dispatchEvent(new KeyboardEvent("keydown",{key:k,bubbles:true}));e.dispatchEvent(new KeyboardEvent("keyup",{key:k,bubbles:true}))},innerText:async()=>specFind(spec)[0]?.innerText||null,textContent:async()=>specFind(spec)[0]?.textContent||null,count:async()=>specFind(spec).length,first:()=>loc(spec)});const page={url:()=>location.href,title:()=>document.title,goto:async(u)=>{const p=new URL(u);if(!["http:","https:"].includes(p.protocol))throw Error("Unsupported URL");location.assign(p.href);return p.href},locator:(s)=>loc({kind:"css",value:s}),getByText:(s,o)=>loc({kind:"text",value:s,exact:o?.exact}),getByRole:(s,o)=>loc({kind:"role",value:s,name:o?.name,exact:o?.exact}),getByLabel:(s)=>loc({kind:"label",value:s}),waitForTimeout:(ms)=>new Promise(r=>setTimeout(r,Math.max(0,Math.min(ms,30000))))};const fn=(' + code + ");return await fn(page,..." + JSON.stringify(input.args || []) + "); })()";
    const result = await this.evaluate(page, expression, Math.max(1e3, Math.min(12e4, input.timeoutMs || 12e4)));
    const snapshot = await this.summary(page).catch(() => ({}));
    return { pageId: page.id, result, ...snapshot };
  }
  closeAll() {
    this.pages.clear();
    if (this.child && this.child.exitCode === null) this.child.kill("SIGTERM");
    this.port = 0;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BrowserController
});
