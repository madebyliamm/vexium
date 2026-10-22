import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StageDone } from '../src/api/ai.ts';
import type { PickedElement } from '../src/lib/preview.ts';
import {
  DEVICES, TWEAK_HISTORY, fitScale, changeSummary, changedPages, draftNote, historyState, ideasFor, moveNotice, newestFirst, pointedLabel, pointedName, readVersions, sameFiles, tweakHistory,
  tweakOutcome, tweaksBlocker, versionLine, type Version,
} from '../src/lib/tweaks-view.ts';

const el = (tag: string, text = '', page = 'index.html'): PickedElement => ({ page, selector: tag, tag, text, html: `<${tag}>${text}</${tag}>` });
const row = (seq: number, over: Record<string, unknown> = {}) => ({ seq, kind: 'tweak', label: `L${seq}`, is_current: false, created_at: '2026-10-22T10:00:00Z', ...over });

describe('device frames', () => {
  it('offers desktop (full width), tablet and phone, in that order', () => {
    assert.deepEqual(DEVICES.map((d) => d.id), ['desktop', 'tablet', 'phone']);
    assert.deepEqual(DEVICES.map((d) => d.width), [null, 768, 390]);
    assert.ok(DEVICES.every((d) => (d.width === null) === (d.outer === null) && (d.outer === null || d.outer > d.width!)));
  });

  it('shrinks a frame to fit, never enlarges it, never makes it unreadable', () => {
    assert.equal(fitScale(1000, null), 1);
    assert.equal(fitScale(1000, 796), 1);
    assert.equal(fitScale(398, 796), 0.5);
    assert.equal(fitScale(100, 796), 0.4);
    assert.equal(fitScale(611, 796), 0.76); // 0.7676 rounds down, or the frame would overflow the room by a pixel or two
    assert.ok(796 * fitScale(611, 796) <= 611);
    assert.equal(fitScale(0, 796), 1);
    assert.equal(fitScale(Number.NaN, 414), 1);
  });
});

describe('what is pointed at', () => {
  it('names elements the way a person would', () => {
    assert.equal(pointedName(el('h2')), 'Heading');
    assert.equal(pointedName(el('button')), 'Button');
    assert.equal(pointedName(el('nav')), 'Menu');
    assert.equal(pointedName(el('marquee')), 'Element');
  });

  it('shows the words when there are some, shortened', () => {
    assert.equal(pointedLabel(el('h1', 'Hand-poured candles')), 'Heading “Hand-poured candles”');
    assert.equal(pointedLabel(el('section', '')), 'Section');
    const long = pointedLabel(el('p', 'word '.repeat(30)));
    assert.ok(long.startsWith('Paragraph “word word') && long.endsWith('…”'));
    assert.ok(long.length < 70);
  });

  it('suggests something sensible for what is pointed at, and for nothing', () => {
    assert.ok(ideasFor(null).length >= 3);
    assert.ok(ideasFor(el('h1', 'x')).includes('Change the words'));
    assert.ok(ideasFor(el('button', 'Buy')).some((s) => /stand out/.test(s)));
    assert.ok(ideasFor(el('img')).some((s) => /smaller/.test(s)));
    assert.ok(ideasFor(el('section')).some((s) => /space/.test(s)));
    for (const tag of ['h1', 'a', 'img', 'p', 'div']) assert.ok(ideasFor(el(tag)).every((s) => s.length > 0 && s.length < 40));
  });
});

describe('what is sent', () => {
  it('sends the recent tail, starting and ending with the owner', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: `m${i}` }));
    const sent = tweakHistory(lines);
    assert.ok(sent.length <= TWEAK_HISTORY);
    assert.equal(sent[0]!.role, 'user');
    assert.deepEqual(Object.keys(sent[0]!).sort(), ['content', 'role']);
    assert.deepEqual(tweakHistory([]), []);
    assert.deepEqual(tweakHistory([{ id: 'a', role: 'assistant', content: 'hi' }]), []);
  });
});

describe('saved versions', () => {
  it('reads rows oldest first, repairing junk', () => {
    const v = readVersions([row(3, { is_current: true }), row(1, { kind: 'baseline', label: '' }), 'junk', null, { seq: 'x' }, { seq: 1.5 }, row(2, { kind: 'weird', created_at: 5 })]);
    assert.deepEqual(v.map((x) => x.seq), [1, 2, 3]);
    assert.equal(v[0]!.label, 'Start');
    assert.equal(v[1]!.kind, 'tweak');
    assert.equal(v[1]!.createdAt, '');
    assert.equal(v[2]!.current, true);
    assert.deepEqual(readVersions(null), []);
    assert.deepEqual(readVersions({}), []);
  });

  const vs = (cur: number, n = 4): Version[] => readVersions(Array.from({ length: n }, (_, i) => row(i + 1, { is_current: i + 1 === cur })));

  it('works out what undo and redo would do from where the site is', () => {
    const mid = historyState(vs(2));
    assert.equal(mid.current?.seq, 2);
    assert.equal(mid.undoTo?.seq, 1);
    assert.equal(mid.redoTo?.seq, 3);
    assert.ok(mid.canUndo && mid.canRedo);
    const oldest = historyState(vs(1));
    assert.ok(!oldest.canUndo && oldest.canRedo);
    const newest = historyState(vs(4));
    assert.ok(newest.canUndo && !newest.canRedo);
  });

  it('offers nothing when no version is current', () => {
    const none = historyState(vs(0));
    assert.deepEqual(none, { current: null, canUndo: false, canRedo: false, undoTo: null, redoTo: null });
    assert.equal(historyState([]).current, null);
  });

  it('lists the newest first, without touching the input', () => {
    const input = vs(2);
    assert.deepEqual(newestFirst(input).map((v) => v.seq), [4, 3, 2, 1]);
    assert.deepEqual(input.map((v) => v.seq), [1, 2, 3, 4]);
  });

  it('puts the label and how long ago on one line', () => {
    const now = Date.parse('2026-10-22T10:05:00Z');
    assert.equal(versionLine(vs(1)[0]!, now), 'L1 · 5 min ago');
    assert.equal(versionLine({ ...vs(1)[0]!, createdAt: '' }, now), 'L1');
  });
});

