#!/usr/bin/env node
// Step 13 (chunk C) live evidence: the deployed `business-partner` function against the REAL database, with throwaway users + projects.
//   node scripts/step13_partner_e2e.mjs                 who may ask, the "not enough data" answer, the real Anthropic path (it needs credit:
//                                                       an out-of-credit account must come back as a polite 503 that never mentions credit)
//   E2E_MOCK=1 node scripts/step13_partner_e2e.mjs      the full flow with a stand-in model — first deploy the mock and point the function at it
//                                                       (docs/INFRA.md "Testing the business partner"); ALWAYS unset the secret afterwards
// Needs the `supabase` CLI logged in (service key). Everything created is deleted in `finally`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const REF = 'ciuqhxrxcznmgorjeumz';
const SB = `https://${REF}.supabase.co`;
const MOCK = process.env.E2E_MOCK === '1';
const ANON = /SUPABASE_ANON_KEY = '([^']+)'/.exec(readFileSync(join(REPO, 'config.js'), 'utf8'))[1];
const UA = { 'User-Agent': 'Mozilla/5.0 (vertly-partner-e2e)' };
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
const password = 'Ptn-e2e-' + rand + '!9';
const users = {};
const pids = [];
const iso = (daysAgo, h = 12) => new Date(Date.now() - daysAgo * 86400e3 + (h - 12) * 3600e3).toISOString();

