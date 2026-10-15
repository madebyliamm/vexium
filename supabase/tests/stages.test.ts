// Stage engine unit tests — run:  node --test supabase/tests/stages.test.ts   (Node ≥ 22.18 runs .ts directly)
// Covers supabase/functions/_shared/stages.ts + artifacts.ts. The database enforces the same rules (supabase/tests/step7_stage_engine.sql);
// the first describe() below fails if the TypeScript mirror and the SQL literal in the migration ever drift apart.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { emptyPlan, normalizeArtifact, validateArtifact } from '../functions/_shared/artifacts.ts';
import {
  ARTIFACT_KINDS, DEPENDS_ON, STAGES, STAGE_IO, STAGE_RULES, applyKeep, applyPut, blockers, canMoveTo, clientMayKeep, clientMayWrite,
  describeBlocker, furthestEnterable, isArtifactKind, isStage, nextStage, prevStage, stageRank, stateString,
  type ArtifactKind, type LatestArtifacts, type Stage,
} from '../functions/_shared/stages.ts';

const MIGRATION = new URL('../migrations/20261014100000_stage_engine.sql', import.meta.url);

describe('rules mirror the database', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const literal = /AS \$fn\$ SELECT \$json\$([\s\S]*?)\$json\$::jsonb/.exec(sql)?.[1];

  it('the migration holds one vx_stage_rules() literal', () => {
    assert.ok(literal, 'vx_stage_rules() literal not found in the migration');
  });

  it('STAGE_RULES equals that literal, key for key', () => {
    assert.deepEqual(JSON.parse(literal!), JSON.parse(JSON.stringify(STAGE_RULES)));
  });

  it('STAGES / ARTIFACT_KINDS equal the rule lists', () => {
    assert.deepEqual([...STAGES], [...STAGE_RULES.stages]);
    assert.deepEqual([...ARTIFACT_KINDS], [...STAGE_RULES.kinds]);
  });

  it('downstream is exactly the transitive closure of DEPENDS_ON', () => {
    const closure = (k: ArtifactKind): ArtifactKind[] => {
      const out = new Set<ArtifactKind>();
      const walk = (x: ArtifactKind) => {
        for (const y of ARTIFACT_KINDS) if (DEPENDS_ON[y].includes(x) && !out.has(y)) (out.add(y), walk(y));
      };
      walk(k);
      return ARTIFACT_KINDS.filter((y) => out.has(y));
    };
    for (const k of ARTIFACT_KINDS) assert.deepEqual([...STAGE_RULES.downstream[k]], closure(k), `downstream of ${k}`);
  });

  it('every requirement / flag / writable kind is a known kind, and keepable ⊇ writable', () => {
    for (const s of STAGES) for (const k of STAGE_RULES.requires[s]) assert.ok(isArtifactKind(k), `${s} requires ${k}`);
    for (const k of Object.keys(STAGE_RULES.required_flags)) assert.ok(isArtifactKind(k));
    for (const k of STAGE_RULES.client_writable) assert.ok((STAGE_RULES.client_keepable as readonly string[]).includes(k));
    for (const s of STAGE_RULES.requires_published) assert.ok(isStage(s));
  });

  it('requirements only ever grow with the stage (except BUSINESS, which needs a live site instead)', () => {
    for (const s of STAGES.slice(1, 5)) {
      const prev = STAGE_RULES.requires[STAGES[stageRank(s) - 1]!] as readonly string[];
      for (const k of prev) assert.ok((STAGE_RULES.requires[s] as readonly string[]).includes(k), `${s} should still require ${k}`);
    }
  });

  it('what a stage reads is produced by an earlier stage (no stage depends on its own future)', () => {
    const producedAt = (k: ArtifactKind): number => Math.min(...STAGES.filter((s) => STAGE_IO[s].produces === k).map(stageRank), 99);
    for (const s of STAGES) for (const k of STAGE_IO[s].inputs) assert.ok(producedAt(k) < stageRank(s), `${s} reads ${k} before anything produces it`);
  });

  it('the stage a client can produce an artifact in is always one it may write (AI runs save as the user)', () => {
    // plan + style_spec are written by the user's own session; the others only ever by the platform after a server-side run.
    for (const s of STAGES) {
      const p = STAGE_IO[s].produces;
      if (p && (s === 'plan' || s === 'example')) assert.ok(clientMayWrite(p));
    }
  });
});

