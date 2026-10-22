// TWEAKS (REVAMP Step 11) — judging what a tweak run produced, as one pure function (no I/O, no Deno APIs; unit-tested under Node in
// supabase/tests/tweaks.test.ts). tweaks-handler.ts does the saving around it.
//
// What comes in: the files the run patched (the build Worker applied the model's <patch> blocks to the site's text and reports the
// final text of every file it touched), how many patch blocks matched nothing, and the site as it is saved now.
// What goes out: either an error (and then NOTHING is saved — a tweak is all or nothing), a chat-only turn, or the exact set of
// files to write plus, when the change moved the style, the new style_spec.
//
// A tweak may not break what the platform derived from the pages. `_backend` (what visitors may store) is generated from the forms
// the pages contain, so a tweak that adds, removes or renames a form field, a sign-up box or a buy button would leave the live backend
// disagreeing with the page: the tweak is refused and the owner is pointed at Plan + rebuild. Everything else is held to the launch
// verifier: a tweak may not introduce a NEW failing check (a missing stylesheet link, a broken link, a cut-off script…).
import { normalizeArtifact, validateArtifact, type StyleSpec } from '../_shared/artifacts.ts';
import type { LatestArtifacts } from '../_shared/stages.ts';
import { applyStyleSpec, deriveStyleSpec, manifestWithStyle, parseTokens } from '../_shared/style.ts';
import { inputsFrom, verifyStored } from './build-handler.ts';
import { jsBalanceProblem } from './html-lite.ts';
import { scanPage, type PageScan } from './site-derive.ts';
import { canonicalJson } from './stages.ts';
import { editableFiles, PAGE_NAME } from './tweaks-prompt.ts';
import type { VerifyResult } from './verifier.ts';

export interface TweakInput {
  /** The run's chat text (patch blocks are not in it). */
  message: string;
  /** name → final text of every file the run patched or wrote. */
  written: Record<string, string>;
  /** Patch blocks where no edit matched the file. */
  patchFailed: number;
  /** projects.files now (name → text). */
  files: Record<string, string>;
  latest: LatestArtifacts;
}

export interface TweakResult {
  chat: string;
  /** Plain English; when set nothing may be saved. */
  error?: string;
  /** The files to write (only those that change; includes manifest.json when the palette moved). Empty = chat-only turn. */
  files: Record<string, string>;
  /** The new style_spec when the change moved a token or font (the lock kept), else null. */
  style: StyleSpec | null;
  /** The launch check of the site after the change; null for a chat-only turn. */
  report: VerifyResult | null;
}

const NOTHING = ' Nothing was changed.';
const MAX_FILE_CHARS = 300_000;

const fail = (chat: string, why: string): TweakResult => ({ chat, error: why + NOTHING, files: {}, style: null, report: null });

/** The part of a page the backend and the accounts depend on: forms and their fields, buy buttons, sign-in hooks, data calls. */
export function hooksOf(s: PageScan): string {
  const byId = <T extends { id?: string; kind?: string }>(a: T, b: T): number => (a.id ?? a.kind ?? '').localeCompare(b.id ?? b.kind ?? '');
  return canonicalJson({
    forms: s.forms.map((f) => ({ id: f.id, fields: [...f.fields].sort((a, b) => a.key.localeCompare(b.key)) })).sort(byId),
    auth: s.authForms.map((a) => ({ kind: a.kind, hasEmail: a.hasEmail, hasPassword: a.hasPassword, redirect: a.redirect })).sort(byId),
    buys: [...s.buys].sort(),
    buyAmounts: s.buyAmounts,
    dataIds: [...s.dataIds].sort(),
    requireAuth: [...s.requireAuth].sort(),
    skipIfAuth: [...s.skipIfAuth].sort(),
    redirects: [...s.redirects].sort(),
    stray: s.strayForms,
    wrong: s.hookOnWrongTag.length,
  });
}

const problemKey = (p: { file: string; check: string; message: string }): string => `${p.file}|${p.check}|${p.message}`;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The style_spec a stylesheet now describes, when its tokens or fonts are not the saved style's (the lock is kept); null when the
 * style did not move; a reason string when the stylesheet no longer holds a usable style.
 */
