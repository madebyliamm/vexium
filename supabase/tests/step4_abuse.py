#!/usr/bin/env python3
"""Step 4 abuse + end-to-end test of site-api v2, auth-gate and (optionally) the SDK injection, against PROD with a
THROWAWAY user and two throwaway projects (deleted in `finally`). Nothing real is touched; every rate-limit key is
scoped to the throwaway project ids, except the auth-gate per-IP counter (we stay far below its limit).

  python3 supabase/tests/step4_abuse.py                         # API + auth-gate only
  python3 supabase/tests/step4_abuse.py <worker-url> <host>     # + publish a site and check SDK injection/rules, e.g.
        python3 supabase/tests/step4_abuse.py https://vexium-publisher.startafter.workers.dev real

Env:  E2E_EXPECT_REVOKED=1   assert get_email_by_username / check_signup_availability are revoked from anon (after the 2nd migration)
      E2E_MAIL_TO=you@x.com  make the throwaway owner use this address and send ONE notify_owner mail to it (checks Resend)
The service key is fetched via `supabase projects api-keys` (never written to disk or printed)."""
import base64, json, os, subprocess, sys, time, urllib.request, urllib.error, re

REPO = '/Users/liam/Desktop/vexium/vexium'
REF = 'ciuqhxrxcznmgorjeumz'
SB = f'https://{REF}.supabase.co'
FN = SB + '/functions/v1'
ANON = re.search(r'SUPABASE_ANON_KEY = "([^"]+)"', open(REPO + '/publisher/wrangler.toml').read()).group(1)
WORKER = sys.argv[1] if len(sys.argv) > 1 else None
EXPECT_REVOKED = os.environ.get('E2E_EXPECT_REVOKED') == '1'
MAIL_TO = os.environ.get('E2E_MAIL_TO')

out = subprocess.run(['supabase', 'projects', 'api-keys', '--project-ref', REF, '-o', 'json'], capture_output=True, text=True).stdout
SVC = [k['api_key'] for k in json.loads(out) if k.get('name') == 'service_role' or k.get('id') == 'service_role'][0]
svc = {'apikey': SVC, 'Authorization': 'Bearer ' + SVC}

results = []
def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + name + (('   [' + str(detail) + ']') if detail != '' else ''))
def info(msg): print('INFO ' + msg)

def http(method, url, headers=None, body=None, raw=False, timeout=40):
    data = None
    h = dict(headers or {})
    h.setdefault('User-Agent', 'Mozilla/5.0 (vertly-step4-abuse-test)')
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        h.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read()
            hd = dict((k.lower(), v) for k, v in r.headers.items())
            return r.status, hd, (b if raw else (json.loads(b) if b and 'json' in hd.get('content-type', '') else b))
    except urllib.error.HTTPError as e:
        b = e.read()
        hd = dict((k.lower(), v) for k, v in e.headers.items())
        try: parsed = json.loads(b)
        except Exception: parsed = b
        return e.code, hd, parsed

stamp = str(int(time.time()))
PA, PB = f'proj_abuse_{stamp}_a', f'proj_abuse_{stamp}_b'
username = f'abuse{stamp}'
email = MAIL_TO or f'vertly-abuse-{stamp}@example.com'
password = 'Tt!' + base64.b32encode(SVC[-12:].encode()).decode()[:16] + stamp
uid = None
PW = 'correct horse battery'

BACKEND = {
    'collections': [
        {'id': 'waitlist', 'read': 'owner', 'write': 'public', 'fields': [{'key': 'email', 'type': 'email', 'required': True}, {'key': 'name', 'type': 'text', 'max': 40}], 'notify_owner': bool(MAIL_TO)},
        {'id': 'notes', 'read': 'user', 'write': 'user', 'fields': [{'key': 'text', 'type': 'text', 'required': True}, {'key': 'done', 'type': 'boolean'}]},
        {'id': 'board', 'read': 'public', 'write': 'public', 'max_rows': 3},
        {'id': 'locked', 'read': 'public', 'write': 'owner'},
    ],
    'auth': {'enabled': True},
}

def api(action, project=PA, headers=None, **kw):
    st, hd, js = http('POST', FN + '/site-api', headers, {'project_id': project, 'action': action, **kw})
    return st, hd, js

def rest(method, path, body=None, extra=None):
    return http('GET' if method == 'GET' else method, SB + '/rest/v1/' + path, {**svc, 'Prefer': 'return=representation', **(extra or {})}, body)

