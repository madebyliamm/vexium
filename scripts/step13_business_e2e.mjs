#!/usr/bin/env node
// Step 13 (chunk A) live evidence: the deployed `business-state` function against the REAL database with a throwaway user + project.
//   node scripts/step13_business_e2e.mjs
// Needs the `supabase` CLI logged in (service key). Creates a user, two projects (one live, one never published), a second user,
// page views / transactions / sign-ups / form entries at known times, then checks the numbers, who may ask, and the saved artifact.
// Everything is deleted in `finally`. No Anthropic credit, no publisher involved.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const REF = 'ciuqhxrxcznmgorjeumz';
const SB = `https://${REF}.supabase.co`;
const ANON = /SUPABASE_ANON_KEY = '([^']+)'/.exec(readFileSync(join(REPO, 'config.js'), 'utf8'))[1];
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-business-e2e)' };
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? `   [${String(detail).slice(0, 300)}]` : '')); };

async function jfetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const svcKey = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--project-ref', REF, '-o', 'json'], { encoding: 'utf8' }))
  .find((k) => k.name === 'service_role' || k.id === 'service_role').api_key;
const svc = { apikey: svcKey, Authorization: 'Bearer ' + svcKey };
const J = { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
const post = (path, body) => jfetch(`${SB}/rest/v1/${path}`, { method: 'POST', headers: J, body: JSON.stringify(body) });

const rand = Math.random().toString(36).slice(2, 8);
const password = 'Biz-e2e-' + rand + '!9';
const users = {};
const PID = `vxbiz_${rand}`, PID_DRAFT = `vxbiz_${rand}_d`;
const iso = (daysAgo, h = 12) => new Date(Date.now() - daysAgo * 86400e3 + (h - 12) * 3600e3).toISOString();

async function mkUser(tag) {
  const username = `vxbiz${tag}${rand}`, email = `${username}@vexium.ai`;
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user ' + r.text);
  const id = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.json?.access_token) throw new Error('sign in ' + r.text);
  users[tag] = { id, username, token: r.json.access_token };
}
const ask = (token, body) => jfetch(`${SB}/functions/v1/business-state`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });

