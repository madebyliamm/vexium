#!/usr/bin/env python3
"""End-to-end publish test against a running Worker (default: wrangler dev on :8787) using a THROWAWAY user/project.
Prod Supabase is used for auth/rows; R2 is whatever the Worker is bound to. Everything created is deleted in `finally`.
Keys are read from files and never printed."""
import base64, json, re, sys, time, urllib.request, urllib.error

WORKER = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8787'
REPO = '/Users/liam/Desktop/vexium/vexium'
SB = 'https://ciuqhxrxcznmgorjeumz.supabase.co'
ANON = re.search(r'SUPABASE_ANON_KEY = "([^"]+)"', open(REPO + '/publisher/wrangler.toml').read()).group(1)
SVC = open(REPO + '/publisher/.dev.vars').read().split('SUPABASE_SERVICE_ROLE_KEY=')[1].strip()

results = []
def check(name, ok, detail=''):
    results.append(ok)
    print(('PASS ' if ok else 'FAIL ') + name + (('   [' + str(detail) + ']') if detail != '' else ''))

def http(method, url, headers=None, body=None, raw=False):
    data = None
    h = dict(headers or {})
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        h.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            b = r.read()
            return r.status, dict((k.lower(), v) for k, v in r.headers.items()), (b if raw else (json.loads(b) if b and 'json' in r.headers.get('content-type', '') else b))
    except urllib.error.HTTPError as e:
        b = e.read()
        try: parsed = json.loads(b)
        except Exception: parsed = b
        return e.code, dict((k.lower(), v) for k, v in e.headers.items()), parsed

svc = {'apikey': SVC, 'Authorization': 'Bearer ' + SVC}
stamp = str(int(time.time()))
email = f'vertly-smoketest-{stamp}@example.com'
username = f'smoketest{stamp}'
password = 'Tt!' + base64.b32encode(SVC[-12:].encode()).decode()[:16] + stamp
pid = f'proj_smoketest_{stamp}'
slug = 'smoke-site'
uid = None

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
def png_url(): return 'data:image/png;base64,' + base64.b64encode(PNG).decode()

def files(tag):
    return {
        'index.html': f'<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Smoke {tag}</h1><img src="logo.png"><a href="about.html">About</a></body></html>',
        'about.html': f'<!doctype html><html><body><h1>About {tag}</h1></body></html>',
        'style.css': 'body{font-family:sans-serif}',
        'logo.png': png_url(),
        '_backend': json.dumps({'collections': {'leads': {'read': 'owner'}}, 'secret': 'SHOULD-NOT-BE-PUBLIC'}),
    }

def site(path, host=None, extra=None):
    h = {'Host': f'{username}.vexium.ai'}
    if host: h = {'x-forwarded-host': host}
    h.update(extra or {})
    return http('GET', WORKER + path, h, raw=True)

