// Style tokens and the "vibe" controls of the EXAMPLE stage — pure TypeScript shared by the studio (live re-skin), the ai-chat
// finisher (which derives the style spec from the CSS the model wrote) and the tests. See docs/STAGES.md "EXAMPLE stage".
//
// The idea: a generated site's whole look lives in the `:root { --token: value }` block of styles.css (docs/PROJECT_FORMAT.md). So a
// style is just a token map + a font import, and changing the theme / colour / type / density / tone is a handful of token
// swaps — instant, no model call. This file owns every rule for that:
//   • reading tokens out of a stylesheet and writing them back IN PLACE (the file stays one readable stylesheet — never an
//     appended override block, which would silently beat later edits to :root);
//   • the preset palettes, font pairings, densities and tones, and withVibe() which applies one choice to a StyleSpec;
//   • deriveStyleSpec(): the model's CSS is the source of truth, the spec is read from it (we never trust a second JSON copy).
import { isSafeFontUrl, isSafeTokenValue, type StyleSpec } from './artifacts.ts';

// ── colour maths ───────────────────────────────────────────────────────────────────────────────────
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const hex2 = (n: number): string => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** `#rgb`, `#rrggbb`, `rgb()/rgba()` and `hsl()/hsla()` (comma or space separated) → RGB. Anything else (names, color-mix, var()) → null. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) {
    const h = m[1]!;
    return { r: parseInt(h[0]! + h[0]!, 16), g: parseInt(h[1]! + h[1]!, 16), b: parseInt(h[2]! + h[2]!, 16) };
  }
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) {
    const h = m[1]!;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(v);
  if (m) return { r: clamp(+m[1]!, 0, 255), g: clamp(+m[2]!, 0, 255), b: clamp(+m[3]!, 0, 255) };
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(v);
  if (m) return hslToRgb(+m[1]!, +m[2]! / 100, +m[3]! / 100);
  return null;
}

export function rgbToHex(c: Rgb): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** A CSS colour value → `#rrggbb`, or null when it is not a plain colour. */
export function hexOf(value: string | undefined): string | null {
  if (!value) return null;
  const c = parseColor(value);
  return c ? rgbToHex(c) : null;
}

/** h in degrees 0–360, s and l in 0–1. */
export function rgbToHsl(c: Rgb): { h: number; s: number; l: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = clamp(s, 0, 1);
  const ll = clamp(l, 0, 1);
  if (ss === 0) return { r: ll * 255, g: ll * 255, b: ll * 255 };
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t: number): number => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: f(hh + 1 / 3) * 255, g: f(hh) * 255, b: f(hh - 1 / 3) * 255 };
}

const hslHex = (h: number, s: number, l: number): string => rgbToHex(hslToRgb(h, s, l));

