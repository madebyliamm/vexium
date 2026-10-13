// SDK behaviour tests — run:  node --test sdk/test/sdk_v1.test.ts
// Loads the real sdk/v1.js into a fake browser (window/localStorage/fetch/document) and drives it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../v1.js', import.meta.url), 'utf8');

interface Sent { url: string; body: any }

function boot(opts: { site?: string; replies?: (s: Sent) => { status?: number; json: any } | 'network-error'; preload?: Record<string, string>; throwingStorage?: boolean } = {}) {
  const sent: Sent[] = [];
  const events: { type: string; detail: any }[] = [];
  const winListeners: Record<string, ((e: any) => void)[]> = {};
  const ls = new Map<string, string>(Object.entries(opts.preload ?? {}));
  const localStorage = opts.throwingStorage
    ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } }
    : { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, String(v)), removeItem: (k: string) => void ls.delete(k) };
  const ss = new Map<string, string>();
  const sessionStorage = { getItem: (k: string) => ss.get(k) ?? null, setItem: (k: string, v: string) => void ss.set(k, String(v)) };

  const forms: any[] = [];
  const document = {
    referrer: '',
    querySelectorAll: () => forms,
  };
  const window: any = {
    __VX: opts.site === undefined ? { site: 'proj_test' } : opts.site ? { site: opts.site } : undefined,
    addEventListener: (t: string, fn: (e: any) => void) => { (winListeners[t] ||= []).push(fn); },
    dispatchEvent: (e: any) => { events.push({ type: e.type, detail: e.detail }); return true; },
  };
  class CustomEvent { type: string; detail: any; constructor(type: string, init: any = {}) { this.type = type; this.detail = init.detail; } }
  const fetchFake = async (url: string, init: any) => {
    const s: Sent = { url, body: JSON.parse(init.body) };
    sent.push(s);
    const r = (opts.replies ?? (() => ({ json: { success: true } })))(s);
    if (r === 'network-error') throw new TypeError('failed');
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json };
  };
  const location = { origin: 'https://liam.vexium.ai', pathname: '/shop/', get href() { return 'https://liam.vexium.ai/shop/'; }, set href(v: string) { (location as any)._go = v; } } as any;
  const alerts: string[] = [];

  const ctx = vm.createContext({
    window, localStorage, sessionStorage, document, fetch: fetchFake, CustomEvent, location, Date, JSON, Promise, Math, Array, Object,
    alert: (m: string) => alerts.push(m),
  });
  vm.runInContext(SRC, ctx);
  return { vx: window.vx, window, sent, events, alerts, ls, location, forms, fire: (t: string, e: any) => (winListeners[t] || []).forEach((f) => f(e)) };
}

const session = (extra: any = {}) => ({ json: { success: true, token: 'vxs_tok', expires_at: new Date(Date.now() + 86_400_000).toISOString(), user: { id: 'u1', email: 'a@b.co' }, ...extra } });

describe('SDK bootstrap', () => {
  it('exposes vx.* and the legacy aliases; loading twice is a no-op', () => {
    const { vx, window } = boot();
    assert.equal(vx.version, 1);
    for (const ns of ['auth', 'data', 'forms', 'pay', 'track']) assert.equal(typeof vx[ns], 'object', ns);
    for (const a of ['vxCall', 'vxSignup', 'vxLogin', 'vxLogout', 'vxCurrentUser', 'vxGetToken', 'vxCheckout', 'vxBuy', 'vxBuyAmount']) assert.equal(typeof window[a], 'function', a);
    const first = window.vx;
    vm.runInContext(SRC, vm.createContext({ window }));
    assert.equal(window.vx, first);
  });
  it('vx.config sets the site when the page did not inject one', async () => {
    const { vx, sent } = boot({ site: '' });
    await vx.data.submit('c', {});
    assert.equal(sent[0].body.project_id, '');
    vx.config({ site: 'proj_late' });
    await vx.data.submit('c', {});
    assert.equal(sent[1].body.project_id, 'proj_late');
  });
});