try:
    # ── setup (throwaway) ──
    st, _, u = http('POST', SB + '/auth/v1/admin/users', svc, {'email': email, 'password': password, 'email_confirm': True, 'user_metadata': {'username': username}})
    check('setup: throwaway user created', st in (200, 201), st)
    uid = u['id']
    st, _, tok = http('POST', SB + '/auth/v1/token?grant_type=password', {'apikey': ANON}, {'email': email, 'password': password})
    check('setup: user signs in (ES256 token)', st == 200 and 'access_token' in tok, st)
    auth = {'Authorization': 'Bearer ' + tok['access_token']}
    st, _, _ = http('POST', SB + '/rest/v1/projects', {**svc, 'Prefer': 'return=minimal'}, {'id': pid, 'name': 'Smoke Site', 'user_id': uid, 'files': {}, 'main_file': 'index.html'})
    check('setup: throwaway project created', st in (200, 201), st)

    # ── auth rules ──
    st, _, b = http('POST', WORKER + '/__vx/publish', {}, {'projectId': pid, 'files': files('x')})
    check('publish without a token -> 401', st == 401, st)
    other = http('POST', SB + '/auth/v1/admin/users', svc, {'email': f'vertly-smoketest2-{stamp}@example.com', 'password': password, 'email_confirm': True, 'user_metadata': {'username': username + 'b'}})
    uid2 = other[2]['id']
    try:
        st, _, tok2 = http('POST', SB + '/auth/v1/token?grant_type=password', {'apikey': ANON}, {'email': f'vertly-smoketest2-{stamp}@example.com', 'password': password})
        st, _, b = http('POST', WORKER + '/__vx/publish', {'Authorization': 'Bearer ' + tok2['access_token']}, {'projectId': pid, 'files': files('x')})
        check("stranger can't publish someone else's project", st in (403, 404), st)
    finally:
        http('DELETE', SB + f'/auth/v1/admin/users/{uid2}', svc)

    # ── v1 ──
    st, _, b = http('POST', WORKER + '/__vx/publish', auth, {'projectId': pid, 'files': files('ONE'), 'slug': slug})
    check('publish -> version 1', st == 200 and b.get('version') == 1, b if st != 200 else f"v{b.get('version')} {b.get('files')} files {b.get('bytes')}B")
    check('publish stores 4 public files (not _backend)', b.get('files') == 4, b.get('files'))
    s, h, body = site('/' + slug)
    check('v1: index served', s == 200 and b'Smoke ONE' in body, s)
    check('v1: x-vertly-version header = 1', h.get('x-vertly-version') == '1', h.get('x-vertly-version'))
    check('v1: html revalidates (ETag present)', 'etag' in h, h.get('etag'))
    s, h2, body = site('/' + slug + '/logo.png')
    check('image is a REAL png file, not base64', s == 200 and body[:8] == b'\x89PNG\r\n\x1a\n' and h2.get('content-type', '').startswith('image/png'), f"{s} {h2.get('content-type')}")
    s, h3, body = site('/' + slug + '/about.html')
    check('sub-page served', s == 200 and b'About ONE' in body, s)
    s, _, body = site('/' + slug + '/_backend')
    check('_backend is NOT published (404, no secret)', s == 404 and b'SHOULD-NOT' not in body, s)
    s, _, body = site('/' + slug + '/nope.html')
    check('unknown path is a real 404', s == 404, s)
    s, _, body = site('/' + slug, extra={'If-None-Match': h.get('etag', '')})
    check('conditional GET -> 304', s == 304, s)

    # ── v2 ──
    st, _, b = http('POST', WORKER + '/__vx/publish', auth, {'projectId': pid, 'files': files('TWO')})
    check('republish -> version 2 (same slug kept)', st == 200 and b.get('version') == 2 and b.get('slug') == slug, b)
    time.sleep(0.3)
    s, h, body = site('/' + slug)
    check('v2 live', b'Smoke TWO' in body and h.get('x-vertly-version') == '2', h.get('x-vertly-version'))

    # ── rollback ──
    st, _, b = http('POST', WORKER + '/__vx/rollback', auth, {'projectId': pid, 'version': 1})
    check('rollback to v1 accepted', st == 200 and b.get('version') == 1, b)
    s, h, body = site('/' + slug)
    check('v1 live again after rollback', b'Smoke ONE' in body and h.get('x-vertly-version') == '1', h.get('x-vertly-version'))
    st, _, b = http('POST', WORKER + '/__vx/rollback', auth, {'projectId': pid, 'version': 99})
    check('rollback to a version that does not exist -> 404', st == 404, st)

    # ── unpublish ──
    st, _, b = http('POST', WORKER + '/__vx/unpublish', auth, {'projectId': pid})
    check('unpublish accepted', st == 200, b)
    s, _, _ = site('/' + slug)
    check('unpublished site -> 404', s == 404, s)
finally:
    # ── cleanup ──
    if uid:
        http('DELETE', SB + f'/rest/v1/projects?id=eq.{pid}', {**svc, 'Prefer': 'return=minimal'})
        st, _, _ = http('DELETE', SB + f'/auth/v1/admin/users/{uid}', svc)
        print('cleanup: throwaway user deleted' if st in (200, 204) else f'cleanup: user delete returned {st} — CHECK MANUALLY ({uid})')

print(f'\nRESULTS {sum(results)}/{len(results)} passed')
sys.exit(0 if all(results) else 1)
