// TWEAKS screen logic that needs no browser (unit-tested under Node, test/tweaks-view.test.ts): what the owner pointed at, in words; the
// ideas offered for it; what to send to the AI; the list of saved versions and what undo / redo would do; what a finished run means.
// components/TweaksStage.tsx is the thin shell around this; api/tweaks.ts does the network.
import type { StageDone } from '../api/ai.ts';
import { timeAgo } from './format.ts';
import { historyToSend, type ChatLine } from './plan-view.ts';
import type { PickedElement } from './preview.ts';

// ── device frames ───────────────────────────────────────────────────────────────────────────────────

export type Device = 'desktop' | 'tablet' | 'phone';
/** `width` is the screen's width in CSS pixels (what the page's media queries see); `outer` adds the bezel. null = as wide as the space allows. */
export const DEVICES: readonly { id: Device; label: string; width: number | null; outer: number | null }[] = [
  { id: 'desktop', label: 'Desktop', width: null, outer: null },
  { id: 'tablet', label: 'Tablet', width: 768, outer: 796 },
  { id: 'phone', label: 'Phone', width: 390, outer: 414 },
];

/** How much to shrink a device frame so it fits the space it is shown in (never enlarged; never unreadably small). */
export function fitScale(available: number, outer: number | null): number {
  if (outer === null || !(available > 0)) return 1;
  return Math.max(0.4, Math.min(1, Math.round((available / outer) * 100) / 100));
}

// ── what the owner pointed at ───────────────────────────────────────────────────────────────────────

const NAMES: Record<string, string> = {
  h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading',
  p: 'Paragraph', a: 'Link', button: 'Button', img: 'Image', picture: 'Image', svg: 'Icon', ul: 'List', ol: 'List', li: 'List item',
  form: 'Form', input: 'Form field', textarea: 'Form field', select: 'Form field', label: 'Form label',
  nav: 'Menu', header: 'Header', footer: 'Footer', section: 'Section', article: 'Card', main: 'Page', figure: 'Image', figcaption: 'Caption',
  blockquote: 'Quote', span: 'Text', div: 'Block', strong: 'Text', em: 'Text', small: 'Text', video: 'Video',
};
const TEXTUAL = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'li', 'span', 'label', 'blockquote', 'strong', 'em', 'small', 'figcaption']);

/** "Heading", "Button", "Section"… — what a person would call it. */
export function pointedName(p: Pick<PickedElement, 'tag'>): string {
  return NAMES[p.tag] ?? 'Element';
}

/** One line for the "you're pointing at" chip: the name, and its words when it has some. */
export function pointedLabel(p: PickedElement): string {
  const words = p.text.length > 40 ? `${p.text.slice(0, 39).trimEnd()}…` : p.text;
  return words ? `${pointedName(p)} “${words}”` : pointedName(p);
}

/** A few things worth asking for, given what is pointed at (or the site as a whole when nothing is). */
export function ideasFor(p: PickedElement | null): string[] {
  if (!p) return ['Make the headline bigger', 'Change the accent colour', 'Add more space between sections'];
  if (/^h[1-6]$/.test(p.tag)) return ['Make this bigger', 'Change the words', 'Centre this'];
  if (p.tag === 'button' || p.tag === 'a') return ['Make this stand out more', 'Change what it says', 'Make this bigger'];
  if (p.tag === 'img' || p.tag === 'picture' || p.tag === 'figure') return ['Make this smaller', 'Round the corners', 'Centre this'];
  if (TEXTUAL.has(p.tag)) return ['Change the words', 'Make the text bigger', 'Make this one line shorter'];
  return ['Add more space around this', 'Change the background colour', 'Centre everything in here'];
}

// ── what to send ────────────────────────────────────────────────────────────────────────────────────

/** A request is at most this long (the server caps it too). */
export const TWEAK_MAX = 2000;

/** How much of the conversation goes with a request: a change is made on what was just said, not on the whole afternoon. */
export const TWEAK_HISTORY = 8;

/** The conversation to send: the recent tail, starting and ending with the owner. */
export function tweakHistory(lines: readonly ChatLine[]): { role: 'user' | 'assistant'; content: string }[] {
  return historyToSend(lines, TWEAK_HISTORY);
}

export const TWEAK_GREETING =
  'Click anything on your site, then tell me what to change — “make this bigger”, “say Book a call”, “use a softer colour”. Or just describe it. Every change goes into your draft, and you can undo it.';

// ── saved versions ──────────────────────────────────────────────────────────────────────────────────

export type VersionKind = 'stage' | 'tweak' | 'baseline';

export interface Version {
  seq: number;
  kind: VersionKind;
  label: string;
  current: boolean;
  createdAt: string;
}

export const KIND_LABELS: Record<VersionKind, string> = { stage: 'Step', tweak: 'Change', baseline: 'Start' };