describe('vx.auth', () => {
  it('login stores token/user, fires onChange + vx:auth, and later calls carry the token', async () => {
    const { vx, sent, events, ls } = boot({ replies: (s) => (s.body.action === 'login' ? session() : { json: { success: true, rows: [] } }) });
    const seen: any[] = [];
    vx.auth.onChange((u: any) => seen.push(u));
    const r = await vx.auth.login('a@b.co', 'secret-pass');
    assert.equal(r.success, true);
    assert.equal(ls.get('vx_token'), 'vxs_tok');
    assert.deepEqual(vx.auth.user(), { id: 'u1', email: 'a@b.co' });
    assert.equal(vx.auth.token(), 'vxs_tok');
    assert.deepEqual(seen, [{ id: 'u1', email: 'a@b.co' }]);
    assert.equal(events.at(-1)!.type, 'vx:auth');
    await vx.data.list('notes');
    assert.equal(sent.at(-1)!.body.token, 'vxs_tok');
    assert.equal(sent.at(-1)!.body.action, 'list');
  });
  it('failed login stores nothing and passes the server error through', async () => {
    const { vx, ls } = boot({ replies: () => ({ status: 401, json: { error: 'invalid email or password', code: 'invalid_credentials' } }) });
    const r = await vx.auth.login('a@b.co', 'x');
    assert.equal(r.error, 'invalid email or password');
    assert.equal(r.status, 401);
    assert.equal(ls.has('vx_token'), false);
    assert.equal(vx.auth.user(), null);
  });
  it('signup stores the session; logout clears locally first and tells the server', async () => {
    const { vx, sent, ls } = boot({ replies: (s) => (s.body.action === 'signup' ? session() : { json: { success: true } }) });
    await vx.auth.signup('a@b.co', 'secret-pass', { plan: 'pro' });
    assert.equal(sent[0].body.metadata.plan, 'pro');
    assert.equal(ls.get('vx_token'), 'vxs_tok');
    const p = vx.auth.logout();
    assert.equal(vx.auth.token(), null, 'cleared before the network call finishes');
    await p;
    assert.deepEqual(sent.at(-1)!.body, { project_id: 'proj_test', action: 'logout', token: 'vxs_tok' });
  });
  it('an expired server session (session_expired) signs the user out and notifies listeners', async () => {
    const { vx, ls } = boot({ preload: { vx_token: 'old', vx_user: '{"id":"u1","email":"a@b.co"}' }, replies: () => ({ status: 401, json: { error: 'session expired', code: 'session_expired' } }) });
    let last: any = 'unset';
    vx.auth.onChange((u: any) => { last = u; });
    assert.equal(vx.auth.user().email, 'a@b.co');
    await vx.data.list('notes');
    assert.equal(ls.has('vx_token'), false);
    assert.equal(last, null);
  });
  it('a client-side expired token is treated as signed out without a request', () => {
    const { vx, sent } = boot({ preload: { vx_token: 't', vx_user: '{"id":"u"}', vx_expires: '2020-01-01T00:00:00Z' } });
    assert.equal(vx.auth.token(), null);
    assert.equal(vx.auth.user(), null);
    assert.equal(sent.length, 0);
  });
  it('me() refreshes the cached user; without a token it resolves null with no request', async () => {
    const a = boot();
    assert.equal(await a.vx.auth.me(), null);
    assert.equal(a.sent.length, 0);
    const b = boot({ preload: { vx_token: 't' }, replies: () => ({ json: { success: true, user: { id: 'u9', email: 'z@z.co', metadata: {} } } }) });
    assert.equal((await b.vx.auth.me()).email, 'z@z.co');
    assert.equal(b.vx.auth.user().id, 'u9');
  });
  it('unsubscribe works; a throwing listener does not break the SDK', async () => {
    const { vx } = boot({ replies: () => session() });
    let n = 0;
    const off = vx.auth.onChange(() => { n++; });
    vx.auth.onChange(() => { throw new Error('page bug'); });
    await vx.auth.login('a@b.co', 'x');
    off();
    await vx.auth.logout();
    assert.equal(n, 1);
  });
  it('works when localStorage is blocked (private mode) — falls back to memory', async () => {
    const { vx } = boot({ throwingStorage: true, replies: () => session() });
    await vx.auth.login('a@b.co', 'x');
    assert.equal(vx.auth.token(), 'vxs_tok');
  });
});

describe('transport', () => {
  it('network failures resolve (never throw) with a friendly error', async () => {
    const { vx } = boot({ replies: () => 'network-error' });
    const r = await vx.data.submit('c', { a: 1 });
    assert.equal(r.code, 'network');
    assert.match(r.error, /Network error/);
  });
  it('data.* maps to the right actions and payloads', async () => {
    const { vx, sent } = boot();
    await vx.data.submit('c', { a: 1 });
    await vx.data.list('c', { limit: 5, before: '2026-01-01T00:00:00Z', mine: true });
    await vx.data.update('c', 'id1', { a: 2 });
    await vx.data.remove('c', 'id1');
    await vx.forms.submit('c', { b: 1 });
    assert.deepEqual(sent.map((s) => s.body.action), ['submit', 'list', 'update', 'delete', 'submit']);
    assert.deepEqual(sent[1].body, { project_id: 'proj_test', action: 'list', collection: 'c', limit: 5, before: '2026-01-01T00:00:00Z', mine: true });
    assert.ok(sent.every((s) => s.url.endsWith('/functions/v1/site-api')));
  });
  it('legacy vxCall passes the caller\'s own token through and keeps the {action,payload} shape', async () => {
    const { window, sent } = boot();
    await window.vxCall('submit', { collection: 'c', data: { a: 1 }, token: 'explicit' });
    assert.equal(sent[0].body.token, 'explicit');
    assert.equal(sent[0].body.project_id, 'proj_test');
  });
});

