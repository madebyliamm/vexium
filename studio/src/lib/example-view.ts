// Framework-free logic of the EXAMPLE screen: reading the saved page + style, the vibe controls (instant token swaps), what a save has
// to write, lock rules, build progress and the wording. Pure (unit-tested under Node, test/example-view.test.ts);
// components/ExampleStage.tsx does the UI.
import { validateArtifact, type StyleSpec } from '../types/artifacts.ts';
import { ACCENTS, applyStyleSpec, contrastRatio, manifestWithStyle, parseColor, readVibe, type Theme, type Vibe } from './style.ts';

/** The four files an example build writes, in the order it writes them. */
export const EXAMPLE_FILES = ['styles.css', 'index.html', 'site.js', 'manifest.json'] as const;
export type ExampleFile = (typeof EXAMPLE_FILES)[number];

export interface ExampleFiles {
  html: string;
  css: string;
  js: string;
  manifest: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The project's files (any shape the database returns) → the four we show. */
export function pickFiles(raw: Record<string, unknown> | null | undefined): ExampleFiles {
  const f = raw ?? {};
  return { html: text(f['index.html']), css: text(f['styles.css']), js: text(f['site.js']), manifest: text(f['manifest.json']) };
}

export function filesToMap(f: ExampleFiles): Record<string, string> {
  return { 'index.html': f.html, 'styles.css': f.css, 'site.js': f.js, 'manifest.json': f.manifest };
}

/** Stored artifact data → a StyleSpec, or null when it is missing or not a valid style (then the page is treated as not built). */
export function readStyleSpec(data: unknown): StyleSpec | null {
  const r = validateArtifact('style_spec', data);
  return r.ok ? r.value : null;
}

/** A page worth showing exists: a valid style, and real files (a fresh project only has the empty starter page). */
export function hasExample(spec: StyleSpec | null, files: ExampleFiles): spec is StyleSpec {
  return spec !== null && files.html.trim().length > 200 && files.css.includes(':root');
}

// ── the draft ─────────────────────────────────────────────────────────────────────────────────────
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = stable((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Do two specs look the same? `locked` and the art-direction note are not part of the look. */
export function sameStyle(a: StyleSpec, b: StyleSpec): boolean {
  const pick = (s: StyleSpec) => JSON.stringify(stable({ vibe: s.vibe, tokens: s.tokens, fonts: s.fonts, voice: s.voice ?? '' }));
  return pick(a) === pick(b);
}

/** What the preview shows for a draft: the saved stylesheet with the draft's tokens and fonts written in. */
export function draftCss(savedCss: string, draft: StyleSpec): string {
  return applyStyleSpec(savedCss, draft);
}

export interface SavePlan {
  /** The style_spec artifact has to be saved (the look changed). */
  artifact: boolean;
  /** The files to write, by name (only the ones whose text changes). */
  files: Record<string, string>;
  /** Nothing to do. */
  nothing: boolean;
}

/**
 * What saving `draft` has to do. The stylesheet is compared with the draft written onto it — not with the saved spec — so a save that
 * stopped half-way (the style was saved, the files were not) still shows up as unsaved and the next Save finishes it.
 */
export function planSave(saved: StyleSpec, files: ExampleFiles, draft: StyleSpec): SavePlan {
  const css = draftCss(files.css, draft);
  const manifest = files.manifest ? manifestWithStyle(files.manifest, draft) : files.manifest;
  const out: Record<string, string> = {};
  if (css !== files.css) out['styles.css'] = css;
  if (manifest !== files.manifest) out['manifest.json'] = manifest;
  const artifact = !sameStyle(saved, draft);
  return { artifact, files: out, nothing: !artifact && Object.keys(out).length === 0 };
}

export const isDirty = (saved: StyleSpec, files: ExampleFiles, draft: StyleSpec): boolean => !planSave(saved, files, draft).nothing;

/** The spec to store: the draft, with the lock state the caller asks for (the look and the lock are saved together, one version). */
export function specToSave(draft: StyleSpec, locked: boolean): StyleSpec {
  return { ...draft, locked };
}

// ── the vibe controls ─────────────────────────────────────────────────────────────────────────────
export interface ControlsView extends Vibe {
  /** The ACCENTS id the accent equals, or null for a custom colour. */
  accentId: string | null;
}

export function controlsView(spec: StyleSpec): ControlsView {
  const v = readVibe(spec);
  return { ...v, accentId: ACCENTS.find((a) => a.hex.toLowerCase() === v.accent.toLowerCase())?.id ?? null };
}

export const THEMES: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** Plain-language hints about a draft's readability. Hints only — the owner can keep any colour. */
export function readabilityHints(spec: StyleSpec): string[] {
  const t = spec.tokens;
  const c = (name: string) => (t[name] ? parseColor(t[name]) : null);
  const bg = c('--bg');
  if (!bg) return [];
  const out: string[] = [];
  const text = c('--text');
  if (text && contrastRatio(text, bg) < 4.5) out.push('The text is hard to read on this background.');
  const muted = c('--text-muted');
  if (muted && contrastRatio(muted, bg) < 3) out.push('The lighter text is hard to read on this background.');
  const accent = c('--accent');
  if (accent && contrastRatio(accent, bg) < 3) out.push('This colour is faint against the page — links and highlights may be hard to see.');
  return out;
}

// ── a build in progress ───────────────────────────────────────────────────────────────────────────
export interface ProgressStep {
  file: ExampleFile;
  label: string;
  state: 'done' | 'active' | 'todo';
}

const STEP_LABELS: Record<ExampleFile, string> = {
  'styles.css': 'Choosing colours and fonts',
  'index.html': 'Writing your page',
  'site.js': 'Setting up the menu and footer',
  'manifest.json': 'Finishing up',
};

/** Which of the four files are written so far → the checklist shown while the page is built. The first unfinished step is the active one. */
export function progressSteps(done: Record<string, string>): ProgressStep[] {
  let activeSet = false;
  return EXAMPLE_FILES.map((file) => {
    const finished = typeof done[file] === 'string' && done[file]!.length > 0;
    const state: ProgressStep['state'] = finished ? 'done' : activeSet ? 'todo' : 'active';
    if (!finished) activeSet = true;
    return { file, label: STEP_LABELS[file], state };
  });
}

/** The files to show while a build is still running: as soon as the page, its stylesheet and its menu details have arrived. */
export function livePreviewFiles(streamed: Record<string, string>): ExampleFiles | null {
  const f = pickFiles(streamed);
  return f.html && f.css && f.js ? f : null;
}

// ── wording ───────────────────────────────────────────────────────────────────────────────────────
export const FIRST_RUN_MESSAGE = 'Build my landing page.';
export const REDO_MESSAGE = 'Make a fresh version of the landing page. Keep the same style unless I say otherwise, and try a different layout.';

/** The message that starts a run: the owner's note when there is one. */
export function runMessage(note: string, first: boolean): string {
  const n = note.trim();
  if (n) return n.slice(0, 2000);
  return first ? FIRST_RUN_MESSAGE : REDO_MESSAGE;
}

export type ExampleStatus = 'not_built' | 'building' | 'unsaved' | 'locked' | 'unlocked';

export function exampleStatus(s: { running: boolean; built: boolean; dirty: boolean; locked: boolean }): ExampleStatus {
  if (s.running) return 'building';
  if (!s.built) return 'not_built';
  if (s.dirty) return 'unsaved';
  return s.locked ? 'locked' : 'unlocked';
}

export const STATUS_LABELS: Record<ExampleStatus, string> = {
  not_built: 'Not built yet',
  building: 'Building…',
  unsaved: 'Unsaved changes',
  locked: 'Style locked',
  unlocked: 'Not locked yet',
};

/** Why the controls are closed right now, or null when they are open. */
export function controlsClosedReason(s: { running: boolean; locked: boolean; saving: boolean }): string | null {
  if (s.running) return 'Your page is being built — the controls open when it is done.';
  if (s.locked) return 'Your style is locked. Unlock it to change the look.';
  if (s.saving) return 'Saving…';
  return null;
}

/** What the model's reply says about the page (the saved chat line), or a stand-in. */
export function lastAssistantLine(lines: readonly { role: string; content: string }[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.role === 'assistant' && l.content.trim()) return l.content.trim();
  }
  return '';
}

/** A message from the preview page's own code, for the "something is off" line under the preview. */
export function previewProblem(message: string): string {
  const m = message.trim();
  if (!m) return 'The page reported an error.';
  return `The page reported an error: ${m.slice(0, 160)}`;
}
