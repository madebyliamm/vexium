// Tiny Chrome DevTools Protocol driver used by the browser tests (sdk/test/browser_e2e.mjs, scripts/step5_build_e2e.mjs).
// No dependencies: Node's global WebSocket + a headless Google Chrome. Skip-friendly: launch() returns null when Chrome is missing.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_PATHS = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333 + Math.floor(Math.random() * 400) } = {}) {
  const bin = CHROME_PATHS.find((p) => existsSync(p));
  if (!bin) return null;
  const dir = mkdtempSync(join(tmpdir(), 'vx-chrome-'));
  const proc = spawn(bin, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--mute-audio', 'about:blank',
  ], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.length) break; } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!list || !list.length) { proc.kill(); throw new Error('Chrome did not start'); }
  const page = list.find((t) => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });

  let id = 0;
  const pending = new Map();
  const waiters = [];
  const consoleMsgs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') consoleMsgs.push({ type: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    if (m.method === 'Runtime.exceptionThrown') consoleMsgs.push({ type: 'exception', text: m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text });
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === m.method) { waiters[i].resolve(m.params); waiters.splice(i, 1); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const once = (method, ms = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + method)), ms);
    waiters.push({ method, resolve: (p) => { clearTimeout(t); resolve(p); } });
  });
  await send('Page.enable');
  await send('Runtime.enable');

  const api = {
    consoleMsgs,
    send,
    /** Run a script in every new document before page scripts (used to stub fetch). */
    async preload(source) { await send('Page.addScriptToEvaluateOnNewDocument', { source }); },
    async goto(url) {
      const loaded = once('Page.loadEventFired');
      await send('Page.navigate', { url });
      await loaded;
      await sleep(120); // let DOMContentLoaded handlers + microtasks settle
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n' + expression);
      return r.result.value;
    },
    async viewport(width, height = 800, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    },
    async waitFor(expression, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try { if (await api.eval(expression)) return true; } catch { /* page navigating */ }
        await sleep(100);
      }
      return false;
    },
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      (await import('node:fs')).writeFileSync(path, Buffer.from(data, 'base64'));
    },
    async close() {
      try { ws.close(); } catch { /* ignore */ }
      proc.kill();
      await sleep(200);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
    },
  };
  return api;
}

/** The canned-reply fetch stub injected before page scripts. Tests set window.__reply = (url, body) => ({status?, json}). */
export const FETCH_STUB = `
  window.__calls = [];
  window.__reply = function () { return { json: { success: true } }; };
  window.fetch = function (url, init) {
    var body = init && init.body ? JSON.parse(init.body) : null;
    window.__calls.push({ url: String(url), body: body });
    var r = window.__reply(String(url), body) || { json: {} };
    return Promise.resolve(new Response(JSON.stringify(r.json), { status: r.status || 200, headers: { 'Content-Type': 'application/json' } }));
  };
`;
