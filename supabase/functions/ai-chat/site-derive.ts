// FULL BUILD, assembly: everything about a built site that is DERIVED from the pages instead of written by the model — the backend
// rules (`_backend`), the menu and footer (`site.js`), the app manifest, and the default look of forms. Pure functions, unit-tested
// in supabase/tests/site_derive.test.ts.
//
// Why derive them: the pages are written in parallel, each knowing only its own job. `_backend` decides what a visitor may store and
// read, so it must describe exactly the forms the pages really contain — a hand-written copy can drift (a form id the backend does
// not know is rejected at submit time, on the owner's live site). Reading the rules out of the finished pages cannot drift.
import type { Manifest, Plan, StyleSpec } from '../_shared/artifacts.ts';
import { applyStyleSpec, manifestWithStyle } from '../_shared/style.ts';
import { navPages, type BuildSpec } from './build-plan.ts';
import { allEls, parseHtml, type El } from './html-lite.ts';

// ── reading the pages ───────────────────────────────────────────────────────────────────────────────

export interface FormField {
  key: string;
  type: 'text' | 'email' | 'number' | 'boolean';
  required: boolean;
  max: number | null;
}
export interface FormScan {
  id: string;
  fields: FormField[];
  /** Input names the backend would drop (anything but letters, digits, `_ . -`, ≤ 64). */
  badNames: string[];
  hasMessage: boolean;
  hasSubmit: boolean;
}
export interface AuthFormScan {
  kind: string;
  hasEmail: boolean;
  hasPassword: boolean;
  hasMessage: boolean;
  hasSubmit: boolean;
  redirect: string | null;
}
export interface PageScan {
  file: string;
  forms: FormScan[];
  authForms: AuthFormScan[];
  /** `<form>` elements with neither `data-vx-form` nor `data-vx-auth` — a form that goes nowhere. */
  strayForms: number;
  /** `data-vx-form` / `data-vx-auth` on something that is not a `<form>`. */
  hookOnWrongTag: string[];
  buys: string[];
  buyAmounts: number;
  /** Collection ids used by `vx.data.*` calls in the page's inline scripts. */
  dataIds: string[];
  ids: string[];
  requireAuth: string[];
  skipIfAuth: string[];
  redirects: string[];
}