/** WCAG relative luminance, 0 (black) – 1 (white). */
export function luminance(c: Rgb): number {
  const ch = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const INK = '#111111';
const PAPER = '#ffffff';

/** The text colour that reads best ON this background (for `--accent-contrast`). */
export function readableOn(bg: string): string {
  const c = parseColor(bg);
  if (!c) return PAPER;
  return contrastRatio(c, parseColor(PAPER)!) >= contrastRatio(c, parseColor(INK)!) ? PAPER : INK;
}

// ── presets ────────────────────────────────────────────────────────────────────────────────────────
export type Theme = 'light' | 'dark';
export type Density = 'compact' | 'comfortable' | 'airy';

export interface Accent {
  id: string;
  label: string;
  hex: string;
}
/** Mid-tone accents that hold up on both a light and a dark page. */
export const ACCENTS: readonly Accent[] = [
  { id: 'indigo', label: 'Indigo', hex: '#4f46e5' },
  { id: 'violet', label: 'Violet', hex: '#7c3aed' },
  { id: 'blue', label: 'Blue', hex: '#2563eb' },
  { id: 'teal', label: 'Teal', hex: '#0f766e' },
  { id: 'green', label: 'Green', hex: '#15803d' },
  { id: 'amber', label: 'Amber', hex: '#f59e0b' },
  { id: 'orange', label: 'Orange', hex: '#ea580c' },
  { id: 'red', label: 'Red', hex: '#dc2626' },
  { id: 'pink', label: 'Pink', hex: '#db2777' },
];

export interface FontPairing {
  id: string;
  label: string;
  /** One-line description for the picker. */
  note: string;
  display: string;
  body: string;
  /** Full `font-family` values for --font-display / --font-body. */
  displayStack: string;
  bodyStack: string;
  importUrl: string;
}

const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const SERIF = 'Georgia, "Times New Roman", serif';
const GF = 'https://fonts.googleapis.com/css2?';

export const FONT_PAIRINGS: readonly FontPairing[] = [
  { id: 'modern', label: 'Modern', note: 'Clean and neutral', display: 'Inter', body: 'Inter', displayStack: `'Inter', ${SANS}`, bodyStack: `'Inter', ${SANS}`, importUrl: `${GF}family=Inter:wght@400;500;600;700;800&display=swap` },
  { id: 'editorial', label: 'Editorial', note: 'A warm serif headline', display: 'Fraunces', body: 'Inter', displayStack: `'Fraunces', ${SERIF}`, bodyStack: `'Inter', ${SANS}`, importUrl: `${GF}family=Fraunces:wght@400;600;700&family=Inter:wght@400;500;600&display=swap` },
  { id: 'friendly', label: 'Friendly', note: 'Round and approachable', display: 'Poppins', body: 'Inter', displayStack: `'Poppins', ${SANS}`, bodyStack: `'Inter', ${SANS}`, importUrl: `${GF}family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600&display=swap` },
  { id: 'elegant', label: 'Elegant', note: 'Refined and high-contrast', display: 'Playfair Display', body: 'Source Sans 3', displayStack: `'Playfair Display', ${SERIF}`, bodyStack: `'Source Sans 3', ${SANS}`, importUrl: `${GF}family=Playfair+Display:wght@400;600;700&family=Source+Sans+3:wght@400;500;600&display=swap` },
  { id: 'technical', label: 'Technical', note: 'Sharp and modern', display: 'Space Grotesk', body: 'DM Sans', displayStack: `'Space Grotesk', ${SANS}`, bodyStack: `'DM Sans', ${SANS}`, importUrl: `${GF}family=Space+Grotesk:wght@500;600;700&family=DM+Sans:wght@400;500;600&display=swap` },
  { id: 'bold', label: 'Bold', note: 'Confident and punchy', display: 'Plus Jakarta Sans', body: 'Plus Jakarta Sans', displayStack: `'Plus Jakarta Sans', ${SANS}`, bodyStack: `'Plus Jakarta Sans', ${SANS}`, importUrl: `${GF}family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap` },
];

export const DENSITIES: readonly { id: Density; label: string; sectionY: string }[] = [
  { id: 'compact', label: 'Compact', sectionY: 'clamp(48px, 7vw, 88px)' },
  { id: 'comfortable', label: 'Comfortable', sectionY: 'clamp(64px, 9vw, 120px)' },
  { id: 'airy', label: 'Airy', sectionY: 'clamp(88px, 13vw, 168px)' },
];

export interface ToneChoice {
  id: string;
  label: string;
  /** Stored as vibe.tone. */
  tone: string;
  /** Stored as the spec's `voice`: how the copy of the full site must sound. */
  voice: string;
  radius: string;
  radiusLg: string;
}
/** A tone is how the brand feels: corner roundness now, and the voice the full build writes in. */
export const TONES: readonly ToneChoice[] = [
  { id: 'friendly', label: 'Friendly', tone: 'warm and friendly', voice: 'Warm, plain and welcoming — talk to one person, use "you", keep sentences short and skip the jargon.', radius: '14px', radiusLg: '24px' },
  { id: 'professional', label: 'Professional', tone: 'clear and professional', voice: 'Clear, calm and credible — precise words, no hype, no exclamation marks.', radius: '8px', radiusLg: '14px' },
  { id: 'bold', label: 'Bold', tone: 'bold and confident', voice: 'Direct and confident — strong verbs, short punchy lines, no hedging.', radius: '4px', radiusLg: '8px' },
  { id: 'playful', label: 'Playful', tone: 'playful and fun', voice: "Light, cheerful and a little cheeky — never at the reader's expense.", radius: '20px', radiusLg: '32px' },
  { id: 'elegant', label: 'Elegant', tone: 'calm and elegant', voice: 'Quiet, refined and unhurried — fewer words, chosen with care.', radius: '6px', radiusLg: '12px' },
];

/** The neutral tokens of a theme, lightly tinted with the accent's hue so the page feels like one palette. */
export function themeTokens(theme: Theme, accent: string): Record<string, string> {
  const c = parseColor(accent);
  const hsl = c ? rgbToHsl(c) : { h: 220, s: 0, l: 0.5 };
  const h = hsl.s < 0.08 ? 220 : hsl.h;
  if (theme === 'dark') {
    return {
      '--bg': hslHex(h, 0.28, 0.06),
      '--surface': hslHex(h, 0.22, 0.1),
      '--surface-2': hslHex(h, 0.2, 0.14),
      '--border': hslHex(h, 0.16, 0.21),
      '--text': hslHex(h, 0.2, 0.95),
      '--text-muted': hslHex(h, 0.1, 0.66),
      '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.5)',
      '--shadow-lg': '0 28px 56px -12px rgba(0, 0, 0, 0.65)',
    };
  }
  return {
    '--bg': hslHex(h, 0.3, 0.985),
    '--surface': '#ffffff',
    '--surface-2': hslHex(h, 0.25, 0.955),
    '--border': hslHex(h, 0.18, 0.89),
    '--text': hslHex(h, 0.3, 0.1),
    '--text-muted': hslHex(h, 0.1, 0.4),
    '--shadow-sm': '0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.1)',
    '--shadow-lg': '0 24px 48px -12px rgba(16, 24, 40, 0.18), 0 8px 16px -8px rgba(16, 24, 40, 0.08)',
  };
}

// ── reading a stylesheet ───────────────────────────────────────────────────────────────────────────
interface Decl {
  name: string;
  /** The value, comments stripped, trimmed. */
  value: string;
  /** Offsets of the value text in the stylesheet (what applyTokens replaces). */
  valueStart: number;
  valueEnd: number;
}
interface RootBlock {
  /** Index just after `{` / index of the closing `}`. */
  open: number;
  close: number;
  decls: Decl[];
}

/** If a comment or a quoted string starts at i, the index just past it; otherwise i. An unterminated one runs to the end. */
function skipLiteral(css: string, i: number): number {
  const ch = css[i];
  if (ch === '/' && css[i + 1] === '*') {
    const end = css.indexOf('*/', i + 2);
    return end === -1 ? css.length : end + 2;
  }
  if (ch === '"' || ch === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== ch) j += css[j] === '\\' ? 2 : 1;
    return Math.min(j + 1, css.length);
  }
  return i;
}

