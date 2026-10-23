'use strict';
const { BrowserController } = require('./browser-controller.cjs');
const { createServer } = require('node:http');
const { strict: assert } = require('node:assert');
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt2-brave-e2e-'));
  process.env.CHATGPT2_MCP_BROWSER_PROFILE = join(dir, 'brave-profile');
  process.env.CHATGPT2_MCP_HEADLESS = '1';
  let browser;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>CDP isolated fixture</title><h1 id="title">Prueba CDP</h1><input id="edit"><button id="btn" onclick="document.querySelector(\'#title\').textContent=\'Click OK\'">Click</button>');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    browser = new BrowserController();
    const page = await browser.open('http://127.0.0.1:' + addr.port, true, 'ws_fixture');
    assert(page.id); console.log('PASS open CDP browser target');
    const initial = await browser.request(page.id, 'summary', {}, 'ws_fixture');
    assert.match(initial.snapshot, /Prueba CDP/); console.log('PASS read DOM summary');
    const clicked = await browser.request(page.id, 'execute', { code:'async (page) => { await page.locator("#btn").click(); return page.title(); }' }, 'ws_fixture');
    assert.match(clicked.snapshot,/Click OK/); console.log('PASS click through CDP');
    const fill = await browser.request(page.id, 'execute', {code:'async (page) => { await page.locator("#edit").fill("Valor X"); return await page.locator("#edit").count(); }'}, 'ws_fixture');
    assert.equal(fill.result,1); console.log('PASS locator/fill');
    const image = await browser.request(page.id, 'screenshot', {}, 'ws_fixture');
    assert(image.data.length > 200 && image.mimeType === 'image/png'); console.log('PASS screenshot PNG CDP');
    browser.share(page.id,false);
    assert.equal((await browser.request('', 'list',{},'ws_fixture')).pages.length,0); console.log('PASS only shared pages are listed');
    await assert.rejects(browser.request(page.id,'summary',{},'ws_fixture'),/not shared/);console.log('PASS unshared page denied');
    await assert.rejects(browser.request(page.id,'share',{},'ws_fixture'),/manually/); console.log('PASS remote cannot reshare');
    await assert.rejects(browser.open('file:///etc/passwd',true,'ws_fixture'),/HTTP/); console.log('PASS local file URLs refused');
    await assert.rejects(browser.request(page.id,'summary',{},'other_workspace'),/different workspace/);console.log('PASS workspace isolation');
  } finally {
    if(browser) browser.closeAll();
    server.close();
    await new Promise(resolve=>setTimeout(resolve,350));
    await rm(dir, {recursive:true,force:true});
  }
})().catch(e => { console.error('BROWSER E2E FAILURE: '+e.message);process.exitCode=1; });
