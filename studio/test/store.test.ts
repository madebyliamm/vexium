import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStore } from '../src/lib/store.ts';

test('get/set/update and subscribe', () => {
  const s = createStore(1);
  const seen: [number, number][] = [];
  const off = s.subscribe((v, prev) => seen.push([v, prev]));
  s.set(2);
  s.set((n) => n + 3);
  assert.equal(s.get(), 5);
  assert.deepEqual(seen, [[2, 1], [5, 2]]);
  off();
  s.set(9);
  assert.equal(seen.length, 2);
});

test('setting an identical value does not notify', () => {
  const o = { a: 1 };
  const s = createStore(o);
  let n = 0;
  s.subscribe(() => n++);
  s.set(o);
  s.set(() => o);
  assert.equal(n, 0);
  s.set({ a: 1 }); // new reference → notifies
  assert.equal(n, 1);
});

test('a listener that unsubscribes mid-notification does not break the others', () => {
  const s = createStore(0);
  const calls: string[] = [];
  const offA = s.subscribe(() => { calls.push('a'); offA(); });
  s.subscribe(() => calls.push('b'));
  s.set(1);
  s.set(2);
  assert.deepEqual(calls, ['a', 'b', 'b']);
});