/** Index of the `}` matching the `{` at `open` (css.length when unterminated). */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; ) {
    const skip = skipLiteral(css, i);
    if (skip !== i) {
      i = skip;
      continue;
    }
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
    i++;
  }
  return css.length;
}

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?(\*\/|$)/g, '');

function parseDecls(css: string, from: number, to: number): Decl[] {
  const out: Decl[] = [];
  let segStart = from;
  let paren = 0;
  const flush = (segEnd: number): void => {
    const seg = css.slice(segStart, segEnd);
    // first ':' that is not inside a comment/string/paren
    let colon = -1;
    let depth = 0;
    for (let k = 0; k < seg.length; ) {
      const skip = skipLiteral(seg, k);
      if (skip !== k) {
        k = skip;
        continue;
      }
      if (seg[k] === '(' || seg[k] === '[') depth++;
      else if (seg[k] === ')' || seg[k] === ']') depth = Math.max(0, depth - 1);
      else if (seg[k] === ':' && depth === 0) {
        colon = k;
        break;
      }
      k++;
    }
    if (colon === -1) return;
    const name = stripComments(seg.slice(0, colon)).trim();
    if (!name.startsWith('--')) return;
    const raw = seg.slice(colon + 1);
    const lead = raw.length - raw.trimStart().length;
    const valueStart = segStart + colon + 1 + lead;
    const valueEnd = segStart + colon + 1 + raw.trimEnd().length;
    if (valueEnd <= valueStart) return;
    out.push({ name, value: stripComments(css.slice(valueStart, valueEnd)).trim(), valueStart, valueEnd });
  };
  for (let i = from; i < to; ) {
    const skip = skipLiteral(css, i);
    if (skip !== i) {
      i = skip;
      continue;
    }
    const ch = css[i];
    if (ch === '(' || ch === '[') paren++;
    else if (ch === ')' || ch === ']') paren = Math.max(0, paren - 1);
    else if (ch === ';' && paren === 0) {
      flush(i);
      segStart = i + 1;
    }
    i++;
  }
  flush(to);
  return out;
}