describe('helpers', () => {
  it('stage order, neighbours and guards', () => {
    assert.equal(stageRank('plan'), 0);
    assert.equal(stageRank('business'), 5);
    assert.equal(nextStage('plan'), 'example');
    assert.equal(nextStage('business'), null);
    assert.equal(prevStage('plan'), null);
    assert.equal(prevStage('launch'), 'tweaks');
    assert.ok(isStage('launch') && !isStage('bogus') && !isStage(3) && !isStage(null));
    assert.ok(isArtifactKind('manifest') && !isArtifactKind('files') && !isArtifactKind(undefined));
  });

  it('who may write / keep what', () => {
    assert.deepEqual(ARTIFACT_KINDS.filter(clientMayWrite), ['plan', 'style_spec']);
    assert.deepEqual(ARTIFACT_KINDS.filter(clientMayKeep), ['plan', 'style_spec', 'manifest']);
  });
});

describe('stale-marking — the same scenario as the SQL test (section C)', () => {
  const step = (latest: LatestArtifacts, op: string, kind: ArtifactKind) => {
    if (op === 'put') return applyPut(latest, kind, { schema: 1 }).latest;
    if (op === 'keep') return applyKeep(latest, kind).latest;
    throw new Error(op);
  };
  // [operation, kind, state afterwards] — copied from supabase/tests/step7_stage_engine.sql
  const SCENARIO: [string, ArtifactKind, string][] = [
    ['put', 'plan', 'plan:v1'],
    ['put', 'style_spec', 'plan:v1,style_spec:v1'],
    ['put', 'manifest', 'manifest:v1,plan:v1,style_spec:v1'],
    ['put', 'launch_checks', 'launch_checks:v1,manifest:v1,plan:v1,style_spec:v1'],
    ['put', 'plan', 'launch_checks:v1!,manifest:v1!,plan:v2,style_spec:v1!'],
    ['keep', 'style_spec', 'launch_checks:v1!,manifest:v1!,plan:v2,style_spec:v1'],
    ['put', 'style_spec', 'launch_checks:v1!,manifest:v1!,plan:v2,style_spec:v2'],
    ['keep', 'manifest', 'launch_checks:v1!,manifest:v1,plan:v2,style_spec:v2'],
    ['put', 'launch_checks', 'launch_checks:v2,manifest:v1,plan:v2,style_spec:v2'],
    ['put', 'manifest', 'launch_checks:v2!,manifest:v2,plan:v2,style_spec:v2'],
    ['put', 'business_state', 'business_state:v1,launch_checks:v2!,manifest:v2,plan:v2,style_spec:v2'],
    ['put', 'plan', 'business_state:v1,launch_checks:v2!,manifest:v2!,plan:v3,style_spec:v2!'],
  ];

  it('replays every step to the same state string the database produced', () => {
    let latest: LatestArtifacts = {};
    SCENARIO.forEach(([op, kind, want], i) => {
      latest = step(latest, op, kind);
      assert.equal(stateString(latest), want, `step ${i + 1}: ${op} ${kind}`);
    });
  });

  it('applyPut reports what it made stale, sorted, and only what was fresh', () => {
    let latest: LatestArtifacts = {};
    for (const k of ['plan', 'style_spec', 'manifest', 'launch_checks'] as const) latest = applyPut(latest, k, { schema: 1 }).latest;
    const r = applyPut(latest, 'plan', { schema: 1 });
    assert.deepEqual(r.staled, ['launch_checks', 'manifest', 'style_spec']);
    assert.equal(r.version, 2);
    assert.deepEqual(applyPut(r.latest, 'plan', { schema: 1 }).staled, []);
  });

  it('applyPut / applyKeep do not mutate their input', () => {
    const base = applyPut(applyPut({}, 'plan', { schema: 1 }).latest, 'style_spec', { schema: 1 }).latest;
    const before = stateString(base);
    applyPut(base, 'plan', { schema: 1 });
    applyKeep(base, 'plan');
    assert.equal(stateString(base), before);
  });

  it('keep is a no-op on a fresh or missing artifact', () => {
    const l = applyPut({}, 'plan', { schema: 1 }).latest;
    assert.equal(applyKeep(l, 'plan').cleared, false);
    assert.equal(applyKeep(l, 'manifest').cleared, false);
  });

  it('only the latest version is flagged — a business_state is never made stale by upstream edits', () => {
    let l: LatestArtifacts = {};
    l = applyPut(l, 'business_state', { schema: 1 }).latest;
    l = applyPut(l, 'plan', { schema: 1 }).latest;
    assert.equal(stateString(l), 'business_state:v1,plan:v1');
  });
});