try {
  await mkUser('o'); await mkUser('s');
  const owner = users.o;
  await post('projects', { id: PID, user_id: owner.id, name: 'Biz e2e', files: {}, main_file: 'index.html', published_slug: 'biz-' + rand, published_version: 1, published_at: iso(10), stage: 'business' });
  await post('projects', { id: PID_DRAFT, user_id: owner.id, name: 'Biz e2e draft', files: {} });
  await post('project_deploys', { project_id: PID, version: 1, status: 'ready', created_by: owner.id, created_at: iso(10) });
  // The plan has a scenario and a product, so the state compares with the plan and treats this as a shop.
  await jfetch(`${SB}/rest/v1/rpc/put_project_artifact`, { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_project: PID, p_kind: 'plan', p_data: {
    schema: 1, name: 'Biz', kind: 'site', one_liner: 'x', audience: 'x', offer: 'x', pricing: { model: 'one_time', items: [] }, pages: [],
    backend: { collections: [], products: ['beans'], forms: [], auth: false }, launch_checklist: [], scenario: { price_cents: 2000, monthly_visitors: 300, conversion_pct: 2 } } }) });

  // 60 visitors in the last 9 days (two pages, google + direct + own host), 3 of them twice; some on mobile.
  const views = [];
  for (let i = 0; i < 60; i++) {
    views.push({ project_id: PID, page: i % 3 ? '/' : '/shop.html', referrer: i % 2 ? 'https://www.google.com/' : (i % 5 === 0 ? `https://${owner.username}.vexium.ai/biz` : ''), device: i % 4 ? 'mobile' : 'desktop', session_id: 's' + i, visitor_id: 'v' + i, ts: iso(1 + (i % 9), 8 + (i % 8)) });
  }
  for (let i = 0; i < 3; i++) views.push({ project_id: PID, page: '/', referrer: '', device: 'desktop', session_id: 'x' + i, visitor_id: 'v' + i, ts: iso(1, 18) });
  views.push({ project_id: PID, page: '/', referrer: '', device: 'desktop', session_id: 'old', visitor_id: 'old', ts: iso(40) }); // 40 days ago = the previous 30-day window
  await post('page_views', views);
  await post('site_data', [
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 20, currency: 'usd', status: 'paid', description: 'Beans' }, created_at: iso(2) },
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 20, currency: 'usd', status: 'paid', description: 'Beans' }, created_at: iso(3) },
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 8, currency: 'usd', status: 'paid', description: 'Mug' }, created_at: iso(4) },
    { project_id: PID, collection: 'transactions', data: { type: 'refund', amount: -8, currency: 'usd', status: 'refunded', description: 'Refund issued' }, created_at: iso(1) },
    { project_id: PID, collection: 'transactions', data: { type: 'sale', amount: 99, currency: 'usd', status: 'unpaid', description: 'Abandoned' }, created_at: iso(1) },
    { project_id: PID, collection: 'contact', data: { name: 'Ann', email: 'ann@example.test' }, created_at: iso(2) },
  ]);
  await post('site_users', [{ project_id: PID, email: `a${rand}@x.test`, password_hash: 'x', created_at: iso(2) }]);

  // ── who may ask ──
  let r = await ask(null, { project_id: PID });
  check('no token → 401', r.status === 401, r.text);
  r = await ask(ANON, { project_id: PID });
  check('the anon key is not a user → 401', r.status === 401, r.text);
  r = await ask(users.s.token, { project_id: PID });
  check("somebody else's project → 404", r.status === 404, r.text);
  r = await ask(owner.token, { project_id: 'vxbiz_does_not_exist' });
  check('a missing project → the same 404', r.status === 404 && r.text === (await ask(users.s.token, { project_id: PID })).text, r.text);
  r = await ask(owner.token, { project_id: PID_DRAFT });
  check('a never-published project → 409 not_live', r.status === 409 && r.json?.error === 'not_live', r.text);
  r = await ask(owner.token, { project_id: PID, days: 14 });
  check('days must be 7 / 30 / 90 → 400', r.status === 400, r.text);
  r = await ask(owner.token, {});
  check('project_id is required → 400', r.status === 400, r.text);

  // ── the numbers ──
  r = await ask(owner.token, { project_id: PID });
  const s = r.json?.state;
  check('owner → 200 with a state', r.status === 200 && !!s, r.text);
  if (s) {
    check('visitors = 60 distinct visitors (repeat visits are not double counted; the 40-day-old one is in the previous period)', s.visitors === 60, s.visitors);
    check('views = 63', s.views === 63, s.views);
    check('3 paid orders, the unpaid one ignored', s.orders === 3, s.orders);
    check('revenue = 20 + 20 + 8 − 8 refunded = $40.00', s.revenue_cents === 4000 && s.currency === 'usd', s.revenue_cents);
    check('1 sign-up, 1 form entry', s.signups === 1 && s.leads === 1, `${s.signups}/${s.leads}`);
    check('top product is Beans', s.products?.[0]?.name === 'Beans' && s.products[0].units === 2, JSON.stringify(s.products?.[0]));
    check('Google is a source, the site\'s own address is not', s.sources?.some((x) => x.source === 'Google') && !s.sources.some((x) => /vexium/.test(x.source)), JSON.stringify(s.sources));
    check('the previous period saw 1 visitor', s.previous?.visitors === 1, s.previous?.visitors);
    check('first live ≈ 10 days ago', s.live_days === 10, s.live_days);
    check('60 visitors + 10 days live = "ok"', s.data_level === 'ok', s.data_level);
    check('daily series has 30 days', s.daily?.length === 30, s.daily?.length);
    check('conversion rate = 5 / 60 = 8.3%', s.conversion_rate === 8.3, s.conversion_rate);
    check('compared with the plan', !!s.vs_plan && s.vs_plan.planned.monthly_revenue_cents === 12000, JSON.stringify(s.vs_plan));
    check('as a shop with orders: an orders insight', s.insights?.some((i) => i.id === 'orders'), JSON.stringify(s.insights?.map((i) => i.id)));
    check('no email address anywhere in the state', !JSON.stringify(s).includes('@'), '');
  }
  check('first answer is computed, not cached', r.json?.cached === false, r.json?.cached);
  const v1 = r.json?.version;
  r = await ask(owner.token, { project_id: PID });
  check('asking again within a minute is served from the saved artifact', r.json?.cached === true && r.json?.version === v1, `${r.json?.cached} v${r.json?.version}`);
  r = await ask(owner.token, { project_id: PID, refresh: true });
  check('refresh recomputes and saves a new version', r.json?.cached === false && r.json?.version > v1, `v${r.json?.version}`);
  r = await ask(owner.token, { project_id: PID, days: 7 });
  check('7 days: a different period recomputes', r.json?.cached === false && r.json?.state?.period_days === 7 && r.json.state.daily.length === 7, `${r.json?.state?.period_days}`);

  // ── the artifact is readable by the owner, not writable by clients ──
  r = await jfetch(`${SB}/rest/v1/project_artifacts?project_id=eq.${PID}&kind=eq.business_state&select=version,data&order=version.desc&limit=1`, { headers: { apikey: ANON, Authorization: 'Bearer ' + owner.token } });
  check('the owner can read the saved business_state', r.status === 200 && r.json?.[0]?.data?.schema === 1, r.text.slice(0, 120));
  r = await jfetch(`${SB}/rest/v1/rpc/put_project_artifact`, { method: 'POST', headers: { apikey: ANON, Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_project: PID, p_kind: 'business_state', p_data: { schema: 1 } }) });
  check('the owner cannot write business_state (platform-only)', r.status >= 400, r.text.slice(0, 120));
  r = await jfetch(`${SB}/rest/v1/rpc/vx_business_stats`, { method: 'POST', headers: { apikey: ANON, Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_project: PID }) });
  check('the stats RPC itself is not callable by users', r.status === 401 || r.status === 403, r.status);
} catch (e) {
  fail++; console.log('FAIL exception   [' + (e?.stack || e) + ']');
} finally {
  for (const id of [PID, PID_DRAFT]) await jfetch(`${SB}/rest/v1/projects?id=eq.${id}`, { method: 'DELETE', headers: svc });
  for (const u of Object.values(users)) {
    await jfetch(`${SB}/rest/v1/projects?user_id=eq.${u.id}`, { method: 'DELETE', headers: svc });
    await jfetch(`${SB}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: svc });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