const FIELD_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DATA_CALL = /vx\.data\.(?:submit|list|update|remove)\(\s*(['"`])([a-z0-9_-]{1,40})\1/g;
const NOT_A_FIELD = new Set(['submit', 'button', 'reset', 'image', 'file']);

function fieldOf(el: El): FormField | null {
  const key = el.attrs.name;
  if (!key) return null;
  const required = 'required' in el.attrs;
  const maxLen = Number.parseInt(el.attrs.maxlength ?? '', 10);
  const lim = Number.isInteger(maxLen) && maxLen >= 1 && maxLen <= 16_000 ? maxLen : null;
  if (el.tag === 'textarea') return { key, type: 'text', required, max: lim ?? 5000 };
  if (el.tag === 'select') return { key, type: 'text', required, max: 200 };
  const t = (el.attrs.type ?? 'text').toLowerCase();
  if (NOT_A_FIELD.has(t)) return null;
  if (t === 'email') return { key, type: 'email', required, max: null };
  if (t === 'number' || t === 'range') return { key, type: 'number', required, max: null };
  if (t === 'checkbox') return { key, type: 'boolean', required, max: null };
  return { key, type: 'text', required, max: lim ?? 500 };
}

export function scanPage(file: string, html: string): PageScan {
  const page = parseHtml(html);
  const els = allEls(page.root);
  const scan: PageScan = { file, forms: [], authForms: [], strayForms: 0, hookOnWrongTag: [], buys: [], buyAmounts: 0, dataIds: [], ids: [], requireAuth: [], skipIfAuth: [], redirects: [] };

  for (const el of els) {
    if (el.attrs.id) scan.ids.push(el.attrs.id);
    if ('data-vx-buy' in el.attrs && el.attrs['data-vx-buy']) scan.buys.push(el.attrs['data-vx-buy']);
    if ('data-vx-buy-amount' in el.attrs) scan.buyAmounts++;
    if (el.attrs['data-vx-require-auth']) scan.requireAuth.push(el.attrs['data-vx-require-auth']);
    if (el.attrs['data-vx-skip-if-auth']) scan.skipIfAuth.push(el.attrs['data-vx-skip-if-auth']);
    if (el.attrs['data-vx-redirect']) scan.redirects.push(el.attrs['data-vx-redirect']);
    if (el.tag !== 'form') {
      if ('data-vx-form' in el.attrs) scan.hookOnWrongTag.push(`data-vx-form="${el.attrs['data-vx-form']}" on a <${el.tag}>`);
      if ('data-vx-auth' in el.attrs) scan.hookOnWrongTag.push(`data-vx-auth="${el.attrs['data-vx-auth']}" on a <${el.tag}>`);
    }
  }

  for (const form of els.filter((e) => e.tag === 'form')) {
    const inside = allEls(form);
    const hasMessage = inside.some((e) => 'data-vx-message' in e.attrs);
    const hasSubmit = inside.some((e) => (e.tag === 'button' && (e.attrs.type ?? 'submit').toLowerCase() === 'submit') || (e.tag === 'input' && ['submit', 'image'].includes((e.attrs.type ?? '').toLowerCase())));
    const inputs = inside.filter((e) => e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select');
    if ('data-vx-auth' in form.attrs) {
      const names = inputs.map((e) => `${e.attrs.name ?? ''}:${(e.attrs.type ?? 'text').toLowerCase()}`);
      scan.authForms.push({
        kind: form.attrs['data-vx-auth'] ?? '',
        hasEmail: names.some((n) => n.startsWith('email:')),
        hasPassword: names.some((n) => n.startsWith('password:')),
        hasMessage,
        hasSubmit,
        redirect: form.attrs['data-vx-redirect'] ?? null,
      });
    } else if ('data-vx-form' in form.attrs) {
      const fields: FormField[] = [];
      const badNames: string[] = [];
      for (const input of inputs) {
        const f = fieldOf(input);
        if (!f) continue;
        if (!FIELD_KEY_RE.test(f.key)) badNames.push(f.key.slice(0, 40));
        else if (!fields.some((x) => x.key === f.key)) fields.push(f);
      }
      scan.forms.push({ id: (form.attrs['data-vx-form'] ?? '').trim().toLowerCase(), fields, badNames, hasMessage, hasSubmit });
    } else {
      scan.strayForms++;
    }
  }

  for (const s of page.scripts) {
    if (s.src) continue;
    for (const m of s.code.matchAll(DATA_CALL)) if (!scan.dataIds.includes(m[2]!)) scan.dataIds.push(m[2]!);
  }
  return scan;
}

// ── _backend ────────────────────────────────────────────────────────────────────────────────────────

interface CollectionRule {
  id: string;
  label: string;
  fields: { key: string; type: string; required: boolean; max?: number }[];
  read: 'public' | 'user' | 'owner';
  write: 'public' | 'user' | 'owner';
  max_rows: number;
  notify_owner: boolean;
}
export interface BackendRules {
  collections: CollectionRule[];
  auth: { enabled: boolean };
  products: { id: string; name: string; price_cents: number }[];
}

const COLLECTION_RE = /^[a-z0-9_-]{1,40}$/;
/** Forms where the owner wants to hear about every submission (a lead is a person waiting for an answer). */
const NOTIFY_LIKE = /contact|inquir|enquir|message|quote|book|reserv|appoint|request|support|feedback|order|apply|application|hire/;

const titleCase = (id: string): string => id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Whether site-api would take this collection id (the same rule it applies when reading `_backend`). */
export function validCollectionId(id: string): boolean {
  return COLLECTION_RE.test(id) && id !== 'transactions' && !id.startsWith('_');
}

export function deriveBackend(spec: BuildSpec, scans: PageScan[]): { rules: BackendRules; json: string; summary: Manifest['backend'] } {
  const auth = spec.auth || scans.some((s) => s.authForms.length > 0);
  const byId = new Map<string, FormField[]>();
  const used = new Set<string>();
  for (const scan of scans) {
    for (const f of scan.forms) {
      if (!validCollectionId(f.id)) continue;
      const have = byId.get(f.id);
      if (!have) byId.set(f.id, f.fields.map((x) => ({ ...x })));
      else {
        // A field only some copies of the form have cannot be required.
        for (const mine of have) if (!f.fields.some((x) => x.key === mine.key)) mine.required = false;
        for (const field of f.fields) {
          const same = have.find((x) => x.key === field.key);
          if (!same) have.push({ ...field, required: false });
          else same.required = same.required && field.required;
        }
      }
    }
    for (const id of scan.dataIds) if (validCollectionId(id)) used.add(id);
  }

  const collections: CollectionRule[] = [];
  for (const [id, fields] of byId) {
    collections.push({
      id,
      label: titleCase(id),
      fields: fields.slice(0, 50).map((f) => ({ key: f.key, type: f.type, required: f.required, ...(f.max ? { max: f.max } : {}) })),
      read: 'owner',
      write: 'public',
      max_rows: 10_000,
      notify_owner: NOTIFY_LIKE.test(id),
    });
  }
  // Stores the plan asked for (or the page scripts use) that no form fills: free-form rows, scoped to the signed-in user when there are accounts.
  for (const id of [...spec.forms, ...used]) {
    if (!validCollectionId(id) || byId.has(id) || collections.some((c) => c.id === id)) continue;
    collections.push({ id, label: titleCase(id), fields: [], read: auth ? 'user' : 'owner', write: auth ? 'user' : 'public', max_rows: 10_000, notify_owner: false });
  }

  const products = spec.products.filter((p) => p.sellable && p.price_cents !== null).map((p) => ({ id: p.id, name: p.name.slice(0, 120), price_cents: p.price_cents as number }));
  const rules: BackendRules = { collections: collections.slice(0, 50), auth: { enabled: auth }, products };
  return {
    rules,
    json: JSON.stringify(rules, null, 2),
    summary: { collections: rules.collections.map((c) => c.id), products: products.map((p) => p.id), forms: [...byId.keys()], auth },
  };
}

// ── site.js ─────────────────────────────────────────────────────────────────────────────────────────

const LEGAL_PAGE = /privacy|terms|legal|cookie|imprint|disclaimer|policy/;
const MAX_NAV = 6;

const STRING = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')`;
function jsString(raw: string): string | null {
  try {
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : (JSON.parse(`"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string);
  } catch {
    return null;
  }
}

/** The few values worth keeping from the example's hand-written site.js. Read with patterns, never run: that file came from a model. */
export function readPreviousSite(siteJs: string | undefined): { tagline: string | null; cta: { label: string; href: string } | null; titles: string[] } {
  const out = { tagline: null as string | null, cta: null as { label: string; href: string } | null, titles: [] as string[] };
  if (!siteJs) return out;
  const tag = new RegExp(String.raw`\btagline\s*:\s*${STRING}`).exec(siteJs);
  const t = tag ? jsString(tag[1]!) : null;
  if (t && t.trim()) out.tagline = t.trim().slice(0, 160);
  const cta = /\bcta\s*:\s*\{([^{}]*)\}/.exec(siteJs);
  if (cta) {
    const label = new RegExp(String.raw`\blabel\s*:\s*${STRING}`).exec(cta[1]!);
    const href = new RegExp(String.raw`\bhref\s*:\s*${STRING}`).exec(cta[1]!);
    const l = label ? jsString(label[1]!) : null;
    const h = href ? jsString(href[1]!) : null;
    if (l && h) out.cta = { label: l.trim().slice(0, 40), href: h.trim() };
  }
  const cols = siteJs.slice(Math.max(0, siteJs.search(/\bcolumns\s*:/)));
  for (const m of cols.matchAll(new RegExp(String.raw`\btitle\s*:\s*${STRING}`, 'g'))) {
    const s = jsString(m[1]!);
    if (s && s.trim()) out.titles.push(s.trim().slice(0, 40));
  }
  return out;
}

interface SiteInput {
  plan: Plan;
  spec: BuildSpec;
  /** The example's site.js (or whatever is in the project now). */
  previous: string | undefined;
  /** An owner-uploaded logo image in the project, if any. */
  logo: string | null;
  /** Anchor ids of each generated page, to check the CTA's `page.html#id`. */
  idsByPage: Record<string, string[]>;
  /** Pages that send signed-out visitors to the login page — shown in the menu only when signed in. */
  protectedPages: Set<string>;
}

function validTarget(href: string, spec: BuildSpec, idsByPage: Record<string, string[]>): boolean {
  if (/^(https:\/\/|mailto:|tel:)/i.test(href)) return true;
  const [file, anchor] = href.split('#') as [string, string | undefined];
  if (!spec.pages.some((p) => p.file === file)) return false;
  return anchor === undefined || anchor === '' ? true : (idsByPage[file] ?? []).includes(anchor);
}

export function deriveSiteJs(i: SiteInput): string {
  const prev = readPreviousSite(i.previous);
  const nav = navPages(i.spec);
  const login = i.spec.pages.find((p) => p.role === 'login');
  const signup = i.spec.pages.find((p) => p.role === 'signup');
  const menuPages = nav.filter((p) => !LEGAL_PAGE.test(p.file));
  const shown = menuPages.slice(0, MAX_NAV);

  const items: Record<string, unknown>[] = shown.map((p) => ({ label: p.title, href: p.file, ...(i.protectedPages.has(p.file) ? { show: 'in' } : {}) }));
  if (i.spec.auth && login) {
    items.push({ label: login.title, href: login.file, show: 'out' });
    items.push({ label: 'Log out', action: 'logout', show: 'in' });
  }
  const cta =
    i.spec.auth && signup
      ? { label: signup.title, href: signup.file, show: 'out' }
      : prev.cta && validTarget(prev.cta.href, i.spec, i.idsByPage)
        ? { label: prev.cta.label, href: prev.cta.href }
        : null;

  const columns: { title: string; links: { label: string; href: string }[] }[] = [];
  const pagesCol = nav.filter((p) => !i.protectedPages.has(p.file) && !LEGAL_PAGE.test(p.file)).map((p) => ({ label: p.title, href: p.file }));
  if (pagesCol.length) columns.push({ title: prev.titles[0] ?? 'Pages', links: pagesCol });
  const legalCol = nav.filter((p) => LEGAL_PAGE.test(p.file)).map((p) => ({ label: p.title, href: p.file }));
  if (legalCol.length) columns.push({ title: 'Legal', links: legalCol });

  const site: Record<string, unknown> = { name: i.plan.name.trim().slice(0, 80) || 'My site' };
  if (i.logo) site.logo = i.logo;
  site.nav = items;
  if (cta) site.cta = cta;
  site.footer = {
    tagline: prev.tagline ?? i.plan.one_liner.trim().slice(0, 160),
    columns,
    social: [],
    legal: `© {year} ${site.name as string}`,
  };
  return `// Brand, menu and footer for every page. Configuration only — change it here, not in the pages.\nwindow.SITE = ${JSON.stringify(site, null, 2)};\n`;
}

// ── manifest.json ───────────────────────────────────────────────────────────────────────────────────

function shortName(name: string): string {
  const n = name.trim();
  if (n.length <= 12) return n;
  const first = n.split(/\s+/)[0]!;
  return first.length >= 3 && first.length <= 12 ? first : n.slice(0, 12).trim();
}

export function deriveManifestJson(plan: Plan, style: Pick<StyleSpec, 'tokens'>): string {
  const base: Record<string, unknown> = { name: plan.name.trim().slice(0, 80) || 'My site', short_name: shortName(plan.name) || 'Site' };
  if (plan.one_liner.trim()) base.description = plan.one_liner.trim().slice(0, 200);
  base.start_url = 'index.html';
  base.display = 'standalone';
  return manifestWithStyle(JSON.stringify(base), style);
}

// ── default form look ───────────────────────────────────────────────────────────────────────────────

const KIT_OPEN = '/* vx-form-kit */';
const KIT_CLOSE = '/* /vx-form-kit */';
/**
 * A default look for forms, their status line and buy buttons, so a page that has them is usable before anyone styles them. Every
 * selector sits inside :where() — specificity zero — so any rule the site's own stylesheet or a page writes wins, and it only ever uses
 * the style's tokens (nothing here can clash with the locked style).
 */
export const FORM_KIT = `${KIT_OPEN}
:where([data-vx-form] :is(input:not([type=checkbox]):not([type=radio]), textarea, select), [data-vx-auth] :is(input:not([type=checkbox]):not([type=radio]), textarea, select)) {
  box-sizing: border-box; width: 100%; padding: 12px 14px; font: inherit; color: var(--text);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
}
:where([data-vx-form], [data-vx-auth]) { display: grid; gap: 14px; max-width: 520px; }
:where([data-vx-form] label, [data-vx-auth] label) { display: grid; gap: 6px; font-weight: 600; font-size: 0.9rem; color: var(--text); }
:where([data-vx-form] :is(input, textarea, select):focus-visible, [data-vx-auth] :is(input, textarea, select):focus-visible) {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 1px; border-color: var(--accent);
}
:where([data-vx-form] :is(button, input[type=submit]), [data-vx-auth] :is(button, input[type=submit])) {
  cursor: pointer; font: inherit; font-weight: 600; padding: 12px 22px; border: 0; border-radius: var(--radius);
  background: var(--accent); color: var(--accent-contrast);
}
:where([data-vx-message]) { margin: 0; min-height: 1.3em; font-size: 0.9rem; color: var(--text-muted); }
:where([data-vx-state=error] [data-vx-message]) { color: var(--danger, currentColor); }
:where([data-vx-state=sent] [data-vx-message]) { color: var(--success, currentColor); }
:where([data-vx-state=sending]) { cursor: progress; }
:where([data-vx-buy], [data-vx-buy-amount]) { cursor: pointer; }
${KIT_CLOSE}
`;

/** styles.css with the style's tokens and fonts written in, and the form kit appended (replacing an older copy of it). */
export function finishStylesheet(css: string, style: Pick<StyleSpec, 'tokens' | 'fonts'>): string {
  const open = css.indexOf(KIT_OPEN);
  let base = css;
  if (open !== -1) {
    const close = css.indexOf(KIT_CLOSE, open);
    base = css.slice(0, open) + (close === -1 ? '' : css.slice(close + KIT_CLOSE.length).replace(/^\r?\n/, ''));
  }
  return `${applyStyleSpec(base, style).replace(/\s+$/, '')}\n\n${FORM_KIT}`;
}

// ── putting it together ─────────────────────────────────────────────────────────────────────────────

export interface AssembleInput {
  plan: Plan;
  spec: BuildSpec;
  style: StyleSpec;
  /** projects.files as it is now (the example's styles.css/site.js, uploaded images, memory files…). */
  projectFiles: Record<string, string>;
  /** The page HTML the build produced, by file name. */
  pages: Record<string, string>;
}
export interface Assembled {
  /** Every file to write, including `_backend`. */
  files: Record<string, string>;
  /** Pages of an earlier build that the plan no longer has. */
  remove: string[];
  rules: BackendRules;
  backendSummary: Manifest['backend'];
  scans: PageScan[];
}

export function assembleSite(i: AssembleInput): Assembled {
  const scans = i.spec.pages.filter((p) => i.pages[p.file] !== undefined).map((p) => scanPage(p.file, i.pages[p.file]!));
  const { rules, json, summary } = deriveBackend(i.spec, scans);
  const protectedPages = new Set(scans.filter((s) => s.requireAuth.length > 0).map((s) => s.file));
  const idsByPage = Object.fromEntries(scans.map((s) => [s.file, s.ids]));
  const logo = Object.keys(i.projectFiles).find((n) => /^logo\.(png|jpe?g|webp|svg|gif)$/i.test(n)) ?? null;

  const files: Record<string, string> = {};
  for (const p of i.spec.pages) {
    const html = i.pages[p.file];
    if (html !== undefined) files[p.file] = `${html.trim()}\n`;
  }
  files['styles.css'] = finishStylesheet(i.projectFiles['styles.css'] ?? '', i.style);
  files['site.js'] = deriveSiteJs({ plan: i.plan, spec: i.spec, previous: i.projectFiles['site.js'], logo, idsByPage, protectedPages });
  files['manifest.json'] = deriveManifestJson(i.plan, i.style);
  files['_backend'] = json;

  const keep = new Set(i.spec.pages.map((p) => p.file));
  const remove = Object.keys(i.projectFiles).filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html$/.test(n) && !keep.has(n));
  return { files, remove, rules, backendSummary: summary, scans };
}