async function mkUser(tag) {
  const username = `vxptn${tag}${rand}`, email = `${username}@vexium.ai`;
  let r = await jfetch(SB + '/auth/v1/admin/users', { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { username } }) });
  if (r.status >= 300) throw new Error('create user ' + r.text);
  const id = r.json.id;
  r = await jfetch(SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.json?.access_token) throw new Error('sign in ' + r.text);
  users[tag] = { id, username, token: r.json.access_token };
}
const fn = (name, token, body) => jfetch(`${SB}/functions/v1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
const numbers = (token, pid, extra = {}) => fn('business-state', token, { project_id: pid, ...extra });
const partner = (token, pid) => fn('business-partner', token, { project_id: pid });
const used = async (uid) => (await jfetch(`${SB}/rest/v1/account_billing?user_id=eq.${uid}&select=credits_used_cents`, { headers: svc })).json?.[0]?.credits_used_cents ?? 0;

/** A live project; `visitors` distinct visitors over the last 9 days; first deploy `liveDays` ago. */
async function mkProject(tag, name, { visitors = 60, liveDays = 10, plan = true } = {}) {
  const pid = `vxptn_${rand}_${tag}`;
  pids.push(pid);
  const owner = users.o;
  await post('projects', { id: pid, user_id: owner.id, name, files: {}, main_file: 'index.html', published_slug: `ptn-${tag}-${rand}`, published_version: 1, published_at: iso(liveDays), stage: 'business' });
  await post('project_deploys', { project_id: pid, version: 1, status: 'ready', created_by: owner.id, created_at: iso(liveDays) });
  if (plan) await jfetch(`${SB}/rest/v1/rpc/put_project_artifact`, { method: 'POST', headers: { ...svc, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_project: pid, p_kind: 'plan', p_data: {
    schema: 1, name, kind: 'site', one_liner: 'Small-batch coffee beans by post', audience: 'home brewers', offer: 'Beans', pricing: { model: 'one_time', items: [] }, pages: [{ file: 'index.html', title: 'Home', purpose: 'x' }],
    backend: { collections: [], products: ['beans'], forms: [], auth: false }, launch_checklist: [], scenario: { price_cents: 2000, monthly_visitors: 300, conversion_pct: 2 } } }) });
  const views = [];
  for (let i = 0; i < visitors; i++) views.push({ project_id: pid, page: i % 3 ? '/' : '/shop.html', referrer: i % 2 ? 'https://www.google.com/' : '', device: i % 4 ? 'mobile' : 'desktop', session_id: 's' + i, visitor_id: 'v' + i, ts: iso(1 + (i % 9), 8 + (i % 8)) });
  if (views.length) await post('page_views', views);
  if (visitors >= 50) await post('site_data', [
    { project_id: pid, collection: 'transactions', data: { type: 'sale', amount: 20, currency: 'usd', status: 'paid', description: 'Beans' }, created_at: iso(2) },
    { project_id: pid, collection: 'transactions', data: { type: 'sale', amount: 20, currency: 'usd', status: 'paid', description: 'Beans' }, created_at: iso(3) },
  ]);
  return pid;
}

try {
  await mkUser('o'); await mkUser('s');
  const owner = users.o;
  const PID = await mkProject('main', 'Beanery');
  const DRAFT = `vxptn_${rand}_draft`; pids.push(DRAFT);
  await post('projects', { id: DRAFT, user_id: owner.id, name: 'Draft', files: {} });
  const EARLY = await mkProject('early', 'Young site', { visitors: 12, liveDays: 2 });

  // ── who may ask ──
  let r = await partner(null, PID);
  check('no token → 401', r.status === 401, r.text);
  r = await partner(ANON, PID);
  check('the anon key is not a user → 401', r.status === 401, r.text);
  r = await partner(users.s.token, PID);
  check("somebody else's project → 404", r.status === 404, r.text);
  r = await partner(owner.token, 'vxptn_does_not_exist');
  check('a missing project → the same 404', r.status === 404 && r.text === (await partner(users.s.token, PID)).text, r.text);
  r = await partner(owner.token, DRAFT);
  check('a never-published project → 409 not_live', r.status === 409 && r.json?.error === 'not_live', r.text);
  r = await fn('business-partner', owner.token, {});
  check('project_id is required → 400', r.status === 400, r.text);
  r = await jfetch(`${SB}/functions/v1/business-partner`, { method: 'GET', headers: { apikey: ANON, Authorization: 'Bearer ' + owner.token } });
  check('GET is refused', r.status === 405, r.status);

  // ── the numbers must be opened first ──
  r = await partner(owner.token, PID);
  check('no saved numbers yet → 409 no_state', r.status === 409 && r.json?.error === 'no_state', r.text);

  // ── too little data: answered without a model ──
  r = await numbers(owner.token, EARLY);
  check('the early project has numbers (level early/none)', r.status === 200 && ['early', 'none'].includes(r.json?.state?.data_level), r.json?.state?.data_level);
  const before = await used(owner.id);
  r = await partner(owner.token, EARLY);
  check('a young site → "not enough data", plain sentence, no model', r.status === 200 && r.json?.status === 'not_enough_data' && /50 visitors|nothing to go on/.test(r.json?.message ?? ''), r.text);
  check('…and it costs nothing', (await used(owner.id)) === before, `${before} → ${await used(owner.id)}`);

  // ── a site with enough data ──
  r = await numbers(owner.token, PID);
  check('the main project is "ok"', r.json?.state?.data_level === 'ok', r.json?.state?.data_level);
  const stateVersion = r.json?.version;

  if (!MOCK) {
    // The real Anthropic path. With an empty account it must come back as a polite 503 and never mention credit; with credit it is real advice.
    r = await partner(owner.token, PID);
    if (r.status === 503) {
      check('real model, account out of credit → polite 503 that does not mention credit/billing/keys', r.json?.error === 'ai_unavailable' && !/credit|balance|billing|api key|anthropic/i.test(r.text), r.text);
    } else {
      check('real model answered (credit is available): 200 with a list', r.status === 200 && r.json?.status === 'ok' && Array.isArray(r.json?.advice?.recommendations), r.text);
      console.log('NOTE real model advice:', JSON.stringify(r.json?.advice));
    }
  } else {
    const c0 = await used(owner.id);
    r = await partner(owner.token, PID);
    const adv = r.json?.advice;
    check('mock model → 200 ok with advice', r.status === 200 && r.json?.status === 'ok' && !!adv, r.text);
    check('advice names the numbers version it was made from', adv?.state_version === stateVersion, `${adv?.state_version} vs ${stateVersion}`);
    check('two recommendations, in order', adv?.recommendations?.map((x) => x.id).join() === 'stand-out,share-more', adv?.recommendations?.map((x) => x.id).join());
    const first = adv?.recommendations?.[0];
    check('the first can be applied to the site', typeof first?.apply === 'string' && /mock-accent/.test(first.apply), first?.apply);
    check('its evidence is the state\'s own lines (60 visitors, 2 orders)', first?.evidence?.some((e) => e.id === 'visitors' && /Visitors: 60/.test(e.text)) && first.evidence.some((e) => e.id === 'orders' && /Orders: 2/.test(e.text)), JSON.stringify(first?.evidence));
    check('its reasoning quotes the real numbers', /60 visitors and 2 orders/.test(first?.why ?? ''), first?.why);
    check('the second step is not a site edit', adv?.recommendations?.[1]?.apply === null, adv?.recommendations?.[1]?.apply);
    check('no email address in the answer', !r.text.includes('@'), '');
    const c1 = await used(owner.id);
    check('the owner was billed what the function says', c1 - c0 === r.json?.cents, `${c0} → ${c1}, said ${r.json?.cents}`);

    const INVENT = await mkProject('inv', 'Beanery mock-invent');
    await numbers(owner.token, INVENT);
    r = await partner(owner.token, INVENT);
    check('a made-up goal ("5000 visitors", "400%") is dropped by the platform', r.status === 200 && r.json?.advice?.recommendations?.map((x) => x.id).join() === 'stand-out,share-more', r.json?.advice?.recommendations?.map((x) => x.id).join());

    const PROSE = await mkProject('prose', 'Beanery mock-nojson');
    await numbers(owner.token, PROSE);
    r = await partner(owner.token, PROSE);
    check('a reply that is not usable → ok with an empty list (never prose)', r.status === 200 && r.json?.status === 'ok' && r.json.advice.recommendations.length === 0, r.text);

    const NOCREDIT = await mkProject('nocredit', 'Beanery mock-credit');
    await numbers(owner.token, NOCREDIT);
    r = await partner(owner.token, NOCREDIT);
    check('the provider being out of credit → polite 503, no mention of it', r.status === 503 && r.json?.error === 'ai_unavailable' && !/credit|balance|billing|anthropic/i.test(r.text), r.text);

    // ── out of numbers freshness: an old saved state ──
    await jfetch(`${SB}/rest/v1/project_artifacts?project_id=eq.${PID}&kind=eq.business_state`, { method: 'PATCH', headers: J, body: JSON.stringify({ data: { ...(await jfetch(`${SB}/rest/v1/project_artifacts?project_id=eq.${PID}&kind=eq.business_state&select=data&order=version.desc&limit=1`, { headers: svc })).json[0].data, computed_at: iso(1) } }) });
    r = await partner(owner.token, PID);
    check('numbers older than half an hour → 409 state_old (the studio refreshes them)', r.status === 409 && r.json?.error === 'state_old', r.text);
    await numbers(owner.token, PID, { refresh: true });

    // ── out of credits ──
    const bill = await jfetch(`${SB}/rest/v1/account_billing?user_id=eq.${owner.id}&select=plan,credits_used_cents`, { headers: svc });
    await jfetch(`${SB}/rest/v1/account_billing?user_id=eq.${owner.id}`, { method: 'PATCH', headers: J, body: JSON.stringify({ credits_used_cents: 100000 }) });
    r = await partner(owner.token, PID);
    check('out of credits → 402 usage_limit, no model', r.status === 402 && r.json?.error === 'usage_limit', r.text);
    await jfetch(`${SB}/rest/v1/account_billing?user_id=eq.${owner.id}`, { method: 'PATCH', headers: J, body: JSON.stringify({ credits_used_cents: bill.json?.[0]?.credits_used_cents ?? 0 }) });

    // ── rate limit: 12 an hour ──
    let last = null, n = 0;
    for (; n < 16; n++) { last = await partner(owner.token, PID); if (last.status === 429) break; }
    check('too many asks in an hour → 429 with retry_after', last?.status === 429 && typeof last.json?.retry_after === 'number', `${n} asks, last ${last?.status}`);
  }
} catch (e) {
  fail++; console.log('FAIL exception   [' + (e?.stack || e) + ']');
} finally {
  for (const id of pids) await jfetch(`${SB}/rest/v1/projects?id=eq.${id}`, { method: 'DELETE', headers: svc });
  for (const u of Object.values(users)) {
    await jfetch(`${SB}/rest/v1/projects?user_id=eq.${u.id}`, { method: 'DELETE', headers: svc });
    await jfetch(`${SB}/rest/v1/rate_limits?key=eq.${encodeURIComponent('partner:' + u.id)}`, { method: 'DELETE', headers: svc });
    await jfetch(`${SB}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: svc });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
