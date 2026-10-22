// FULL BUILD, step one: turn the owner's PLAN into the build's task list — which pages to write, which page hosts which form and
// which products, which products can really be sold online. Pure functions (no I/O), unit-tested in supabase/tests/build_plan.test.ts.
//
// Why this is code and not left to the model: the pages are written in PARALLEL, each by its own AI call that sees only its own
// assignment. Two pages that each decide "I'll host the contact form" (or neither does) is exactly the kind of mistake parallel work
// makes, so the platform decides who hosts what, and the verifier (verifier.ts) checks that it happened.
import type { Plan, PlannedPage } from '../_shared/artifacts.ts';

/** More pages than this is a different product; the owner can add the rest with TWEAKS. */
export const MAX_BUILD_PAGES = 16;

export type PageRole = 'home' | 'page' | 'login' | 'signup';

export interface BuildPage {
  file: string;
  title: string;
  purpose: string;
  role: PageRole;
  /** true = the platform added it (login/signup for a site with accounts), the plan did not list it. */
  auto: boolean;
  /** Form / collection ids this page must host. */
  forms: string[];
  /** Ids of the products this page sells (BuildProduct.id). */
  products: string[];
}

export interface BuildProduct {
  /** Checkout id: lowercase letters, digits, dashes. This is what `data-vx-buy` and `_backend.products` use. */
  id: string;
  name: string;
  /** null = the owner has not given a price. */
  price_cents: number | null;
  interval?: 'month' | 'year';
  /** true = a one-time price ≥ 50 cents: it gets a working checkout button. */
  sellable: boolean;
}

export interface BuildSpec {
  pages: BuildPage[];
  /** Every form / collection id from the plan, in plan order (slugged). */
  forms: string[];
  /** The ids that are in the plan's `forms` list (a visitor-facing `<form data-vx-form>` is required); the rest are plain data stores. */
  formIds: string[];
  products: BuildProduct[];
  auth: boolean;
  /** Where signing in / signing up sends the visitor. */
  afterLogin: string;
  /** Plain-English things the build cannot do for the owner (shown in the report, never silently dropped). */
  open_items: string[];
}

const COLLECTION_RE = /^[a-z0-9_-]{1,40}$/;

export function slug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

const words = (s: string): string[] => slug(s).split('-').filter((w) => w.length > 2);

/** A collection id the backend accepts, or '' (reserved names and `_`-ids are refused by site-api). */
function collectionId(raw: string): string {
  const id = slug(raw);
  if (!COLLECTION_RE.test(id) || id === 'transactions' || id.startsWith('_')) return '';
  return id;
}

const LOGIN_FILE = /^(log-?in|sign-?in)\b/i;
const SIGNUP_FILE = /^(sign-?up|register|join)\b/i;

function roleOf(p: PlannedPage): PageRole {
  const base = p.file.replace(/\.html$/i, '');
  if (base.toLowerCase() === 'index') return 'home';
  if (LOGIN_FILE.test(base)) return 'login';
  if (SIGNUP_FILE.test(base)) return 'signup';
  return 'page';
}

const WAITLIST_LIKE = /waitlist|newsletter|subscri|signup|sign-up|join|lead|notify|updates|early/;
const CONTACT_LIKE = /contact|inquir|enquir|message|quote|book|reserv|appoint|request|support|feedback|order|apply|application/;
const CONTACT_PAGE = /contact|book|reserv|appoint|quote|support|inquir|enquir|get-in-touch|reach/;
const SHOP_PAGE = /shop|store|product|pricing|price|plans|menu|buy|order|catalog|collection|merch|donat/;

function pageText(p: BuildPage): string {
  return `${p.file.replace(/\.html$/i, '')} ${p.title} ${p.purpose}`.toLowerCase();
}

/** How well a page fits a thing (a form or product) by name: file name counts most, then the title, then the purpose. */
function fit(p: BuildPage, label: string): number {
  const toks = words(label);
  if (!toks.length) return 0;
  const file = p.file.toLowerCase();
  const title = p.title.toLowerCase();
  const purpose = p.purpose.toLowerCase();
  let score = 0;
  for (const t of toks) {
    if (file.includes(t)) score += 3;
    if (title.includes(t)) score += 2;
    if (purpose.includes(t)) score += 1;
  }
  return score;
}

