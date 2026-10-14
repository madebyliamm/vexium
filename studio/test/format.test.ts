import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timeAgo } from '../src/lib/format.ts';

const NOW = Date.parse('2026-10-14T12:00:00Z');

test('timeAgo buckets', () => {
  assert.equal(timeAgo('2026-10-14T11:59:30Z', NOW), 'just now');
  assert.equal(timeAgo('2026-10-14T11:55:00Z', NOW), '5 min ago');
  assert.equal(timeAgo('2026-10-14T09:00:00Z', NOW), '3 h ago');
  assert.equal(timeAgo('2026-10-12T12:00:00Z', NOW), '2 d ago');
  assert.match(timeAgo('2026-01-02T12:00:00Z', NOW), /2026/);
});

test('timeAgo tolerates missing/invalid input and future timestamps', () => {
  assert.equal(timeAgo(null, NOW), '');
  assert.equal(timeAgo(undefined, NOW), '');
  assert.equal(timeAgo('not a date', NOW), '');
  assert.equal(timeAgo('2026-10-14T12:00:30Z', NOW), 'just now');
});