/** Every top-level `:root { … }` rule (a :root inside @media etc. is deliberately left alone). */
function scanRootBlocks(css: string): RootBlock[] {
  const blocks: RootBlock[] = [];
  let preludeStart = 0;
  for (let i = 0; i < css.length; ) {
    const skip = skipLiteral(css, i);
    if (skip !== i) {
      i = skip;
      continue;
    }
    const ch = css[i];
    if (ch === ';' || ch === '}') {
      preludeStart = i + 1;
    } else if (ch === '{') {
      const close = matchBrace(css, i);
      if (stripComments(css.slice(preludeStart, i)).trim() === ':root') {
        blocks.push({ open: i + 1, close, decls: parseDecls(css, i + 1, close) });
      }
      i = close + 1;
      preludeStart = i;
      continue;
    }
    i++;
  }
  return blocks;
}

/** All custom properties declared in the stylesheet's top-level :root rules (a later one wins, as in the cascade). */
export function parseTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of scanRootBlocks(css)) for (const d of b.decls) out[d.name] = d.value;
  return out;
}

// ── writing a stylesheet ───────────────────────────────────────────────────────────────────────────
const TOKEN_NAME = /^--[a-z0-9-]+$/i;

/** Index of the last character that is neither whitespace nor part of a comment (-1 when there is none). */
function lastCodeIndex(s: string): number {
  let i = s.length - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(s[i]!)) i--;
    if (i >= 1 && s[i] === '/' && s[i - 1] === '*') {
      const open = s.lastIndexOf('/*', i - 2);
      if (open === -1) return i;
      i = open - 1;
      continue;
    }
    return i;
  }
}

/** After any leading @charset (which must stay first), where an @import / the first rule may go. */
function afterCharset(css: string): number {
  const m = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*@charset\s+[^;]*;[ \t]*\r?\n?/i.exec(css);
  return m ? m[0].length : 0;
}

/** Index just past the leading run of @charset / @import statements (and the comments among them). */
function afterLeadingImports(css: string): number {
  let i = 0;
  for (;;) {
    const m = /^(\s*(?:\/\*[\s\S]*?\*\/\s*)*)(@(?:charset|import)\b[^;]*;)/i.exec(css.slice(i));
    if (!m) return i;
    i += m[0].length;
  }
}

/**
 * Write the tokens into the stylesheet's :root, in place: a token that is already declared gets its value replaced (everywhere it is
 * declared at the top level), the others are appended to the first :root rule (created after the @imports when there is none).
 * Everything else in the file is left byte-for-byte as it was. Tokens that are not plain CSS values are ignored.
 */
