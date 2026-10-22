import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PUBLISH_SKEW_MS, cleanSlug, deployLine, draftIsAhead, launchGate, launchStatus, paymentsState, productCount, publishErrorText, readDeploys, siteAddress, slugFrom, slugProblem,
} from '../src/lib/launch-view.ts';
import { qrModules, qrPath } from '../src/lib/qr.ts';
import type { LaunchChecks } from '../src/types/artifacts.ts';

const report = (checks: LaunchChecks['checks'], open: string[] = [], manifest_version = 3): LaunchChecks => ({
  schema: 1, checked_at: '2026-10-22T10:00:00Z', manifest_version, ok: !checks.some((c) => c.status === 'fail'), checks, open_items: open,
});
const pass = { id: 'links', label: 'Every link goes somewhere', status: 'pass' as const };
const warn = { id: 'claims', label: 'Claims', status: 'warn' as const, detail: 'x' };
const fail = { id: 'forms', label: 'Forms are connected', status: 'fail' as const, page: 'contact.html' };
const base = { report: report([pass]), reportOutdated: false, built: true, products: 0, paymentsConnected: null, slug: 'cafe' };

describe('the site address', () => {
  it('derives an address from the project name the way the publisher does', () => {
    assert.equal(slugFrom('Maple & Rye Café!'), 'maple-rye-caf');
    assert.equal(slugFrom('  '), 'my-site');
    assert.equal(slugFrom('!!!'), 'my-site');
    assert.equal(slugFrom('a'.repeat(80)).length, 63);
    assert.equal(slugFrom(`${'a'.repeat(62)} b`), 'a'.repeat(62));
  });

  it('tidies typing, and says what is wrong with a bad address', () => {
    assert.equal(cleanSlug('  My Cafe!! '), 'my-cafe-');
    assert.equal(cleanSlug('-lead'), 'lead');
    assert.equal(slugProblem('my-cafe'), null);
    assert.equal(slugProblem('cafe-'), 'Use only lowercase letters, numbers and hyphens, and don’t end with a hyphen.');
    assert.equal(slugProblem('Cafe'), 'Use only lowercase letters, numbers and hyphens, and don’t end with a hyphen.');
    assert.equal(slugProblem(''), 'Choose an address for your site.');
  });

  it('builds the live address; a custom domain wins; no username → none', () => {
    assert.deepEqual(siteAddress({ username: 'Liam', slug: 'cafe' }), { display: 'liam.vexium.ai/cafe', href: 'https://liam.vexium.ai/cafe' });
    assert.deepEqual(siteAddress({ username: 'liam', slug: 'cafe', customDomain: ' WWW.Cafe.com ' }), { display: 'www.cafe.com', href: 'https://www.cafe.com' });
    assert.equal(siteAddress({ username: null, slug: 'cafe' }), null);
    assert.equal(siteAddress({ username: 'liam', slug: '' }), null);
  });
});

describe('payments', () => {
  it('only matters when the site sells something', () => {
    assert.equal(paymentsState({ products: 0, connected: false }), 'not-needed');
    assert.equal(paymentsState({ products: 2, connected: true }), 'ready');
    assert.equal(paymentsState({ products: 2, connected: false }), 'not-connected');
    assert.equal(paymentsState({ products: 2, connected: null }), 'unknown');
  });
  it('counts products from the saved manifest', () => {
    assert.equal(productCount({ pages: [{ file: 'index.html', title: 'Home' }], backend: { collections: [], products: ['a', 'b'], forms: [], auth: false } }), 2);
    assert.equal(productCount({ pages: [{ file: 'index.html', title: 'Home' }] }), 0);
    assert.equal(productCount(null), 0);
  });
});

