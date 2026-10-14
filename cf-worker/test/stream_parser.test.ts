// The stream parser (cf-worker/core.ts, byte-extracted from supabase/functions/ai-chat/index.ts) must produce the same files no matter
// how the model's text is cut into chunks. Regression for Step 5: a closing tag split across two chunks ("…</file" + ">") was
// treated as file content, so every file after it was swallowed into the first one.
//   node --test cf-worker/test/stream_parser.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { makeParse, processStreamBlock } from '../core.ts';

const FILES: Record<string, string> = {
  'styles.css': "@import url('x');\n:root { --bg: #fff; }\nbody { background: var(--bg); }\n</style>\n",
  'index.html': '<!DOCTYPE html>\n<html><body><a href="x">a < b</a> <p>1 </ 2</p></body></html>\n',
  'site.js': 'window.SITE = { name: "A" };\n',
  _longterm: '{"kind":"site"}\n',
};
const MESSAGE = 'Here is the plan. <b>not a tag</b> and a lone < sign.';
const TAIL = '\nAll done — link the pages.';

function modelText(): string {
  return MESSAGE + '\n' + Object.entries(FILES).map(([n, c]) => `<file name="${n}">\n${c}</file>`).join('\n') + TAIL;
}

function run(text: string, sizes: (i: number) => number, existing: Record<string, string> = {}) {
  const state = makeParse(existing);
  const files: Record<string, string> = {};
  const patches: Record<string, string> = {};
  let message = '';
  const handle = (events: ReturnType<typeof processStreamBlock>) => {
    for (const ev of events) {
      if (ev.type === 'file_done') files[ev.name!] = Buffer.from(ev.content!, 'base64').toString('utf8');
      else if (ev.type === 'patch_done' && ev.encoding === 'base64') patches[ev.name!] = Buffer.from(ev.content!, 'base64').toString('utf8');
      else if (ev.type === 'delta') message += ev.text;
    }
  };
  for (let i = 0, n = 0; i < text.length; n++) {
    const len = Math.max(1, sizes(n));
    handle(processStreamBlock(text.slice(i, i + len), state));
    i += len;
  }
  // what streamBuild does at message_stop
  const carry = (state as any)._carry || '';
  if (carry && state.phase === 'message') message += carry;
  return { files, patches, message, state };
}

// Expected file contents: the parser keeps exactly what sits between the tags (including the newline after the opening tag).
const expectedFiles = Object.fromEntries(Object.entries(FILES).map(([n, c]) => [n, '\n' + c]));