export function applyTokens(css: string, tokens: Record<string, string>): string {
  const wanted = Object.entries(tokens).filter(([k, v]) => TOKEN_NAME.test(k) && isSafeTokenValue(v)) as [string, string][];
  if (wanted.length === 0) return css;
  const byName = new Map(wanted);
  const blocks = scanRootBlocks(css);
  const edits: { start: number; end: number; text: string }[] = [];
  const placed = new Set<string>();
  for (const b of blocks) {
    for (const d of b.decls) {
      const next = byName.get(d.name);
      if (next === undefined) continue;
      placed.add(d.name);
      if (d.value !== next) edits.push({ start: d.valueStart, end: d.valueEnd, text: next });
    }
  }
  const missing = wanted.filter(([k]) => !placed.has(k));
  if (missing.length) {
    const lines = missing.map(([k, v]) => `  ${k}: ${v};\n`).join('');
    const first = blocks[0];
    if (first) {
      const before = css.slice(first.open, first.close);
      // The rule's last declaration may lack its `;` — add it right after that declaration, not after the trailing whitespace.
      const lastCode = lastCodeIndex(before);
      // Pushed first: edits are applied last-to-first and ties keep this order, so at the same index the `;` lands before the lines.
      edits.push({ start: first.close, end: first.close, text: `${before.endsWith('\n') ? '' : '\n'}${lines}` });
      if (lastCode >= 0 && before[lastCode] !== ';') edits.push({ start: first.open + lastCode + 1, end: first.open + lastCode + 1, text: ';' });
    } else {
      const at = afterLeadingImports(css);
      const head = css.slice(0, at);
      const sep = head && !head.endsWith('\n') ? '\n' : '';
      edits.push({ start: at, end: at, text: `${sep}:root {\n${lines}}\n\n` });
    }
  }
  let out = css;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const GOOGLE_IMPORT = /@import\s+(?:url\(\s*)?(['"]?)(https:\/\/fonts\.googleapis\.com\/[^'")\s;]*(?:;[^'")\s;]*)*)\1\s*\)?[^;{}]*;[ \t]*\r?\n?/gi;

/** The Google Fonts URL the stylesheet imports (several @imports are merged into one css2 URL), if any. */
export function readFontImport(css: string): string | undefined {
  const urls: string[] = [];
  for (const m of css.matchAll(GOOGLE_IMPORT)) if (isSafeFontUrl(m[2])) urls.push(m[2]!);
  return mergeFontUrls(urls);
}

/** One css2 URL for several (one `family=` per family), or the only URL as it is. */
export function mergeFontUrls(urls: string[]): string | undefined {
  if (urls.length === 0) return undefined;
  if (urls.length === 1) return urls[0];
  const families: string[] = [];
  let display = '';
  for (const u of urls) {
    const q = u.split('?')[1];
    if (!q) continue;
    for (const part of q.split('&')) {
      if (part.startsWith('family=') && !families.includes(part)) families.push(part);
      else if (part.startsWith('display=')) display = part;
    }
  }
  if (families.length === 0) return urls[0];
  const merged = `${GF}${families.join('&')}&${display || 'display=swap'}`;
  return isSafeFontUrl(merged) ? merged : urls[0];
}

/** Make the stylesheet import exactly this Google Fonts URL (or none), at the top where @import must be. */
export function setFontImport(css: string, url: string | undefined): string {
  const without = css.replace(GOOGLE_IMPORT, '');
  if (!url || !isSafeFontUrl(url)) return without;
  const at = afterCharset(without);
  return `${without.slice(0, at)}@import url('${url}');\n${without.slice(at)}`;
}

/** The stylesheet with the spec's fonts and tokens written into it (idempotent). */
export function applyStyleSpec(css: string, spec: Pick<StyleSpec, 'tokens' | 'fonts'>): string {
  return applyTokens(setFontImport(css, spec.fonts.import_url), spec.tokens);
}