export function styleMoved(css: string, current: StyleSpec, opts: { declaredOnly?: boolean } = {}): StyleSpec | string | null {
  const derived = deriveStyleSpec(css, { tone: current.vibe.tone, voice: current.voice, art_direction: current.art_direction });
  if (derived.problems.length > 0) return derived.problems.slice(0, 2).join('; ');
  // A tweak writes the standard tokens the model left out back into its stylesheet. An undo / redo / restore puts a saved stylesheet
  // back byte for byte, so its style may only claim the tokens that file declares (or the launch report says the two disagree).
  const declared = opts.declaredOnly ? parseTokens(css) : null;
  const tokens = declared ? Object.fromEntries(Object.entries(derived.spec.tokens).filter(([k]) => k in declared)) : derived.spec.tokens;
  const spec: StyleSpec = { ...derived.spec, tokens, locked: current.locked };
  if (canonicalJson({ t: spec.tokens, f: spec.fonts }) === canonicalJson({ t: current.tokens, f: current.fonts })) return null;
  const valid = validateArtifact('style_spec', normalizeArtifact(spec));
  return valid.ok ? valid.value : valid.errors.slice(0, 2).join('; ');
}

export function finishTweaks(i: TweakInput): TweakResult {
  const chat = i.message.trim();
  const editable = new Set(editableFiles(i.files));

  const changed: Record<string, string> = {};
  for (const [name, text] of Object.entries(i.written)) {
    if (!editable.has(name)) return fail(chat, "The AI tried to change something that can't be changed here.");
    if (text !== i.files[name]) changed[name] = text;
  }
  if (i.patchFailed > 0) {
    return fail(chat, "Part of that change didn't fit your page, so none of it was made. Try pointing at the exact spot and saying it again.");
  }
  if (Object.keys(changed).length === 0) return { chat, files: {}, style: null, report: null };

  for (const [name, text] of Object.entries(changed)) {
    const old = i.files[name]!;
    if (text.length > MAX_FILE_CHARS) return fail(chat, 'That change made a file too large.');
    if (old.length > 1000 && text.length < old.length * 0.5) return fail(chat, 'That change would have removed most of a page.');
    if (name === 'site.js') {
      // The build Worker's last-resort patch match squeezes the whole file's whitespace, which turns every `//` comment into the end
      // of the script: a file that lost many lines is not a patched file.
      const lines = (t: string): number => t.split('\n').length;
      const squeezed = lines(old) - lines(text) > Math.max(5, lines(old) * 0.2);
      if (squeezed || jsBalanceProblem(text)) return fail(chat, 'That change would have broken the menu or footer.');
    }
  }

  // Forms, sign-in and buy buttons are wired to the backend; changing them is a Plan + rebuild matter.
  for (const name of Object.keys(changed)) {
    if (!PAGE_NAME.test(name)) continue;
    if (hooksOf(scanPage(name, i.files[name]!)) !== hooksOf(scanPage(name, changed[name]!))) {
      return fail(chat, 'That change touches a form, a sign-in box or a buy button. Those are set up in the Plan and the full build, so change them there.');
    }
  }

  const inputs = inputsFrom(i.latest, i.files);
  if (typeof inputs === 'string') return fail(chat, inputs);

  // A moved colour or font is a change to the style itself: read the spec back out of the new stylesheet, keeping the owner's lock.
  const next: Record<string, string> = { ...changed };
  let style: StyleSpec | null = null;
  let after = inputs;
  if (next['styles.css'] !== undefined) {
    const moved = styleMoved(next['styles.css'], inputs.style);
    if (typeof moved === 'string') return fail(chat, `That change would have left the style incomplete (${moved}).`);
    if (moved) {
      style = moved;
      next['styles.css'] = applyStyleSpec(next['styles.css'], style);
      const manifestJson = i.files['manifest.json'];
      if (typeof manifestJson === 'string') {
        const m = manifestWithStyle(manifestJson, style);
        if (m !== manifestJson) next['manifest.json'] = m;
      }
      after = { ...inputs, style };
    }
  }

  const site = { ...i.files, ...next };
  const before = verifyStored(inputs, i.files);
  const report = verifyStored(after, site);
  const known = new Set(before.problems.map(problemKey));
  const broke = report.problems.find((p) => p.severity === 'fail' && !known.has(problemKey(p)));
  if (broke) return fail(chat, `That change would have broken your site (${clip(broke.message.replace(/\s+/g, ' ').replace(/\.$/, ''), 160)}).`);

  return { chat, files: next, style, report };
}