describe('vx.pay', () => {
  it('buy() sends product_id with success/cancel URLs and redirects to the checkout url', async () => {
    const { vx, sent, location } = boot({ replies: () => ({ json: { url: 'https://checkout.stripe.com/c/x' } }) });
    await vx.pay.buy('tee-classic');
    assert.ok(sent[0].url.endsWith('/stripe-site-checkout'));
    assert.deepEqual(sent[0].body, { project_id: 'proj_test', success_url: 'https://liam.vexium.ai/shop/?paid=1', cancel_url: 'https://liam.vexium.ai/shop/', product_id: 'tee-classic' });
    assert.equal(location._go, 'https://checkout.stripe.com/c/x');
  });
  it('buyAmount() sends the amount; errors alert unless silent', async () => {
    const { vx, sent, alerts } = boot({ replies: () => ({ status: 400, json: { error: 'Connect Stripe first' } }) });
    await vx.pay.buyAmount(500, 'Donation');
    assert.equal(sent[0].body.amount_cents, 500);
    assert.deepEqual(alerts, ['Connect Stripe first']);
    await vx.pay.buy('x', { silent: true });
    assert.equal(alerts.length, 1);
  });
});

describe('vx.track', () => {
  it('page() posts to the track collector with stable session/visitor ids', async () => {
    const { vx, sent } = boot();
    await vx.track.page('/pricing');
    await vx.track.page();
    assert.ok(sent[0].url.endsWith('/functions/v1/track'));
    assert.equal(sent[0].body.page, '/pricing');
    assert.equal(sent[1].body.page, '/shop/');
    assert.equal(sent[0].body.visitor_id, sent[1].body.visitor_id);
    assert.equal(sent[0].body.session_id, sent[1].body.session_id);
  });
});

describe('vx.forms.bind', () => {
  function fakeForm() {
    const handlers: Record<string, (e: any) => void> = {};
    const attrs: Record<string, string> = {};
    const msg = { textContent: '' };
    const btn = { disabled: false };
    const els = [
      { name: 'email', type: 'email', value: 'a@b.co' },
      { name: 'agree', type: 'checkbox', checked: true },
      { name: 'plan', type: 'radio', checked: false, value: 'free' },
      { name: 'plan', type: 'radio', checked: true, value: 'pro' },
      { name: 'upload', type: 'file', value: 'x' },
      { name: '', type: 'text', value: 'ignored' },
      { name: 'go', type: 'submit', value: 'Send' },
    ];
    const dispatched: string[] = [];
    return {
      attrs, msg, btn, dispatched, handlers, elements: els,
      addEventListener: (t: string, fn: (e: any) => void) => { handlers[t] = fn; },
      setAttribute: (k: string, v: string) => { attrs[k] = v; },
      querySelector: (sel: string) => (sel === '[data-vx-message]' ? msg : sel === '[type=submit]' ? btn : null),
      reset: () => {},
      dispatchEvent: (e: any) => { dispatched.push(e.type); },
    };
  }

  it('collects named fields, sends them, reports success state, resets, and fires callbacks', async () => {
    const t = boot({ replies: () => ({ json: { success: true, id: 'r1' } }) });
    const form = fakeForm();
    t.forms.push(form);
    let ok: any = null;
    assert.equal(t.vx.forms.bind('form#c', 'messages', { onSuccess: (r: any) => { ok = r; } }), 1);
    let prevented = false;
    form.handlers.submit({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(form.attrs['data-vx-state'], 'sending');
    assert.equal(form.btn.disabled, true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(t.sent[0].body.data, { email: 'a@b.co', agree: true, plan: 'pro' });
    assert.equal(t.sent[0].body.collection, 'messages');
    assert.equal(form.attrs['data-vx-state'], 'sent');
    assert.equal(form.msg.textContent, 'Thanks — we got it.');
    assert.equal(form.btn.disabled, false);
    assert.deepEqual(form.dispatched, ['vx:submitted']);
    assert.equal(ok.id, 'r1');
  });
  it('shows the server error and fires vx:error; binding twice does not double-submit', async () => {
    const t = boot({ replies: () => ({ status: 429, json: { error: 'too many requests — try again later' } }) });
    const form = fakeForm();
    t.forms.push(form);
    t.vx.forms.bind('form', 'c');
    t.vx.forms.bind('form', 'c');
    form.handlers.submit({ preventDefault() {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(t.sent.length, 1);
    assert.equal(form.attrs['data-vx-state'], 'error');
    assert.equal(form.msg.textContent, 'too many requests — try again later');
    assert.deepEqual(form.dispatched, ['vx:error']);
  });
});
