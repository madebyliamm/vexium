import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SseParser, type SseMessage } from '../src/api/sse.ts';

function parseAll(chunks: string[]): SseMessage[] {
  const p = new SseParser();
  const out: SseMessage[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.flush());
  return out;
}

const STREAM =
  'event: start\ndata: {}\n\n' +
  ': keep-alive comment\n\n' +
  'event: delta\ndata: {"text":"héllo — 🙂"}\n\n' +
  'event: file\ndata: {"name":"index.html","content":"PGgxPg==","encoding":"base64"}\n\n' +
  'event: done\ndata: {"count":1}\n\n';

test('parses event/data blocks and skips comments', () => {
  const got = parseAll([STREAM]);
  assert.deepEqual(got.map((m) => m.event), ['start', 'delta', 'file', 'done']);
  assert.equal(JSON.parse(got[1]!.data).text, 'héllo — 🙂');
});

test('result is identical for every possible split point (LF)', () => {
  const whole = parseAll([STREAM]);
  for (let i = 0; i <= STREAM.length; i++) {
    assert.deepEqual(parseAll([STREAM.slice(0, i), STREAM.slice(i)]), whole, `split at ${i}`);
  }
});

test('result is identical for every possible split point (CRLF, incl. between \\r and \\n)', () => {
  const crlf = STREAM.replace(/\n/g, '\r\n');
  const whole = parseAll([STREAM]);
  for (let i = 0; i <= crlf.length; i++) {
    assert.deepEqual(parseAll([crlf.slice(0, i), crlf.slice(i)]), whole, `split at ${i}`);
  }
});

test('one character at a time', () => {
  assert.deepEqual(parseAll([...STREAM]), parseAll([STREAM]));
});

test('multi-line data is joined with \\n; a missing event name defaults to "message"', () => {
  const got = parseAll(['data: a\ndata: b\n\n']);
  assert.deepEqual(got, [{ event: 'message', data: 'a\nb' }]);
});

test('flush() returns a final block that lacks its terminating blank line', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('event: done\ndata: {"count":2}'), []);
  assert.deepEqual(p.flush(), [{ event: 'done', data: '{"count":2}' }]);
  assert.deepEqual(p.flush(), []);
});

test('strips exactly one leading space after the colon', () => {
  assert.deepEqual(parseAll(['event:x\ndata:  two\n\n']), [{ event: 'x', data: ' two' }]);
});
