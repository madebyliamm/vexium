import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, matchPattern, parseHash, resolveRoute, type Route } from '../src/lib/router.ts';

test('parseHash normalises paths and reads the query', () => {
  assert.equal(parseHash('').path, '/');
  assert.equal(parseHash('#').path, '/');
  assert.equal(parseHash('#/p/abc/').path, '/p/abc');
  assert.equal(parseHash('#//p///abc').path, '/p/abc');
  assert.equal(parseHash('#p/abc').path, '/p/abc');
  const l = parseHash('#/p/abc?tab=plan&x=1');
  assert.equal(l.path, '/p/abc');
  assert.equal(l.query.get('tab'), 'plan');
});

test('matchPattern: exact segments, :params, decoding, no partial matches', () => {
  assert.deepEqual(matchPattern('/', '/'), {});
  assert.deepEqual(matchPattern('/p/:id', '/p/a%20b'), { id: 'a b' });
  assert.equal(matchPattern('/p/:id', '/p'), null);
  assert.equal(matchPattern('/p/:id', '/p/a/b'), null);
  assert.equal(matchPattern('/system', '/other'), null);
  assert.equal(matchPattern('/p/:id', '/p/%E0%A4%A'), null); // malformed escape → no match, no throw
});

test('resolveRoute picks the first matching route', () => {
  const routes: Route<string>[] = [
    { pattern: '/', view: 'home' },
    { pattern: '/p/:id', view: 'project' },
    { pattern: '/p/new', view: 'never' },
  ];
  assert.equal(resolveRoute(routes, '/')?.route.view, 'home');
  assert.deepEqual(resolveRoute(routes, '/p/new')?.params, { id: 'new' });
  assert.equal(resolveRoute(routes, '/nope'), null);
});

test('link fills and encodes params', () => {
  assert.equal(link('/p/:id', { id: 'a b/c' }), '#/p/a%20b%2Fc');
  assert.equal(link('/system'), '#/system');
});