describe('stream parser: chunking never changes the result', () => {
  it('whole text in one chunk', () => {
    const r = run(modelText(), () => 1e9);
    assert.deepEqual(r.files, expectedFiles);
    assert.equal(r.message.trim(), (MESSAGE + '\n' + '\n'.repeat(Object.keys(FILES).length - 1) + TAIL).trim());
  });
  it('every fixed chunk size from 1 to 64 characters', () => {
    for (let size = 1; size <= 64; size++) {
      const r = run(modelText(), () => size);
      assert.deepEqual(r.files, expectedFiles, `chunk size ${size}`);
      assert.ok(r.message.includes(MESSAGE) && r.message.includes('All done'), `message at size ${size}`);
    }
  });
  it('2,000 random chunkings (including tags cut at every offset)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 2000; t++) {
      const max = 1 + Math.floor(rnd() * 40);
      const r = run(modelText(), () => 1 + Math.floor(rnd() * max));
      assert.deepEqual(r.files, expectedFiles, `random run ${t}`);
    }
  });
  it('the closing tag split at every possible position', () => {
    const text = modelText();
    for (let cut = 1; cut < text.length; cut++) {
      const state = makeParse({});
      const files: Record<string, string> = {};
      for (const part of [text.slice(0, cut), text.slice(cut)]) {
        for (const ev of processStreamBlock(part, state)) if (ev.type === 'file_done') files[ev.name!] = Buffer.from(ev.content!, 'base64').toString('utf8');
      }
      assert.deepEqual(files, expectedFiles, `cut at ${cut}`);
    }
  });
  it('a split </patch> still applies the patch', () => {
    const base = { 'site.js': 'window.SITE = { nav: [\n  { label: "Home", href: "index.html" }\n] };\n' };
    const text = 'Adding it.\n<patch name="site.js"><insert_after>{ label: "Home", href: "index.html" }</insert_after><content>,\n  { label: "About", href: "about.html" }</content></patch>\nDone.';
    for (let cut = 1; cut < text.length; cut++) {
      const state = makeParse({ ...base });
      const patched: Record<string, string> = {};
      for (const part of [text.slice(0, cut), text.slice(cut)]) {
        for (const ev of processStreamBlock(part, state)) if (ev.type === 'patch_done' && ev.encoding === 'base64') patched[ev.name!] = Buffer.from(ev.content!, 'base64').toString('utf8');
      }
      assert.ok(patched['site.js']?.includes('about.html'), `cut at ${cut}: ${JSON.stringify(patched)}`);
    }
  });
  it('a patch whose opening tags carry a stray quote (<find">) still applies', () => {
    const base = { 'site.js': 'nav: [\n  { label: "Home" }\n]\n' };
    const text = 'Ok.\n<patch name="site.js">\n<find">  { label: "Home" }</find>\n<replace>  { label: "Home" },\n  { label: "About" }</replace>\n</patch>';
    const state = makeParse({ ...base });
    const out: string[] = [];
    for (const ev of processStreamBlock(text, state)) if (ev.type === 'patch_done' && ev.encoding === 'base64') out.push(Buffer.from(ev.content!, 'base64').toString('utf8'));
    assert.equal(out.length, 1);
    assert.ok(out[0].includes('About'), out[0]);
  });
  it('a patch block with no usable operation is reported as failed, never as an unchanged success', () => {
    for (const body of ['', 'just some words', '<find>only a find</find>', '<insert_after>anchor missing</insert_after><content>x</content>']) {
      const state = makeParse({ 'a.html': 'hello' });
      const evs = processStreamBlock(`<patch name="a.html">${body}</patch>`, state).filter((e) => e.type === 'patch_done');
      assert.equal(evs.length, 1, body);
      assert.equal(evs[0].encoding, 'failed', `body ${JSON.stringify(body)}`);
    }
  });
  it('content that merely looks like the start of a closing tag is kept', () => {
    const r = run('<file name="a.html">x </ y < z </fil ok</file>', () => 3);
    assert.equal(r.files['a.html'], 'x </ y < z </fil ok');
  });
  it('an unterminated file keeps the tail that was held back', () => {
    const state = makeParse({});
    processStreamBlock('<file name="a.html">abc</fi', state);
    assert.equal((state as any)._carry, '</fi');
    // streamBuild adds the held-back tail to the partial file at message_stop
    assert.equal(state.curFileContent, 'abc');
  });
});

describe('both parser copies are byte-identical', () => {
  const fn = (src: string, name: string) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} not found`);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 3);
  };
  const core = readFileSync(new URL('../core.ts', import.meta.url), 'utf8');
  const edge = readFileSync(new URL('../../supabase/functions/ai-chat/index.ts', import.meta.url), 'utf8');
  for (const name of ['partialTagTail', 'findDelimiter', 'processStreamBlock', 'makeParse', 'parsePatchOps', 'applyPatches']) {
    it(name, () => assert.equal(fn(core, name), fn(edge, name)));
  }
  it('the message_stop carry flush', () => {
    const grab = (s: string) => s.slice(s.indexOf('const carry = (state as any)._carry'), s.indexOf('finalMessage = state.msgText.trim()'));
    assert.equal(grab(core), grab(edge));
  });
});