describe('moving between stages — the same cases as the SQL test (section E)', () => {
  const fresh = (...kinds: ArtifactKind[]): LatestArtifacts => {
    let l: LatestArtifacts = {};
    for (const k of kinds) l = applyPut(l, k, k === 'style_spec' ? { schema: 1, locked: true } : { schema: 1 }).latest;
    return l;
  };
  const move = (cur: Stage, to: Stage, l: LatestArtifacts, published = false) => canMoveTo(cur, to, l, published);

  it('plan is always enterable; example needs a plan', () => {
    assert.deepEqual(blockers('plan', {}, false), []);
    assert.deepEqual(move('plan', 'example', {}), { ok: false, stage: 'plan', blockedBy: [{ kind: 'plan', reason: 'missing' }] });
    assert.deepEqual(move('plan', 'example', fresh('plan')), { ok: true, stage: 'example', blockedBy: [] });
  });

  it('build needs a style, and the style must be LOCKED', () => {
    assert.deepEqual(move('example', 'build', fresh('plan')).blockedBy, [{ kind: 'style_spec', reason: 'missing' }]);
    const unlocked = applyPut(fresh('plan'), 'style_spec', { schema: 1, locked: false }).latest;
    assert.deepEqual(move('example', 'build', unlocked).blockedBy, [{ kind: 'style_spec', reason: 'flag:locked' }]);
    assert.equal(move('example', 'build', fresh('plan', 'style_spec')).ok, true);
  });

  it('launch lists every missing artifact in order; a jump of two stages is fine when all are fresh', () => {
    assert.deepEqual(move('build', 'launch', fresh('plan', 'style_spec')).blockedBy, [
      { kind: 'manifest', reason: 'missing' },
      { kind: 'launch_checks', reason: 'missing' },
    ]);
    assert.equal(move('build', 'launch', fresh('plan', 'style_spec', 'manifest', 'launch_checks')).ok, true);
  });

  it('going back and staying put are always allowed, even with nothing saved or everything stale', () => {
    for (const s of STAGES) {
      assert.equal(move(s, s, {}).ok, true);
      assert.equal(move('business', s, {}).ok, true);
    }
    const stale = applyPut(fresh('plan', 'style_spec', 'manifest', 'launch_checks'), 'plan', { schema: 1 }).latest;
    assert.equal(move('launch', 'plan', stale).ok, true);
  });

  it('a stale chain blocks going forward, reason "stale", and does not move the user', () => {
    const stale = applyPut(fresh('plan', 'style_spec', 'manifest', 'launch_checks'), 'plan', { schema: 1 }).latest;
    assert.deepEqual(move('tweaks', 'launch', stale), {
      ok: false,
      stage: 'tweaks',
      blockedBy: [
        { kind: 'style_spec', reason: 'stale' },
        { kind: 'manifest', reason: 'stale' },
        { kind: 'launch_checks', reason: 'stale' },
      ],
    });
  });

  it('keeping the stale artifacts clears the way (but a stale launch check needs a re-run)', () => {
    let l = applyPut(fresh('plan', 'style_spec', 'manifest', 'launch_checks'), 'plan', { schema: 1 }).latest;
    l = applyKeep(applyKeep(l, 'style_spec').latest, 'manifest').latest;
    assert.deepEqual(move('tweaks', 'launch', l).blockedBy, [{ kind: 'launch_checks', reason: 'stale' }]);
    assert.equal(move('tweaks', 'tweaks', l).ok, true);
  });

  it('business needs a live site and nothing else', () => {
    assert.deepEqual(move('plan', 'business', {}).blockedBy, [{ kind: 'published', reason: 'missing' }]);
    assert.equal(move('plan', 'business', {}, true).ok, true);
  });

  it('furthestEnterable', () => {
    assert.equal(furthestEnterable('plan', {}, false), 'plan');
    assert.equal(furthestEnterable('plan', fresh('plan'), false), 'example');
    assert.equal(furthestEnterable('plan', fresh('plan', 'style_spec', 'manifest'), false), 'tweaks');
    assert.equal(furthestEnterable('plan', fresh('plan', 'style_spec', 'manifest', 'launch_checks'), true), 'business');
    assert.equal(furthestEnterable('launch', {}, false), 'launch');
  });

  it('describeBlocker words every case in plain English', () => {
    assert.equal(describeBlocker({ kind: 'plan', reason: 'missing' }), 'Needs your plan first');
    assert.equal(describeBlocker({ kind: 'style_spec', reason: 'flag:locked' }), 'Lock your style first');
    assert.equal(describeBlocker({ kind: 'manifest', reason: 'stale' }), 'The built site is out of date — keep it or redo it');
    assert.equal(describeBlocker({ kind: 'published', reason: 'missing' }), 'Needs a live site first');
  });
});