// ── manifest.json follows the palette ─────────────────────────────────────────────────────────────
/** manifest.json with background_color / theme_color following the style (raw values: JSON can't use var()). Unreadable JSON is returned as it was. */
export function manifestWithStyle(manifestText: string, spec: Pick<StyleSpec, 'tokens'>): string {
  let m: unknown;
  try {
    m = JSON.parse(manifestText);
  } catch {
    return manifestText;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return manifestText;
  const out = { ...(m as Record<string, unknown>) };
  const bg = hexOf(spec.tokens['--bg']);
  const accent = hexOf(spec.tokens['--accent']);
  if (bg) out.background_color = bg;
  if (accent) out.theme_color = accent;
  return JSON.stringify(out, null, 2);
}

// ── the style spec ↔ the stylesheet ───────────────────────────────────────────────────────────────
/** First family of a font-family value: `'Fraunces', Georgia, serif` → `Fraunces`. */
export function firstFamily(value: string | undefined): string {
  if (!value) return '';
  const first = value.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').trim();
  return first.startsWith('var(') ? '' : first;
}

/** Density from the --section-y value (the largest length in it). */
export function densityOf(sectionY: string | undefined): Density {
  if (!sectionY) return 'comfortable';
  let max = 0;
  for (const m of sectionY.matchAll(/(\d*\.?\d+)\s*(px|rem|em)\b/g)) max = Math.max(max, +m[1]! * (m[2] === 'px' ? 1 : 16));
  if (max === 0) return 'comfortable';
  return max <= 100 ? 'compact' : max <= 140 ? 'comfortable' : 'airy';
}

export function themeOf(bg: string | undefined): Theme {
  const c = bg ? parseColor(bg) : null;
  return c && luminance(c) < 0.25 ? 'dark' : 'light';
}

const MAX_TOKENS = 80;
const DEFAULT_TONE = 'clear and confident';

export interface DerivedStyle {
  spec: StyleSpec;
  /** Why a style cannot be made from this stylesheet; empty when `spec` is usable. */
  problems: string[];
}

/**
 * Read a StyleSpec out of the stylesheet the model wrote. The standard tokens it left out are filled in (and written back by
 * applyStyleSpec) so a spec is always complete; a stylesheet without a background, text and accent colour has no usable style.
 * `extras` is the model's optional note — tone, voice, art direction — validated here, never trusted.
 */
export function deriveStyleSpec(css: string, extras: { tone?: unknown; voice?: unknown; art_direction?: unknown } = {}): DerivedStyle {
  const found = parseTokens(css);
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(found)) if (TOKEN_NAME.test(k) && isSafeTokenValue(v)) tokens[k] = v;
  const problems: string[] = [];
  for (const need of ['--bg', '--text', '--accent']) if (!tokens[need]) problems.push(`the stylesheet has no ${need} colour`);

  const theme = themeOf(tokens['--bg']);
  const accent = hexOf(tokens['--accent']) ?? ACCENTS[0]!.hex;
  const base = themeTokens(theme, accent);
  const defaults: Record<string, string> = {
    '--surface': base['--surface']!,
    '--surface-2': base['--surface-2']!,
    '--border': base['--border']!,
    '--text-muted': base['--text-muted']!,
    '--accent-contrast': readableOn(accent),
    '--font-display': FONT_PAIRINGS[0]!.displayStack,
    '--font-body': FONT_PAIRINGS[0]!.bodyStack,
    '--radius': '12px',
    '--radius-lg': '20px',
    '--shadow-sm': base['--shadow-sm']!,
    '--shadow-lg': base['--shadow-lg']!,
    '--container': '1200px',
    '--nav-h': '68px',
    '--section-y': DENSITIES[1]!.sectionY,
  };
  for (const [k, v] of Object.entries(defaults)) if (!tokens[k]) tokens[k] = v;
  if (Object.keys(tokens).length > MAX_TOKENS) problems.push(`the stylesheet declares too many tokens (max ${MAX_TOKENS})`);

  const importUrl = readFontImport(css);
  const tone = typeof extras.tone === 'string' && extras.tone.trim() ? extras.tone.trim().slice(0, 80) : DEFAULT_TONE;
  const spec: StyleSpec = {
    schema: 1,
    locked: false,
    vibe: { theme, density: densityOf(tokens['--section-y']), tone },
    tokens,
    fonts: { display: firstFamily(tokens['--font-display']) || 'system-ui', body: firstFamily(tokens['--font-body']) || 'system-ui', ...(importUrl ? { import_url: importUrl } : {}) },
  };
  if (typeof extras.voice === 'string' && extras.voice.trim()) spec.voice = extras.voice.trim().slice(0, 300);
  if (extras.art_direction && typeof extras.art_direction === 'object' && !Array.isArray(extras.art_direction)) {
    const json = JSON.stringify(extras.art_direction);
    if (json.length <= 4000) spec.art_direction = extras.art_direction as Record<string, unknown>;
  }
  return { spec, problems };
}