/** Pick the page that should host `label`. `fallback` decides when nothing fits by name; `min` is the weakest fit that counts (2 = the file or title names it, 1 = the purpose line mentions it). */
function bestPage(pages: BuildPage[], label: string, fallback: (pages: BuildPage[]) => BuildPage | undefined, min = 1): BuildPage | undefined {
  let best: BuildPage | undefined;
  let bestScore = min - 1;
  for (const p of pages) {
    const s = fit(p, label);
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return best ?? fallback(pages);
}

function productsOf(plan: Plan, open: string[]): BuildProduct[] {
  const items = plan.pricing.items;
  const names = plan.backend.products.map((n) => n.trim()).filter(Boolean);
  const used = new Set<number>();
  const out: BuildProduct[] = [];
  const takenIds = new Set<string>();
  const idFor = (name: string): string => {
    const base = slug(name) || 'item';
    let id = base;
    for (let n = 2; takenIds.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
    takenIds.add(id);
    return id;
  };
  const match = (name: string): number => {
    const s = slug(name);
    let idx = items.findIndex((it, i) => !used.has(i) && slug(it.name) === s);
    if (idx >= 0) return idx;
    idx = items.findIndex((it, i) => !used.has(i) && (slug(it.name).includes(s) || s.includes(slug(it.name))) && slug(it.name) !== '');
    if (idx >= 0) return idx;
    const toks = words(name);
    idx = items.findIndex((it, i) => !used.has(i) && words(it.name).some((w) => toks.includes(w)));
    if (idx >= 0) return idx;
    // One named product and one price: they belong together even if the names differ ("Candle" ↔ "Standard").
    if (names.length === 1 && items.length === 1 && !used.has(0)) return 0;
    return -1;
  };

  for (const name of names) {
    const i = match(name);
    const item = i >= 0 ? items[i] : undefined;
    if (i >= 0) used.add(i);
    out.push(toProduct(idFor(name), name, item, open));
  }
  // Prices the owner stated that no named product claimed: a one-time price is something to sell; other models are shown, not sold.
  if (plan.pricing.model === 'one_time' || plan.pricing.model === 'subscription') {
    items.forEach((it, i) => {
      if (!used.has(i)) out.push(toProduct(idFor(it.name), it.name, it, open));
    });
  }
  return out.slice(0, 50);
}

function toProduct(id: string, name: string, item: Plan['pricing']['items'][number] | undefined, open: string[]): BuildProduct {
  if (!item || !(item.price_cents > 0)) {
    // price 0 on a one-time product reads as "free": nothing to charge, nothing to open.
    if (item && item.price_cents === 0) return { id, name, price_cents: 0, sellable: false };
    open.push(`Set a price for "${name}" — until then it is shown without a price and has no buy button.`);
    return { id, name, price_cents: null, sellable: false };
  }
  if (item.interval) {
    open.push(`"${name}" is a ${item.interval === 'month' ? 'monthly' : 'yearly'} price. Online payment only supports one-time purchases for now, so the page shows the price and sends visitors to get in touch instead of a buy button.`);
    return { id, name, price_cents: item.price_cents, interval: item.interval, sellable: false };
  }
  if (item.price_cents < 50) {
    open.push(`"${name}" costs under $0.50, which is below what card payments allow — it is shown without a buy button.`);
    return { id, name, price_cents: item.price_cents, sellable: false };
  }
  return { id, name, price_cents: item.price_cents, sellable: true };
}

/** The plan's pages, plus whatever the backend needs that the plan did not list, with every form and product given a home. */
export function planBuild(plan: Plan): BuildSpec {
  const open: string[] = [];
  const seen = new Set<string>();
  const pages: BuildPage[] = [];
  for (const p of plan.pages) {
    const file = p.file.toLowerCase();
    if (seen.has(file)) continue;
    seen.add(file);
    pages.push({ file, title: p.title.trim() || file, purpose: p.purpose.trim(), role: roleOf({ ...p, file }), auto: false, forms: [], products: [] });
  }
  if (!seen.has('index.html')) {
    pages.unshift({ file: 'index.html', title: 'Home', purpose: `The home page of ${plan.name}.`, role: 'home', auto: true, forms: [], products: [] });
    seen.add('index.html');
  }
  // The home page always comes first.
  pages.sort((a, b) => (a.role === 'home' ? -1 : 0) - (b.role === 'home' ? -1 : 0));

  const auth = plan.backend.auth === true;
  if (auth) {
    if (!pages.some((p) => p.role === 'login')) {
      const file = seen.has('login.html') ? 'sign-in.html' : 'login.html';
      pages.push({ file, title: 'Log in', purpose: 'Visitors with an account sign in here.', role: 'login', auto: true, forms: [], products: [] });
      seen.add(file);
    }
    if (!pages.some((p) => p.role === 'signup')) {
      const file = seen.has('signup.html') ? 'register.html' : 'signup.html';
      pages.push({ file, title: 'Sign up', purpose: 'New visitors create an account here.', role: 'signup', auto: true, forms: [], products: [] });
      seen.add(file);
    }
  }
  if (pages.length > MAX_BUILD_PAGES) {
    open.push(`The plan lists ${pages.length} pages; ${MAX_BUILD_PAGES} were built. Add the rest in the tweaks step.`);
    // Never cut the home page or the account pages the backend depends on.
    const keep = pages.filter((p) => p.role !== 'page');
    const rest = pages.filter((p) => p.role === 'page').slice(0, Math.max(0, MAX_BUILD_PAGES - keep.length));
    const kept = new Set([...keep, ...rest].map((p) => p.file));
    pages.splice(0, pages.length, ...pages.filter((p) => kept.has(p.file)));
  }

  const content = pages.filter((p) => p.role === 'home' || p.role === 'page');
  const home = pages.find((p) => p.role === 'home') ?? content[0];

  // Forms and data stores. `backend.forms` need a visitor-facing form; `backend.collections` are stores (often fed by a form too).
  const formIds: string[] = [];
  const forms: string[] = [];
  for (const raw of plan.backend.forms) {
    const id = collectionId(raw);
    if (id && !forms.includes(id)) {
      forms.push(id);
      formIds.push(id);
    }
  }
  for (const raw of plan.backend.collections) {
    const id = collectionId(raw);
    if (id && !forms.includes(id)) forms.push(id);
  }
  const host = (id: string): BuildPage | undefined => {
    const byName = bestPage(content, id, () => undefined);
    if (byName) return byName;
    const synonymPage = (re: RegExp) => content.find((p) => re.test(pageText(p).split(' ')[0]!)) ?? content.find((p) => re.test(pageText(p)));
    if (WAITLIST_LIKE.test(id)) return home;
    if (CONTACT_LIKE.test(id)) return synonymPage(CONTACT_PAGE) ?? content[content.length - 1] ?? home;
    return home;
  };
  for (const id of forms) host(id)?.forms.push(id);

  const products = productsOf(plan, open);
  const shopFallback = (): BuildPage | undefined => content.find((p) => SHOP_PAGE.test(pageText(p).split(' ')[0]!)) ?? content.find((p) => SHOP_PAGE.test(pageText(p))) ?? home;
  // A product sits on the page whose file or title names it (candles.html); otherwise on the shop — a mention in some page's purpose line
  // ("Introduce the candles") does not make the home page the place to buy them.
  for (const prod of products) bestPage(content, prod.name, shopFallback, 2)?.products.push(prod.id);

  // After signing in: an app's own page if there is one, else the home page.
  const afterLogin = pages.find((p) => p.role === 'page' && /^(dashboard|app|account|home|my)/.test(p.file))?.file ?? home?.file ?? 'index.html';

  // Things the owner chose that the build cannot honour are said out loud, never dropped quietly.
  if (plan.pricing.model === 'donation') open.push('Donations are taken with a pay-what-you-want button (any amount from $0.50).');
  return { pages, forms, formIds, products, auth, afterLogin, open_items: open };
}

/** What a page may link to: every page of the build, by file and title. */
export function siteMap(spec: BuildSpec): { file: string; title: string }[] {
  return spec.pages.map((p) => ({ file: p.file, title: p.title }));
}

/** Pages that appear in the main menu: everything except the account pages (those get Log in / Sign up chrome of their own). */
export function navPages(spec: BuildSpec): BuildPage[] {
  return spec.pages.filter((p) => p.role === 'home' || p.role === 'page');
}