describe('undo, redo and restore wording', () => {
  it('says what happened for each', () => {
    assert.equal(moveNotice('undo', { moved: true, label: 'Bigger title' }), 'Undone — your site is back at “Bigger title”.');
    assert.equal(moveNotice('redo', { moved: true, label: 'Bigger title' }), 'Redone — your site is at “Bigger title”.');
    assert.equal(moveNotice('restore', { moved: true, label: 'Start' }), 'Your site is back at “Start”.');
    assert.ok(moveNotice('undo', { moved: true }).includes('the version before'));
  });

  it('gives the reason when nothing moved, and warns when the version that is back has problems', () => {
    assert.equal(moveNotice('undo', { moved: false, error: "You're already at the oldest saved version." }), "You're already at the oldest saved version.");
    assert.equal(moveNotice('undo', { moved: false }), 'Nothing was changed.');
    assert.ok(moveNotice('undo', { moved: true, label: 'x', checked: true, fails: 1 }).endsWith('found a problem in this version.'));
    assert.ok(moveNotice('undo', { moved: true, label: 'x', checked: true, fails: 3 }).endsWith('found 3 problems in this version.'));
    assert.ok(!moveNotice('undo', { moved: true, label: 'x', checked: false, fails: 3 }).includes('problem'));
  });
});

describe('a finished run', () => {
  const done = (over: Partial<StageDone> = {}): StageDone => ({ ok: true, artifact: null, ...over });

  it('is a change when files changed, a chat when none did', () => {
    assert.deepEqual(tweakOutcome(done({ changed: ['index.html'] }), null), { kind: 'changed', files: ['index.html'] });
    assert.deepEqual(tweakOutcome(done({ changed: [] }), null), { kind: 'chat' });
    assert.deepEqual(tweakOutcome(done(), null), { kind: 'chat' });
  });

  it('is a failure with the server’s reason, or a plain one when the connection dropped', () => {
    assert.deepEqual(tweakOutcome(done({ ok: false, error: 'Nothing was changed.' }), null), { kind: 'failed', error: 'Nothing was changed.' });
    const noReason = tweakOutcome(done({ ok: false }), null);
    assert.equal(noReason.kind, 'failed');
    assert.ok(noReason.kind === 'failed' && /Nothing was changed/.test(noReason.error));
    assert.deepEqual(tweakOutcome(null, 'Could not reach the server.'), { kind: 'failed', error: 'Could not reach the server.' });
    const dropped = tweakOutcome(null, null);
    assert.ok(dropped.kind === 'failed' && /interrupted/.test(dropped.error));
  });

  it('names the pages a change touched, not the shared files', () => {
    const pages = [{ file: 'index.html', title: 'Home' }, { file: 'shop.html', title: 'Shop' }];
    assert.deepEqual(changedPages(['styles.css', 'index.html', 'shop.html', 'site.js'], pages), ['Home', 'Shop']);
    assert.deepEqual(changedPages(['styles.css'], pages), []);
    assert.deepEqual(changedPages(['extra.html'], pages), ['extra.html']);
  });
});

describe('change summary', () => {
  const pages = [{ file: 'index.html', title: 'Home' }, { file: 'shop.html', title: 'Shop' }];
  it('says what moved in plain words', () => {
    assert.equal(changeSummary(['index.html'], pages), 'Updated Home.');
    assert.equal(changeSummary(['index.html', 'shop.html', 'styles.css'], pages), 'Updated Home, Shop and the style.');
    assert.equal(changeSummary(['styles.css'], pages), 'Updated the style of every page.');
    assert.equal(changeSummary(['site.js'], pages), 'Updated the menu and footer.');
    assert.equal(changeSummary([], pages), 'Your site was updated.');
  });
});

describe('what is in the way of a change', () => {
  it('is nothing when the site is built and the plan and style are current', () => {
    assert.equal(tweaksBlocker({ hasSite: true, planStale: false, styleStale: false }), null);
  });
  it('says what to do first, in plain words', () => {
    assert.match(tweaksBlocker({ hasSite: false, planStale: false, styleStale: false })!, /build your full site first/);
    assert.match(tweaksBlocker({ hasSite: true, planStale: true, styleStale: false })!, /^Your plan is out of date/);
    assert.match(tweaksBlocker({ hasSite: true, planStale: false, styleStale: true })!, /^Your plan changed after your style/);
    assert.match(tweaksBlocker({ hasSite: true, planStale: true, styleStale: true })!, /plan and style/);
  });
});

describe('small helpers', () => {
  it('compares file sets by content', () => {
    assert.ok(sameFiles({ a: '1', b: '2' }, { b: '2', a: '1' }));
    assert.ok(!sameFiles({ a: '1' }, { a: '2' }));
    assert.ok(!sameFiles({ a: '1' }, { a: '1', b: '' }));
    assert.ok(sameFiles({}, {}));
  });

  it('says the site stays as it is when it is live', () => {
    assert.match(draftNote(false), /once you publish/);
    assert.match(draftNote(true), /live site stays as it is/);
  });
});