// ── vibe controls ─────────────────────────────────────────────────────────────────────────────────
export interface Vibe {
  theme: Theme;
  /** `#rrggbb`, or '' when the accent is not a plain colour. */
  accent: string;
  /** A FONT_PAIRINGS id, or null when the fonts are the model's own. */
  pairing: string | null;
  density: Density;
  /** A TONES id, or null when the tone is the model's own wording. */
  tone: string | null;
}

export function pairingOf(fonts: { display: string; body: string }): string | null {
  const d = fonts.display.trim().toLowerCase();
  const b = fonts.body.trim().toLowerCase();
  return FONT_PAIRINGS.find((p) => p.display.toLowerCase() === d && p.body.toLowerCase() === b)?.id ?? null;
}

export function toneIdOf(tone: string): string | null {
  const t = tone.trim().toLowerCase();
  return TONES.find((x) => x.tone === t)?.id ?? null;
}

/** The state of the vibe controls for a spec. */
export function readVibe(spec: StyleSpec): Vibe {
  return {
    theme: spec.vibe.theme,
    accent: hexOf(spec.tokens['--accent']) ?? '',
    pairing: pairingOf(spec.fonts),
    density: spec.vibe.density,
    tone: toneIdOf(spec.vibe.tone),
  };
}

export type VibeChange = Partial<{ theme: Theme; accent: string; pairing: string; density: Density; tone: string }>;

/** A new spec with one or more vibe choices applied — pure token swaps. Unknown ids and non-colour accents are ignored. `locked` is untouched. */
export function withVibe(spec: StyleSpec, change: VibeChange): StyleSpec {
  const next: StyleSpec = JSON.parse(JSON.stringify(spec));
  const t = next.tokens;
  const accent = change.accent ? hexOf(change.accent) : null;
  if (accent) {
    t['--accent'] = accent;
    t['--accent-contrast'] = readableOn(accent);
  }
  if (change.theme && change.theme !== next.vibe.theme && (change.theme === 'light' || change.theme === 'dark')) {
    Object.assign(t, themeTokens(change.theme, t['--accent'] ?? ACCENTS[0]!.hex));
    next.vibe.theme = change.theme;
  }
  const pairing = change.pairing ? FONT_PAIRINGS.find((p) => p.id === change.pairing) : undefined;
  if (pairing) {
    t['--font-display'] = pairing.displayStack;
    t['--font-body'] = pairing.bodyStack;
    next.fonts = { display: pairing.display, body: pairing.body, import_url: pairing.importUrl };
  }
  const density = change.density ? DENSITIES.find((d) => d.id === change.density) : undefined;
  if (density) {
    t['--section-y'] = density.sectionY;
    next.vibe.density = density.id;
  }
  const tone = change.tone ? TONES.find((x) => x.id === change.tone) : undefined;
  if (tone) {
    t['--radius'] = tone.radius;
    t['--radius-lg'] = tone.radiusLg;
    next.vibe.tone = tone.tone;
    next.voice = tone.voice;
  }
  return next;
}