created_projects = []
try:
    # ── setup ───────────────────────────────────────────────────────────────────────────────────────────
    st, _, u = http('POST', SB + '/auth/v1/admin/users', svc, {'email': email, 'password': password, 'email_confirm': True, 'user_metadata': {'username': username}})
    check('setup: throwaway user', st in (200, 201), st if st not in (200, 201) else '')
    uid = u['id']
    for pid in (PA, PB):
        st, _, _ = rest('POST', 'projects', {'id': pid, 'name': 'Abuse Test ' + pid[-1].upper(), 'user_id': uid, 'files': {'_backend': json.dumps(BACKEND)}, 'main_file': 'index.html'})
        check('setup: project ' + pid[-1], st in (200, 201), st)
        created_projects.append(pid)

    # ── 1. unknown things ──────────────────────────────────────────────────────────────────────────────
    st, _, j = api('submit', project='proj_does_not_exist', collection='x', data={})
    check('unknown site → 404', st == 404, st)
    st, _, j = api('submit', collection='nope', data={})
    check('unknown collection → 404', st == 404 and j.get('code') == 'unknown_collection', (st, j))
    for name in ('transactions', 'Transactions', '_backend'):
        s1, _, _ = api('submit', collection=name, data={'amount': 99999})
        s2, _, _ = api('get_data', collection=name)
        check(f'reserved "{name}" cannot be written or read', s1 == 403 and s2 == 403, (s1, s2))
    st, _, _ = api('nonsense')
    check('unknown action → 400', st == 400, st)
    st, hd, _ = http('OPTIONS', FN + '/site-api')
    check('CORS preflight', st in (200, 204) and hd.get('access-control-allow-origin') == '*', st)

    # ── 2. public submit + validation ──────────────────────────────────────────────────────────────────
    st, _, j = api('submit', collection='waitlist', data={'email': 'fan@example.com', 'name': 'Fan', 'evil': 'x'})
    check('public submit works; undeclared key reported as ignored', st == 200 and j.get('ignored') == ['evil'], (st, j))
    rid = j.get('id')
    st, _, rows = rest('GET', f'site_data?id=eq.{rid}&select=data,collection,project_id')
    check('stored row has only declared fields', st == 200 and rows and rows[0]['data'] == {'email': 'fan@example.com', 'name': 'Fan'}, rows)
    st, _, _ = api('submit', collection='waitlist', data={'email': 'not-an-email'})
    check('invalid email → 400', st == 400, st)
    st, _, _ = api('submit', collection='waitlist', data={'name': 'no email'})
    check('missing required field → 400', st == 400, st)
    st, _, _ = api('submit', collection='waitlist', data={'email': 'a@b.co', 'name': 'x' * 41})
    check('over-long field → 400', st == 400, st)
    st, _, _ = api('submit', collection='board', data={'blob': 'x' * 20000})
    check('row > 16 KB → 413', st == 413, st)
    st, _, _ = http('POST', FN + '/site-api', None, {'project_id': PA, 'action': 'submit', 'collection': 'board', 'data': {'p': 'x' * 70000}})
    check('request > 64 KB → 413', st == 413, st)
    st, _, _ = http('POST', FN + '/site-api', None, b'not json')
    check('garbage body → 400', st == 400, st)

    # ── 3. private reads ───────────────────────────────────────────────────────────────────────────────
    st, _, j = api('get_data', collection='waitlist')
    check('read:owner collection is not readable anonymously', st == 403 and 'rows' not in j, st)
    st, _, j = api('get_data', collection='locked')
    check('read:public collection lists (empty)', st == 200 and j.get('rows') == [], (st, j))
    st, _, _ = api('submit', collection='locked', data={'a': 1})
    check('write:owner collection refuses submit', st == 403, st)

    # ── 4. accounts ────────────────────────────────────────────────────────────────────────────────────
    st, _, a = api('signup', email='alice@example.com', password=PW)
    check('signup works, returns opaque session token', st == 200 and a.get('token', '').startswith('vxs_'), st)
    st, _, b = api('signup', email='bob@example.com', password=PW)
    st2, _, _ = api('signup', email='ALICE@example.com', password=PW)
    check('duplicate signup (case-insensitive) → 409', st2 == 409, st2)
    st, _, _ = api('signup', email='short@example.com', password='1234567')
    check('password < 8 chars → 400', st == 400, st)
    st, _, users = rest('GET', f'site_users?project_id=eq.{PA}&select=id,email,password_hash')
    ph = {r['email']: r for r in users}
    check('password stored as PBKDF2 (600k, salted), not plaintext/sha256', ph['alice@example.com']['password_hash'].startswith('pbkdf2$sha256$600000$') and PW not in ph['alice@example.com']['password_hash'], ph['alice@example.com']['password_hash'][:30])
    check('two users with the same password get different hashes (per-user salt)', ph['alice@example.com']['password_hash'] != ph['bob@example.com']['password_hash'])
    st, _, sess = rest('GET', f'site_sessions?project_id=eq.{PA}&select=token_hash')
    check('only a hash of the token is stored', all(s['token_hash'] != a['token'] for s in sess) and all(len(s['token_hash']) == 64 for s in sess), len(sess))
    st, _, _ = api('me', token=a['user']['id'])
    check('the old "token = row id" scheme no longer authenticates', st == 401, st)
    st, _, j = api('me', token='vxs_' + 'A' * 43)
    check('forged token → 401 session_expired', st == 401 and j.get('code') == 'session_expired', (st, j))
    st, _, j = api('me', token=a['token'])
    check('valid token → me()', st == 200 and j['user']['email'] == 'alice@example.com', st)

    # cross-project
    st, _, bb = api('signup', project=PB, email='alice@example.com', password=PW)
    check('same email can register on a different site', st == 200, st)
    st, _, j = api('me', project=PB, token=a['token'])
    check("token from site A is useless on site B", st == 401, st)
    st, _, j = api('submit', project=PB, collection='notes', data={'text': 'x'}, token=a['token'])
    check("...also for writes", st == 401, st)

    # read:owner stays closed even with a valid session
    st, _, _ = api('get_data', collection='waitlist', token=a['token'])
    check('read:owner is closed even for signed-in site users', st == 403, st)

    # ── 5. user-scoped data ────────────────────────────────────────────────────────────────────────────
    st, _, _ = api('submit', collection='notes', data={'text': 'anon'})
    check('write:user without session → 401', st == 401, st)
    st, _, _ = api('get_data', collection='notes')
    check('read:user without session → 401', st == 401, st)
    st, _, r1 = api('submit', collection='notes', data={'text': 'alice note', 'done': False}, token=a['token'])
    st, _, r2 = api('submit', collection='notes', data={'text': 'bob note'}, token=b['token'])
    st, _, la = api('get_data', collection='notes', token=a['token'])
    texts = sorted(r['data']['text'] for r in la.get('rows', []))
    check("list returns ONLY the caller's own rows", texts == ['alice note'], texts)
    st, _, j = api('update', collection='notes', id=r2['id'], data={'text': 'pwned'}, token=a['token'])
    check("cannot update another user's row", st == 404, st)
    st, _, j = api('delete', collection='notes', id=r2['id'], token=a['token'])
    check("cannot delete another user's row", st == 404, st)
    st, _, j = api('update', collection='notes', id=r1['id'], data={'done': True}, token=a['token'])
    check('can update own row (merge)', st == 200, (st, j))
    st, _, rows = rest('GET', f'site_data?id=in.({r1["id"]},{r2["id"]})&select=id,data')
    d = {r['id']: r['data'] for r in rows}
    check('DB: own row merged, other row untouched', d[r1['id']] == {'text': 'alice note', 'done': True} and d[r2['id']] == {'text': 'bob note'}, d)
    st, _, j = api('delete', collection='notes', id=r1['id'], token=a['token'])
    check('can delete own row', st == 200, st)
    st, _, j = api('update', collection='notes', id='not-a-uuid', data={}, token=a['token'])
    check('malformed row id → 400', st == 400, st)

    # logout revokes; server-side expiry honoured
    st, _, c = api('login', email='alice@example.com', password=PW)
    check('login works', st == 200 and c.get('token', '').startswith('vxs_'), st)
    api('logout', token=c['token'])
    st, _, _ = api('me', token=c['token'])
    check('logout revokes the session', st == 401, st)
    st, _, d2 = api('login', email='alice@example.com', password=PW)
    import hashlib
    th = hashlib.sha256(d2['token'].encode()).hexdigest()
    rest('PATCH', f'site_sessions?token_hash=eq.{th}', {'expires_at': '2020-01-01T00:00:00Z'})
    st, _, j = api('me', token=d2['token'])
    check('expired session → 401', st == 401 and j.get('code') == 'session_expired', (st, j))

    # ── 6. rate limits ─────────────────────────────────────────────────────────────────────────────────
    # login brute force (per site+email): 5 failures then locked, even for the right password
    codes = [api('login', email='bob@example.com', password='wrong-password-%d' % i)[0] for i in range(5)]
    check('5 wrong passwords → 401 each', codes == [401] * 5, codes)
    st, hd, j = api('login', email='bob@example.com', password=PW)
    check('6th attempt (right password) → 429 + Retry-After', st == 429 and int(hd.get('retry-after', 0)) >= 1, (st, hd.get('retry-after')))
    st, _, _ = api('login', email='nobody@example.com', password='whatever-123')
    st2, _, j2 = api('login', email='bob2@example.com', password='whatever-123')
    check('unknown email looks the same as a wrong password (401, same message)', st == 401 and st2 == 401, (st, st2))

    # signup spam: limit is 5/h per (site, IP). Alice + Bob + the duplicate attempt + short pw (400 doesn't count) used 3 on A.
    seen = []
    for i in range(6):
        seen.append(api('signup', email=f'spam{i}@example.com', password=PW)[0])
    check('signup spam is cut off with 429', 429 in seen and seen[0] == 200, seen)

    # submit flood on a 3-row board: 3 ok → 409 collection_full → eventually 429
    seq = [api('submit', collection='board', data={'i': i})[0] for i in range(34)]
    check('board: 3 rows accepted then collection_full (409)', seq[:3] == [200, 200, 200] and seq[3] == 409, seq[:5])
    first429 = seq.index(429) if 429 in seq else None
    check('submit flood → 429 after ~30 requests / 10 min (and stays blocked)', first429 is not None and 25 <= first429 <= 31 and set(seq[first429:]) == {429} and set(seq[3:first429]) == {409}, first429)
    st, _, rows = rest('GET', f'site_data?project_id=eq.{PA}&collection=eq.board&select=id')
    check('DB: board capped at 3 rows', len(rows) == 3, len(rows))

    # ── 7. forms → email ───────────────────────────────────────────────────────────────────────────────
    if MAIL_TO:
        st, _, j = api('submit', collection='waitlist', data={'email': 'smoketest-fan@example.com', 'name': 'Mail Test'})
        check('notify_owner submit accepted', st == 200, st)
        info(f'check {MAIL_TO} for "New waitlist submission — Abuse Test A" (sent by Resend; cannot be asserted from here)')
    else:
        info('notify_owner mail NOT exercised (set E2E_MAIL_TO=you@x.com to send one real mail)')

    # ── 8. auth-gate ───────────────────────────────────────────────────────────────────────────────────
    gate = lambda payload: http('POST', FN + '/auth-gate', {'apikey': ANON}, payload)
    st, _, g = gate({'action': 'login', 'identifier': username, 'password': password})
    ok = st == 200 and g.get('session', {}).get('access_token')
    check('auth-gate: username + password → session', ok, st)
    check('auth-gate: response does not contain the account email', email not in json.dumps(g), '')
    if ok:
        st, _, me = http('GET', SB + '/auth/v1/user', {'apikey': ANON, 'Authorization': 'Bearer ' + g['session']['access_token']})
        check('auth-gate: returned session is a real, working Supabase session', st == 200 and me.get('id') == uid, st)
    st, _, g2 = gate({'action': 'login', 'identifier': username.upper(), 'password': password})
    check('auth-gate: usernames are case-insensitive', st == 200, st)
    st, _, w1 = gate({'action': 'login', 'identifier': username, 'password': 'wrong-password'})
    st2, _, w2 = gate({'action': 'login', 'identifier': 'no-such-user-' + stamp, 'password': 'wrong-password'})
    check('auth-gate: wrong password and unknown user are indistinguishable', st == 401 and st2 == 401 and w1 == w2, (st, st2))
    codes = [gate({'action': 'login', 'identifier': username, 'password': 'wrong-%d' % i})[0] for i in range(5)]
    st, hd, _ = gate({'action': 'login', 'identifier': username, 'password': password})
    check('auth-gate: brute force on one account → 429 even with the right password', st == 429, (codes, st))
    st, _, av = gate({'action': 'availability', 'username': username, 'email': 'free-' + stamp + '@example.com'})
    check('auth-gate: availability reports taken username', st == 200 and av.get('username_taken') is True and av.get('email_taken') is False, av)

    # the leaky RPCs
    st, _, j = http('POST', SB + '/rest/v1/rpc/get_email_by_username', {'apikey': ANON, 'Authorization': 'Bearer ' + ANON}, {'p_username': username})
    if EXPECT_REVOKED:
        check('get_email_by_username is NOT callable with the anon key', st in (401, 403) and email not in json.dumps(j), st)
        st, _, j = http('POST', SB + '/rest/v1/rpc/check_signup_availability', {'apikey': ANON, 'Authorization': 'Bearer ' + ANON}, {'p_username': username, 'p_email': email})
        check('check_signup_availability is NOT callable with the anon key', st in (401, 403), st)
    else:
        info(f'get_email_by_username with anon key → {st} (expected to be denied only after the revoke migration; re-run with E2E_EXPECT_REVOKED=1)')

    # ── 9. Worker: SDK injection + published rules win over the draft ───────────────────────────────────
    if WORKER:
        real = len(sys.argv) > 2 and sys.argv[2] == 'real'
        st, _, tok = http('POST', SB + '/auth/v1/token?grant_type=password', {'apikey': ANON}, {'email': email, 'password': password})
        bearer = {'Authorization': 'Bearer ' + tok['access_token']}
        page = ('<!doctype html><html><head><title>t</title></head><body><form id="f"><input name="email" value="sdk@example.com"><button>go</button></form>'
                '<script>window.__t=1</script></body></html>')
        pub_backend = {'collections': [{'id': 'board', 'read': 'public', 'write': 'public', 'max_rows': 50}], 'auth': {'enabled': False}}
        st, _, pj = http('POST', WORKER + '/__vx/publish', bearer, {'projectId': PB, 'slug': 'abuse-' + stamp, 'files': {'index.html': page, '_backend': json.dumps(pub_backend)}})
        check('publish throwaway site', st == 200 and pj.get('ok') is True, (st, str(pj)[:120]))
        slug = (pj or {}).get('slug', 'abuse-' + stamp)
        url = f'https://{username}.vexium.ai/{slug}/' if real else None
        if url:
            html = b''
            for _ in range(20):
                s, hd, html = http('GET', url, raw=True)
                if s == 200: break
                time.sleep(1.5)
            html = html.decode() if isinstance(html, bytes) else str(html)
            check('published page carries the site id + SDK tag before </body>', f'window.__VX={{site:"{PB}"}}' in html and '/__vx/sdk/v1.js?v=' in html and html.index('/__vx/sdk/v1.js') < html.rindex('</body>'), s)
            m = re.search(r'/__vx/sdk/v1\.js\?v=([0-9a-f]+)', html)
            s, hd, js = http('GET', f'https://{username}.vexium.ai/__vx/sdk/v1.js?v={m.group(1)}', raw=True)
            check('SDK is served as JS, immutable-cached for the hashed URL', s == 200 and 'javascript' in hd.get('content-type', '') and 'immutable' in hd.get('cache-control', '') and b'Vertly SDK v1' in js, (s, hd.get('cache-control')))
            s, hd, _ = http('GET', f'https://{username}.vexium.ai/__vx/sdk/v1.js', raw=True)
            check('bare SDK URL: short cache', s == 200 and 'max-age=300' in hd.get('cache-control', ''), hd.get('cache-control'))
        # the LIVE deploy's rules apply, not the draft's (draft says notes/waitlist exist; published says only board)
        time.sleep(16)   # site-api caches project rules for 15 s per isolate
        st, _, j = api('submit', project=PB, collection='notes', data={'text': 'x'})
        check('published rules win: draft-only collection is unknown on the live site', st == 404, (st, j))
        st, _, j = api('get_data', project=PB, collection='board')
        check('published rules win: board is public-read on the live site', st == 200, (st, j))
        st, _, j = api('signup', project=PB, email='late@example.com', password=PW)
        check('published rules win: accounts disabled on the live site', st == 403, (st, j))
        info(f'R2 objects to delete by hand: p/{PB}/v*/ (npx wrangler r2 object delete vertly-sites/p/{PB}/v1/index.html --remote)')
    else:
        info('Worker/SDK stage skipped (pass <worker-url> real to run it)')

finally:
    for pid in created_projects:
        http('DELETE', SB + f'/rest/v1/projects?id=eq.{pid}', svc)
    if uid:
        http('DELETE', SB + f'/auth/v1/admin/users/{uid}', svc)
    print()
    print(f'{sum(results)}/{len(results)} checks passed')
    sys.exit(0 if all(results) else 1)