describe('validateArtifact', () => {
  const validPlan = () => ({ ...emptyPlan('Bean There'), one_liner: 'Coffee subscriptions', audience: 'Home brewers', offer: 'A bag a month' });
  const errorsOf = (kind: ArtifactKind, data: unknown): string[] => {
    const r = validateArtifact(kind, data);
    return r.ok ? [] : r.errors;
  };

  it('emptyPlan is a valid plan', () => {
    assert.equal(validateArtifact('plan', emptyPlan()).ok, true);
    assert.equal(validateArtifact('plan', validPlan()).ok, true);
  });

  it('rejects non-objects and a missing/wrong schema', () => {
    for (const bad of [null, 'x', 3, [], undefined]) assert.equal(validateArtifact('plan', bad).ok, false);
    assert.match(errorsOf('plan', { ...validPlan(), schema: 2 }).join(), /schema/);
    const { schema: _drop, ...noSchema } = validPlan();
    assert.match(errorsOf('plan', noSchema).join(), /schema/);
  });

  it('plan: names every problem with a path', () => {
    const errs = errorsOf('plan', {
      ...validPlan(), name: '  ', kind: 'blog',
      pricing: { model: 'barter', items: [{ name: '', price_cents: 9.5 }] },
      pages: [{ file: '../x.html', title: '', purpose: 1 }],
      backend: { collections: 'waitlist', products: [], forms: [], auth: 'yes' },
      scenario: { price_cents: -1, monthly_visitors: 10, conversion_pct: 140 },
    }).join('\n');
    for (const needle of ['name:', 'kind:', 'pricing.model', 'pricing.items[0].name', 'pricing.items[0].price_cents', 'pages[0].file', 'pages[0].title', 'pages[0].purpose', 'backend.collections', 'backend.auth', 'scenario.price_cents', 'scenario.conversion_pct']) {
      assert.ok(errs.includes(needle), `expected an error about ${needle}\n${errs}`);
    }
  });

  it('plan: keeps unknown extra keys (forward compatible)', () => {
    const r = validateArtifact('plan', { ...validPlan(), future_field: { a: 1 } });
    assert.ok(r.ok && (r.value as unknown as Record<string, unknown>).future_field);
  });

  it('plan: a scenario is optional (null) but not undefined-garbage', () => {
    assert.equal(validateArtifact('plan', { ...validPlan(), scenario: null }).ok, true);
    assert.equal(validateArtifact('plan', { ...validPlan(), scenario: 'lots' }).ok, false);
  });

  it('plan: caps list sizes so a runaway model output cannot bloat the row', () => {
    const pages = Array.from({ length: 31 }, (_, i) => ({ file: `p${i}.html`, title: 't', purpose: '' }));
    assert.match(errorsOf('plan', { ...validPlan(), pages }).join(), /pages: has more than 30/);
  });

  const validStyle = () => ({
    schema: 1, locked: true, vibe: { theme: 'light', density: 'comfortable', tone: 'warm' },
    tokens: { '--accent': '#7c3aed', '--font-body': "'Inter', sans-serif" }, fonts: { display: 'Fraunces', body: 'Inter', import_url: 'https://fonts.googleapis.com/css2?family=Inter' },
  });

  it('style_spec: valid, and token names/values are constrained (they end up inside CSS)', () => {
    assert.equal(validateArtifact('style_spec', validStyle()).ok, true);
    assert.match(errorsOf('style_spec', { ...validStyle(), tokens: { accent: '#fff' } }).join(), /tokens\.accent/);
    assert.match(errorsOf('style_spec', { ...validStyle(), tokens: { '--accent': 'red; } body { display:none' } }).join(), /--accent/);
    assert.match(errorsOf('style_spec', { ...validStyle(), tokens: { '--x': '</style><script>' } }).join(), /--x/);
    assert.match(errorsOf('style_spec', { ...validStyle(), fonts: { display: 'A', body: 'B', import_url: 'https://evil.example/x.css' } }).join(), /fonts\.import_url/);
    assert.match(errorsOf('style_spec', { ...validStyle(), locked: 'yes' }).join(), /locked/);
    assert.match(errorsOf('style_spec', { ...validStyle(), vibe: { theme: 'neon', density: 'x', tone: 1 } }).join(), /vibe\.theme/);
  });

  it('manifest / business_state / launch_checks', () => {
    const manifest = { schema: 1, built_at: '2026-10-14T10:00:00Z', pages: [{ file: 'index.html', title: 'Home' }], shared_files: ['styles.css', 'site.js'], backend: { collections: [], products: [], forms: ['contact'], auth: false } };
    assert.equal(validateArtifact('manifest', manifest).ok, true);
    assert.match(errorsOf('manifest', { ...manifest, shared_files: 'styles.css' }).join(), /shared_files/);

    const checks = { schema: 1, checked_at: '2026-10-14T10:05:00Z', manifest_version: 1, ok: true, open_items: [], checks: [{ id: 'links', label: 'Links work', status: 'pass' }] };
    assert.equal(validateArtifact('launch_checks', checks).ok, true);
    assert.match(errorsOf('launch_checks', { ...checks, checks: [{ id: 'links', label: 'Links', status: 'fail' }] }).join(), /ok: cannot be true while a check failed/);
    assert.equal(validateArtifact('launch_checks', { ...checks, ok: false, checks: [{ id: 'links', label: 'Links', status: 'fail' }] }).ok, true);
    assert.match(errorsOf('launch_checks', { ...checks, manifest_version: 0 }).join(), /manifest_version/);

    const biz = { schema: 1, computed_at: '2026-10-14T10:00:00Z', period_days: 7, visitors: 120, signups: 4, orders: 1, revenue_cents: 2900 };
    assert.equal(validateArtifact('business_state', biz).ok, true);
    assert.match(errorsOf('business_state', { ...biz, revenue_cents: -5 }).join(), /revenue_cents/);
  });

  it('reports at most 20 errors', () => {
    const r = validateArtifact('plan', { schema: 1, pages: Array.from({ length: 30 }, () => ({})) });
    assert.ok(!r.ok && r.errors.length === 20);
  });
});