describe('may it go live', () => {
  it('opens for a clean report', () => {
    const g = launchGate(base);
    assert.equal(g.canPublish, true);
    assert.deepEqual(g.blockers, []);
    assert.deepEqual(g.rows.map((r) => [r.id, r.state]), [['site', 'pass'], ['address', 'pass']]);
  });

  it('warnings and owner to-dos never block, but are shown', () => {
    const g = launchGate({ ...base, report: report([pass, warn], ['Add your opening hours']) });
    assert.equal(g.canPublish, true);
    assert.deepEqual(g.rows.map((r) => [r.id, r.state]), [['site', 'warn'], ['content', 'warn'], ['address', 'pass']]);
  });

  it('a failed check blocks, and says how many', () => {
    const one = launchGate({ ...base, report: report([pass, fail]) });
    assert.equal(one.canPublish, false);
    assert.deepEqual(one.blockers, ['Fix the problem the check found.']);
    const two = launchGate({ ...base, report: report([fail, { ...fail, id: 'links' }]) });
    assert.deepEqual(two.blockers, ['Fix the 2 problems the check found.']);
  });

  it('needs a report, and a report for THIS build', () => {
    assert.equal(launchGate({ ...base, report: null }).canPublish, false);
    const old = launchGate({ ...base, reportOutdated: true });
    assert.equal(old.canPublish, false);
    assert.equal(old.rows[0]?.state, 'todo');
    assert.equal(launchGate({ ...base, built: false, report: null }).blockers[0], 'Build your site first.');
  });

  it('a shop needs Stripe; not being able to tell also blocks', () => {
    assert.equal(launchGate({ ...base, products: 3, paymentsConnected: false }).canPublish, false);
    assert.equal(launchGate({ ...base, products: 3, paymentsConnected: null }).canPublish, false);
    const ok = launchGate({ ...base, products: 3, paymentsConnected: true });
    assert.equal(ok.canPublish, true);
    assert.ok(ok.rows.some((r) => r.id === 'payments' && r.state === 'pass'));
    assert.ok(!launchGate({ ...base, products: 0, paymentsConnected: false }).rows.some((r) => r.id === 'payments'));
  });

  it('while Stripe is still being looked up it says so, not that the lookup failed', () => {
    const g = launchGate({ ...base, products: 3, paymentsConnected: null, paymentsChecking: true });
    assert.equal(g.canPublish, false);
    assert.match(g.rows.find((r) => r.id === 'payments')?.detail ?? '', /Checking/);
    assert.match(g.blockers.join(' '), /Still checking/);
    assert.doesNotMatch(g.blockers.join(' '), /Couldn’t/);
  });

  it('a bad address blocks', () => {
    const g = launchGate({ ...base, slug: 'Bad Name' });
    assert.equal(g.canPublish, false);
    assert.equal(g.rows.find((r) => r.id === 'address')?.state, 'fail');
  });
});

describe('live state', () => {
  it('ignores the publisher’s own write, notices a later edit, and never guesses from bad dates', () => {
    const p = '2026-10-22T10:00:00.000Z';
    assert.equal(draftIsAhead({ publishedAt: p, updatedAt: '2026-10-22T10:00:02.000Z' }), false);
    assert.equal(draftIsAhead({ publishedAt: p, updatedAt: new Date(Date.parse(p) + PUBLISH_SKEW_MS + 1).toISOString() }), true);
    assert.equal(draftIsAhead({ publishedAt: null, updatedAt: p }), false);
    assert.equal(draftIsAhead({ publishedAt: p, updatedAt: 'nope' }), false);
  });

  it('picks one status', () => {
    const s = (published: boolean, publishing: boolean, canPublish: boolean, draftAhead: boolean) => launchStatus({ published, publishing, canPublish, draftAhead });
    assert.equal(s(false, false, true, false), 'ready');
    assert.equal(s(false, false, false, false), 'blocked');
    assert.equal(s(false, true, true, false), 'publishing');
    assert.equal(s(true, false, false, false), 'live');
    assert.equal(s(true, false, false, true), 'live-changes');
    assert.equal(s(true, true, true, true), 'publishing');
  });
});

describe('live versions', () => {
  it('lists the versions that can be gone back to, newest first, marking the live one', () => {
    const rows = [
      { version: 1, status: 'ready', created_at: '2026-10-20T10:00:00Z', file_count: 4, total_bytes: 1000 },
      { version: 3, status: 'ready', created_at: '2026-10-22T10:00:00Z', file_count: 5, total_bytes: 1500 },
      { version: 2, status: 'failed', created_at: '2026-10-21T10:00:00Z', file_count: 0, total_bytes: 0 },
      { version: 4, status: 'uploading', created_at: '2026-10-22T11:00:00Z' },
      { status: 'ready' },
      null,
    ];
    const d = readDeploys(rows, 3);
    assert.deepEqual(d.map((x) => [x.version, x.isLive]), [[3, true], [1, false]]);
    assert.deepEqual(readDeploys('x', 1), []);
    assert.equal(deployLine(d[0]!, Date.parse('2026-10-22T10:10:00Z')), 'Version 3 · 10 min ago');
  });
});

describe('publish errors', () => {
  it('words a network failure; keeps the publisher’s own sentence', () => {
    assert.match(publishErrorText(new TypeError('Failed to fetch')), /your live site was not changed/);
    assert.equal(publishErrorText(new Error('You already have a published site at "cafe".')), 'You already have a published site at "cafe".');
    assert.match(publishErrorText(new Error('')), /live site was not changed/);
  });
});

describe('qr code', () => {
  it('makes a square grid with the three finder squares, and a one-path drawing of it', () => {
    const m = qrModules('https://liam.vexium.ai/cafe');
    assert.ok(m && m.length >= 21 && m.every((row) => row.length === m.length));
    const at = (r: number, c: number): boolean | undefined => m[r]?.[c];
    const last = m.length - 1;
    assert.ok(at(0, 0) && at(0, 6) && at(6, 0) && at(0, last) && at(last, 0)); // finder corners
    const d = qrPath(m);
    assert.match(d, /^M0 0h7v1h-7z/);
    assert.ok(!/[^Mhvz0-9 .\-]/.test(d));
  });
  it('refuses empty or silly input instead of throwing', () => {
    assert.equal(qrModules(''), null);
    assert.equal(qrModules('x'.repeat(401)), null);
  });
});