/** `site_snapshots` rows → versions, oldest first. Anything that isn't a row of that table is dropped. */
export function readVersions(rows: unknown): Version[] {
  if (!Array.isArray(rows)) return [];
  const out: Version[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    if (typeof x.seq !== 'number' || !Number.isInteger(x.seq)) continue;
    const kind: VersionKind = x.kind === 'stage' || x.kind === 'tweak' || x.kind === 'baseline' ? x.kind : 'tweak';
    out.push({ seq: x.seq, kind, label: typeof x.label === 'string' && x.label ? x.label : KIND_LABELS[kind], current: x.is_current === true, createdAt: typeof x.created_at === 'string' ? x.created_at : '' });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export interface HistoryState {
  /** The version the site is at; null when no version is saved yet. */
  current: Version | null;
  canUndo: boolean;
  canRedo: boolean;
  /** What "Undo" goes back to / "Redo" goes forward to. */
  undoTo: Version | null;
  redoTo: Version | null;
}

export function historyState(versions: readonly Version[]): HistoryState {
  const at = versions.findIndex((v) => v.current);
  if (at < 0) return { current: null, canUndo: false, canRedo: false, undoTo: null, redoTo: null };
  const undoTo = versions[at - 1] ?? null;
  const redoTo = versions[at + 1] ?? null;
  return { current: versions[at]!, canUndo: undoTo !== null, canRedo: redoTo !== null, undoTo, redoTo };
}

/** "Now: Make the headline bigger · 5 min ago" style line for one version. */
export function versionLine(v: Version, now: number = Date.now()): string {
  const when = timeAgo(v.createdAt, now);
  return when ? `${v.label} · ${when}` : v.label;
}

/** The newest first, for the list the owner picks a version from. */
export function newestFirst(versions: readonly Version[]): Version[] {
  return [...versions].sort((a, b) => b.seq - a.seq);
}

/** What an undo / redo / restore answered → the sentence to show. */
export function moveNotice(action: 'undo' | 'redo' | 'restore', out: { moved?: boolean; label?: string; error?: string; checked?: boolean; fails?: number }): string {
  if (!out.moved) return out.error || 'Nothing was changed.';
  const at = out.label ? ` “${out.label}”` : '';
  const base = action === 'undo' ? `Undone — your site is back at${at || ' the version before'}.` : action === 'redo' ? `Redone — your site is at${at || ' the next version'}.` : `Your site is back at${at || ' that version'}.`;
  const fails = out.checked ? (out.fails ?? 0) : 0;
  return fails > 0 ? `${base} The launch check found ${fails === 1 ? 'a problem' : `${fails} problems`} in this version.` : base;
}

/** Same files, same text? (Reading the site again after a change should not reload the preview when nothing differs.) */
export function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

// ── a finished run ──────────────────────────────────────────────────────────────────────────────────

export type TweakOutcome =
  | { kind: 'changed'; files: string[] }
  | { kind: 'chat' }
  | { kind: 'failed'; error: string };

/** What a finished run did: it changed the draft, it only talked, or it did not work (and nothing was changed). */
export function tweakOutcome(done: StageDone | null, streamError: string | null): TweakOutcome {
  if (!done) return { kind: 'failed', error: streamError || 'The connection was interrupted. If your change was still being made it will appear here when it is done.' };
  if (!done.ok) return { kind: 'failed', error: done.error || 'That change could not be made. Nothing was changed.' };
  const files = done.changed ?? [];
  return files.length > 0 ? { kind: 'changed', files } : { kind: 'chat' };
}

/** Which of the site's pages a change touched, in the owner's words ("Home, Shop"). The shared files are not pages. */
export function changedPages(files: readonly string[], pages: readonly { file: string; title: string }[]): string[] {
  return files.filter((f) => f.endsWith('.html')).map((f) => pages.find((p) => p.file === f)?.title ?? f);
}

/** One sentence on what a change touched: the pages in the owner's words, and whether the shared look or menu moved with them. */
export function changeSummary(files: readonly string[], pages: readonly { file: string; title: string }[]): string {
  const named = changedPages(files, pages);
  const look = files.includes('styles.css');
  const menu = files.includes('site.js');
  const parts: string[] = [];
  if (named.length > 0) parts.push(named.join(', '));
  if (look) parts.push(named.length > 0 ? 'the style' : 'the style of every page');
  if (menu) parts.push('the menu and footer');
  if (parts.length === 0) return 'Your site was updated.';
  return `Updated ${parts.join(' and ')}.`;
}

/** Why a change cannot be made right now (the server refuses it too), or null. A stale plan or style has to be kept or rebuilt first. */
export function tweaksBlocker(x: { hasSite: boolean; planStale: boolean; styleStale: boolean }): string | null {
  if (!x.hasSite) return 'There is no built site to change yet. Go back and build your full site first.';
  if (x.planStale && x.styleStale) return 'Your plan and style are out of date. Keep them as they are before making changes.';
  if (x.planStale) return 'Your plan is out of date. Keep it as it is before making changes.';
  if (x.styleStale) return 'Your plan changed after your style was set. Keep the style as it is before making changes.';
  return null;
}

/** Edits are a draft until the owner publishes; once a site is live, say that the live one stays as it is. */
export function draftNote(published: boolean): string {
  return published
    ? 'Your changes are saved as a draft. The live site stays as it is until you publish again.'
    : 'Your changes are saved as a draft. Visitors only see your site once you publish it.';
}