describe('normalizeArtifact', () => {
  it('drops nulls (models write "interval": null) but keeps scenario: null, which means "no scenario yet"', () => {
    const out = normalizeArtifact({ schema: 1, scenario: null, notes: null, pricing: { model: 'one_time', items: [{ name: 'A', price_cents: 100, interval: null }] }, nested: { scenario: null } }) as Record<string, any>;
    assert.equal('notes' in out, false);
    assert.equal(out.scenario, null);
    assert.equal('interval' in out.pricing.items[0], false);
    assert.equal('scenario' in out.nested, false, 'only the top-level scenario is allowed to be null');
  });
  it('does not mutate its input and passes non-objects through', () => {
    const input = { a: null, b: [1, { c: null }] };
    normalizeArtifact(input);
    assert.deepEqual(input, { a: null, b: [1, { c: null }] });
    assert.equal(normalizeArtifact('x'), 'x');
    assert.equal(normalizeArtifact(null), null);
  });
  it('a plan with "interval": null passes validation after normalizing', () => {
    const plan = { ...emptyPlan('A'), pricing: { model: 'one_time', items: [{ name: 'X', price_cents: 100, interval: null }] } };
    assert.equal(validateArtifact('plan', plan).ok, false);
    assert.equal(validateArtifact('plan', normalizeArtifact(plan)).ok, true);
  });
});
