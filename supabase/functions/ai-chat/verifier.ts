// FULL BUILD, the launch verifier: reads the finished site the way a visitor would meet it and reports what is broken, fake or missing
// — as a LaunchChecks report (the `launch_checks` artifact the LAUNCH stage gates on) and as a per-page list of problems the build
// hands back to the AI to repair. Pure functions (no I/O), unit-tested in supabase/tests/verifier.test.ts.
//
// What this is NOT: it does not run a browser. It parses every page (html-lite.ts), follows every link and form against the site's
// own files and rules, checks every script closes its brackets, and scans for placeholder text, invented proof and invented prices.
// A real headless load is a separate, later hardening (docs/STAGES.md "Launch verifier").
import type { CheckStatus, LaunchCheck, Plan, StyleSpec } from '../_shared/artifacts.ts';
import { parseTokens } from '../_shared/style.ts';
import type { BuildSpec } from './build-plan.ts';
import { allEls, hasAncestor, jsBalanceProblem, parseHtml, visibleText, type El } from './html-lite.ts';
import { scanPage, validCollectionId, type PageScan } from './site-derive.ts';

export interface Problem {
  file: string;
  check: string;
  severity: 'fail' | 'warn';
  /** Plain English, specific enough for the AI to act on it. */
  message: string;
}

export interface VerifyInput {
  plan: Plan;
  spec: BuildSpec;
  style: StyleSpec;
  /** What would be published: the pages, styles.css, site.js, manifest.json and `_backend`. */
  files: Record<string, string>;
  /** Names of every other file in the project (uploaded images…), for link and image checks. */
  otherFiles?: string[];
  /** Pages that could not be built at all (file → why). */
  pageErrors?: Record<string, string>;
}

export interface VerifyResult {
  ok: boolean;
  checks: LaunchCheck[];
  problems: Problem[];
  open_items: string[];
}

const LABELS: Record<string, string> = {
  pages: 'Every page in the plan was built',
  structure: 'Pages are complete and use the shared style',
  scripts: 'Scripts are complete',
  links: 'Every link goes to a real place',
  images: 'Images are real files',
  forms: 'Forms are connected to the backend',
  checkout: 'Buying works',
  accounts: 'Sign-in and sign-up work',
  content: 'No placeholder text',
  proof: 'No invented facts',
  prices: 'Only the prices you set',
  empty: 'No empty sections',
  style: 'Colours and fonts come from your style',
  visibility: 'Nothing is hidden by default',
  basics: 'Titles, headings and descriptions',
  backend: 'Backend rules match the pages',
  owner: 'Things only you can supply',
};
const ORDER = Object.keys(LABELS);

// ── text patterns ───────────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER: [RegExp, string][] = [
  [/lorem ipsum|dolor sit amet|consectetur adipiscing/i, 'lorem ipsum filler text'],
  [/\bcoming soon\b/i, '"coming soon"'],
  [/\b(?:todo|tbd|fixme)\b/i, 'a TODO/TBD marker'],
  [/\b(?:your|insert|add) (?:text|name|company|business|title|content|description|email|tagline|headline|logo|image|photo) here\b/i, 'a "your … here" placeholder'],
  [/\[(?:your|company|brand|business|insert|name|add)[^\]]{0,40}\]/i, 'a [bracketed] placeholder'],
  [/\{\{[^}]{0,60}\}\}/, 'an unfilled {{template}} tag'],
  [/\b(?:placeholder|sample|dummy) (?:text|image|content|copy)\b/i, 'placeholder text'],
  [/\b(?:company|business|brand|product) name (?:here|goes here)\b/i, 'a "name here" placeholder'],
  [/\b(?:john|jane) (?:doe|smith)\b/i, 'a made-up person (John/Jane Doe)'],
  [/\bacme (?:inc|corp|co|ltd)\b|\bfakeco\b|\bfoo ?bar\b/i, 'a made-up company name'],
  [/\(555\)|\b555[-. ]\d{4}\b/, 'a fake 555 phone number'],
  [/\b123 (?:main|fake|example|sample)\b/i, 'a fake street address'],
  [/@example\.(?:com|org|net)\b/i, 'an @example.com address'],
];
const COMMENT_PLACEHOLDER = /\b(?:todo|fixme|placeholder|replace (?:this|me)|add (?:your|real|more|testimonials?|content|text|images?)|insert|your [a-z ]{1,24} here)\b/i;

/** Claims that read as proof or policy the owner never gave. A match is ignored when the plan itself says it. */
const PROOF_FAIL: [RegExp, string][] = [
  [/\btrusted by\b/i, '"trusted by …"'],
  [/\bas seen (?:in|on)\b/i, '"as seen in …"'],
  [/★{3,}|⭐{2,}/, 'star ratings'],
  [/\b\d(?:\.\d)? ?(?:\/|out of) ?5\b/i, 'a rating out of 5'],
  [/\baward[- ]winning\b/i, '"award-winning"'],
  [/(?:\b\d{1,3}(?:,\d{3})+|\b\d{3,}|\b\d+\+)\s+(?:happy |satisfied |active |loyal )?(?:customers|clients|users|members|subscribers|brands|companies|businesses|reviews|downloads)\b/i, 'a customer/user count'],
];
const PROOF_WARN: [RegExp, string][] = [
  [/\b\d{1,3} ?% (?:of|more|faster|increase|growth|off|savings|satisfaction|satisfied)\b/i, 'a percentage claim'],
  [/\bmoney[- ]back guarantee\b|\bfree (?:shipping|returns|delivery)\b|\b\d+[- ]day (?:return|trial|guarantee|refund)/i, 'a shipping/returns/guarantee term'],
  [/\bships (?:in|within)\b|\bdelivered (?:in|within)\b|\bready in \d/i, 'a shipping or turnaround time'],
  [/\bsince (?:19|20)\d\d\b|\best\.? ?(?:19|20)\d\d\b|\b\d+ years (?:of experience|in business)\b/i, 'a years-in-business claim'],
  [/\b(?:handmade|made|crafted|hand-poured) in [A-Z][a-z]+/, 'a "made in …" claim'],
];
const PROOF_CLASS = /testimonial|logo-cloud|logos-strip|trusted-by|press-logos|as-seen|star-rating|rating-stars/i;

const PLACEHOLDER_IMAGE_HOST = /unsplash|placeholder|placehold|picsum|lorempixel|loremflickr|dummyimage|fakeimg|pexels|pixabay|imgur|via\.placeholder/i;
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const MEDIA = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'picture', 'form', 'button', 'input', 'textarea', 'select', 'a', 'audio', 'object']);

const clip = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function verifySite(i: VerifyInput): VerifyResult {
  const problems: Problem[] = [];
  const add = (check: string, file: string, message: string, severity: 'fail' | 'warn' = 'fail') => problems.push({ file, check, severity, message });

  const pageFiles = i.spec.pages.map((p) => p.file);
  const pageSet = new Set(pageFiles);
  const known = new Set([...Object.keys(i.files), ...(i.otherFiles ?? [])]);
  const planText = JSON.stringify(i.plan).toLowerCase();
  const stated = (m: string): boolean => planText.includes(m.toLowerCase());

  // pages
  const parsed = new Map<string, ReturnType<typeof parseHtml>>();
  const scans = new Map<string, PageScan>();
  for (const f of pageFiles) {
    const html = i.files[f];
    if (!html || html.trim().length < 80) {
      add('pages', f, i.pageErrors?.[f] ? `This page could not be built: ${i.pageErrors[f]}` : 'This page is missing or empty.');
      continue;
    }
    parsed.set(f, parseHtml(html));
    scans.set(f, scanPage(f, html));
  }
  const idsOf = (f: string): string[] => scans.get(f)?.ids ?? [];

  for (const [file, page] of parsed) {
    const els = allEls(page.root);
    const body = els.find((e) => e.tag === 'body') ?? page.root;
    const scan = scans.get(file)!;

    // structure
    if (!page.seen.doctype) add('structure', file, 'The page has no <!DOCTYPE html>.', 'warn');
    if (!page.seen.htmlEnd || !page.seen.bodyEnd) add('structure', file, 'The page ends before </body></html> — it was cut off. Write the complete page, every tag closed.');
    if (!els.some((e) => e.tag === 'link' && /stylesheet/i.test(e.attrs.rel ?? '') && /^(\.\/)?styles\.css(\?.*)?$/.test(e.attrs.href ?? ''))) add('structure', file, 'The page does not link styles.css: add <link rel="stylesheet" href="styles.css"/> in the head.');
    if (!page.scripts.some((s) => s.src && /^(\.\/)?site\.js(\?.*)?$/.test(s.src))) add('structure', file, 'The page does not load site.js, so the menu and footer will not appear: add <script src="site.js"></script> before </body>.');
    if (!els.some((e) => 'data-vx-nav' in e.attrs)) add('structure', file, 'The page has no <header data-vx-nav></header>, so it has no menu.');
    if (!els.some((e) => 'data-vx-footer' in e.attrs)) add('structure', file, 'The page has no <footer data-vx-footer></footer>, so it has no footer.');
    if (els.some((e) => e.tag === 'link' && /fonts\.googleapis|fonts\.gstatic/.test(e.attrs.href ?? ''))) add('style', file, 'The page loads fonts with its own <link>; fonts load once, from styles.css.', 'warn');

    // scripts
    page.scripts.filter((s) => !s.src).forEach((s, n) => {
      const p = jsBalanceProblem(s.code);
      if (p) add('scripts', file, `Inline script ${n + 1} is broken: ${p}. A broken script stops all JavaScript on the page; finish or shorten it.`);
      if (/\b(?:TODO|FIXME)\b/.test(s.code)) add('content', file, 'A script contains a TODO/FIXME note — finish it or remove it.');
    });

    // links
    const dead = (what: string) => add('links', file, what);
    for (const a of els.filter((e) => e.tag === 'a' && 'href' in e.attrs)) {
      const href = (a.attrs.href ?? '').trim();
      const label = clip(visibleText(a) || href, 40);
      if (href === '' || href === '#') dead(`The link "${label}" goes nowhere (href="${href}"). Point it at a real page or a section of this page.`);
      else if (/^(javascript|data|vbscript):/i.test(href)) dead(`The link "${label}" uses a ${href.split(':')[0]}: address, which is not allowed.`);
      else if (/^(mailto:|tel:)\s*$/i.test(href)) dead(`The link "${label}" has an empty ${href}`);
      else if (/^(https?:|mailto:|tel:|\/\/)/i.test(href)) continue;
      else if (href.startsWith('/')) dead(`The link "${label}" uses the absolute path "${href}". Link pages by file name, like pricing.html.`);
      else if (href.startsWith('#')) {
        if (!idsOf(file).includes(href.slice(1))) dead(`The link "${label}" points at #${href.slice(1)}, but nothing on this page has id="${href.slice(1)}".`);
      } else {
        const [path0, anchor] = href.split('#') as [string, string | undefined];
        const path = path0!.split('?')[0]!.replace(/^\.\//, '');
        if (/\.html$/i.test(path)) {
          if (!pageSet.has(path)) dead(`The link "${label}" goes to ${path}, which is not a page of this site. Pages that exist: ${pageFiles.join(', ')}.`);
          else if (anchor && !idsOf(path).includes(anchor)) dead(`The link "${label}" goes to ${path}#${anchor}, but ${path} has no element with id="${anchor}".`);
        } else if (!known.has(path)) add('links', file, `The link "${label}" goes to "${path}", which is not a file of this site.`, 'warn');
      }
    }
    // A button that is not part of a form and has nothing to run does nothing.
    if (page.scripts.every((s) => s.src)) {
      for (const b of els.filter((e) => e.tag === 'button')) {
        const wired = Object.keys(b.attrs).some((k) => k.startsWith('data-vx-') || k.startsWith('on') || k === 'formaction');
        if (!wired && !hasAncestor(b, (e) => e.tag === 'form' || e.tag === 'a')) dead(`The button "${clip(visibleText(b) || 'button', 30)}" does nothing: it is not in a form, not wired to anything, and the page has no script. Make it a link or wire it up.`);
      }
    }

    // images
    for (const img of els.filter((e) => e.tag === 'img')) {
      const src = (img.attrs.src ?? '').trim();
      if (!src) add('images', file, 'An image has no src.');
      else if (/^data:/i.test(src)) continue;
      else if (/^(https?:)?\/\//i.test(src)) add('images', file, `The image ${clip(src, 70)} points at an outside web address; it may break or be somebody else's. Use a CSS-drawn visual or one of the project's own image files.`, PLACEHOLDER_IMAGE_HOST.test(src) ? 'fail' : 'warn');
      else if (!known.has(src.replace(/^\.\//, '').split(/[?#]/)[0]!)) add('images', file, `The image "${src}" is not a file of this site. Only use images the project actually has.`);
      if (!('alt' in img.attrs)) add('basics', file, `An image (${clip(src || 'no src', 40)}) has no alt text.`, 'warn');
    }
    const css = [...page.styles, ...els.map((e) => e.attrs.style).filter((s): s is string => !!s)].join('\n');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const u = m[1]!.trim();
      if (/^(data:|#)/i.test(u)) continue;
      if (/^(https?:)?\/\//i.test(u)) {
        if (!/fonts\.(googleapis|gstatic)\.com/.test(u)) add('images', file, `A style loads ${clip(u, 70)} from an outside web address.`, PLACEHOLDER_IMAGE_HOST.test(u) ? 'fail' : 'warn');
      } else if (!known.has(u.replace(/^\.\//, '').split(/[?#]/)[0]!)) add('images', file, `A style uses "${u}", which is not a file of this site.`);
    }

    // forms
    if (scan.strayForms > 0) add('forms', file, `${scan.strayForms === 1 ? 'A <form>' : `${scan.strayForms} <form>s`} would go nowhere. Give each contact/sign-up form data-vx-form="<name>" and each account form data-vx-auth="login|signup".`);
    for (const w of scan.hookOnWrongTag) add('forms', file, `${w}: the hook belongs on a <form>.`);
    for (const f of scan.forms) {
      if (!validCollectionId(f.id)) add('forms', file, `The form id "${clip(f.id, 30)}" is not allowed: use lowercase letters, digits, - or _ (up to 40).`);
      if (f.fields.length === 0) add('forms', file, `The "${f.id}" form has no named inputs (every input needs a name="…").`);
      for (const b of f.badNames) add('forms', file, `The input name "${b}" in the "${f.id}" form is not allowed: use letters, digits, - _ . only.`);
      if (!f.hasMessage) add('forms', file, `The "${f.id}" form has no <p data-vx-message></p> line, so visitors never see "sent" or an error.`);
      if (!f.hasSubmit) add('forms', file, `The "${f.id}" form has no submit button.`);
    }

    // basics
    const title = els.find((e) => e.tag === 'title');
    if (!title || !visibleText(title)) add('basics', file, 'The page has no <title>.', 'warn');
    if (!els.some((e) => e.tag === 'meta' && e.attrs.name === 'description' && (e.attrs.content ?? '').trim())) add('basics', file, 'The page has no meta description.', 'warn');
    if (!els.some((e) => e.tag === 'meta' && e.attrs.name === 'viewport')) add('basics', file, 'The page has no viewport meta tag, so it will not fit phones.', 'warn');
    const html = els.find((e) => e.tag === 'html');
    if (html && !html.attrs.lang) add('basics', file, 'The <html> tag has no lang attribute.', 'warn');
    const h1 = els.filter((e) => e.tag === 'h1').length;
    if (h1 !== 1) add('basics', file, h1 === 0 ? 'The page has no <h1> heading.' : `The page has ${h1} <h1> headings; it should have one.`, 'warn');

    // content: placeholder text, invented proof, invented prices
    const bodyText = visibleText(body);
    const attrText = els.flatMap((e) => [e.attrs.alt, e.attrs.title, e.attrs['aria-label']]).filter(Boolean).join(' ');
    const titleText = title ? visibleText(title) : '';
    const metaText = els.filter((e) => e.tag === 'meta' && e.attrs.name === 'description').map((e) => e.attrs.content ?? '').join(' ');
    const text = `${titleText} ${metaText} ${attrText} ${bodyText}`;
    const seen = new Set<string>();
    for (const [re, what] of PLACEHOLDER) {
      const m = re.exec(text);
      if (m && !seen.has(what) && !stated(m[0])) {
        seen.add(what);
        add('content', file, `The page contains ${what} ("${clip(m[0], 40)}"). Write real copy from the plan or leave that part out.`);
      }
    }
    for (const c of page.comments) {
      if (COMMENT_PLACEHOLDER.test(c)) {
        add('content', file, `An HTML comment reads like a placeholder note ("${clip(c.trim(), 50)}"). Remove it or build what it says.`);
        break;
      }
    }
    for (const [re, what] of PROOF_FAIL) {
      const m = re.exec(text);
      if (m && !stated(m[0])) add('proof', file, `The page claims ${what} ("${clip(m[0], 50)}") that the owner never gave. Remove it — a shorter honest page is better.`);
    }
    for (const [re, what] of PROOF_WARN) {
      const m = re.exec(text);
      if (m && !stated(m[0])) add('proof', file, `The page states ${what} ("${clip(m[0], 50)}") that is not in the plan. Check it is true.`, 'warn');
    }
    for (const e of els) {
      const cls = `${e.attrs.class ?? ''} ${e.attrs.id ?? ''}`;
      if (PROOF_CLASS.test(cls)) {
        add('proof', file, `The page has a "${clip(cls.trim(), 40)}" section. The plan has no real testimonials, ratings or press logos, so this section would be invented. Remove it.`);
        break;
      }
    }
    if (els.some((e) => e.tag === 'blockquote')) add('proof', file, 'The page has a quotation (<blockquote>). Make sure it is a real quote the owner gave you.', 'warn');

    if (i.plan.pricing.model !== 'donation') {
      const allowed = allowedAmounts(i.plan, i.spec);
      for (const m of text.matchAll(/(?:\$|US\$)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
        const dollars = Number(m[1]!.replace(/,/g, '')) + (m[2] ? Number(`0.${m[2]}`) : 0);
        if (dollars > 0 && !allowed.has(Math.round(dollars * 100))) {
          add('prices', file, `The page shows ${m[0]}, which is not a price in the plan. Only use prices the owner set.`);
          break;
        }
      }
    }

    // empty
    if (bodyText.length < 60) add('empty', file, `The page has almost no content (${bodyText.length} characters of text). Build it fully.`);
    for (const s of els.filter((e) => e.tag === 'section' || e.tag === 'article')) {
      const t = visibleText(s);
      const hasMedia = allEls(s).some((c) => MEDIA.has(c.tag) || 'data-vx-form' in c.attrs);
      const headingText = allEls(s).filter((c) => HEADINGS.has(c.tag)).map((c) => visibleText(c)).join(' ').replace(/\s+/g, ' ').trim();
      if (!hasMedia && (t === '' || (headingText !== '' && t === headingText))) {
        add('empty', file, `A section${s.attrs.id ? ` (#${s.attrs.id})` : ''}${headingText ? ` titled "${clip(headingText, 40)}"` : ''} has no content under it. Fill it with real copy or remove it.`);
      }
    }

    // visibility
    if (/opacity\s*:\s*0(?![.\d%])/i.test([...page.styles, ...els.map((e) => e.attrs.style ?? '')].join('\n'))) {
      add('visibility', file, 'A style sets opacity:0, which leaves content invisible if the script that reveals it never runs. Use transform for animations and keep opacity at 1.', 'warn');
    }

    // style: colours and fonts only through tokens
    const raw = rawColors(page.styles.join('\n'), els);
    if (raw.length) add('style', file, `The page uses fixed colours instead of the style's tokens (${raw.slice(0, 3).join(', ')}). Use var(--accent), var(--text), var(--surface)… or color-mix(); the owner changes the look through those tokens.`, 'warn');
  }

  // site-wide: stylesheet and shared files
  const css = i.files['styles.css'] ?? '';
  const tokens = parseTokens(css);
  const off = Object.entries(i.style.tokens).filter(([k, v]) => tokens[k] !== v);
  if (!css) add('style', 'styles.css', 'styles.css is missing.');
  else if (off.length) add('style', 'styles.css', `styles.css does not match the locked style (${off.slice(0, 3).map(([k]) => k).join(', ')}).`);
  if (css) {
    const rawCss = rawColors(css.replace(/@import[^;]*;/g, ''), []);
    if (rawCss.length) add('style', 'styles.css', `styles.css uses fixed colours outside the tokens (${rawCss.slice(0, 3).join(', ')}).`, 'warn');
    if (/opacity\s*:\s*0(?![.\d%])/i.test(css)) add('visibility', 'styles.css', 'styles.css sets opacity:0 somewhere.', 'warn');
  }
  const siteJs = jsBalanceProblem(i.files['site.js'] ?? '');
  if (siteJs) add('scripts', 'site.js', `site.js is broken: ${siteJs}.`);
  try {
    const m = JSON.parse(i.files['manifest.json'] ?? '');
    if (!m || typeof m.name !== 'string' || !m.name) add('backend', 'manifest.json', 'manifest.json has no name.', 'warn');
  } catch {
    add('backend', 'manifest.json', 'manifest.json is not valid JSON.');
  }

  // forms the plan asked for, and stores nothing fills
  const allForms = [...scans.values()].flatMap((s) => s.forms.map((f) => f.id));
  const dataIds = [...scans.values()].flatMap((s) => s.dataIds);
  for (const id of i.spec.formIds) {
    if (!allForms.includes(id)) {
      const host = i.spec.pages.find((p) => p.forms.includes(id))?.file ?? pageFiles[0] ?? 'index.html';
      add('forms', host, `The plan needs a "${id}" form on this page, but there is no <form data-vx-form="${id}">. Add it with real fields, a submit button and a <p data-vx-message></p> line.`);
    }
  }
  for (const id of i.spec.forms) {
    if (!i.spec.formIds.includes(id) && !allForms.includes(id) && !dataIds.includes(id)) add('forms', 'index.html', `The plan lists a "${id}" store, but no page saves anything to it.`, 'warn');
  }

  // checkout
  const buys = [...scans.values()].flatMap((s) => s.buys.map((id) => ({ id, file: s.file })));
  for (const b of buys) {
    const p = i.spec.products.find((x) => x.id === b.id);
    if (!p) add('checkout', b.file, `A buy button uses the product "${b.id}", which is not in the plan. Products: ${i.spec.products.map((x) => x.id).join(', ') || 'none'}.`);
    else if (!p.sellable) add('checkout', b.file, `A buy button for "${p.name}", but it has no valid one-time price in the plan — remove the button and send visitors to get in touch.`);
  }
  for (const p of i.spec.products.filter((x) => x.sellable)) {
    if (!buys.some((b) => b.id === p.id)) {
      const host = i.spec.pages.find((x) => x.products.includes(p.id))?.file ?? pageFiles[0] ?? 'index.html';
      add('checkout', host, `"${p.name}" is for sale but has no buy button. Add <button data-vx-buy="${p.id}">…</button> where it is offered.`);
    }
  }
  const amountPage = pageFiles.find((f) => (scans.get(f)?.buyAmounts ?? 0) > 0);
  if (amountPage && i.plan.pricing.model !== 'donation') add('checkout', amountPage, 'A pay-what-you-want button is on the page, but the plan has no donations.', 'warn');

  // accounts
  const authForms = [...scans.values()].flatMap((s) => s.authForms.map((a) => ({ ...a, file: s.file })));
  for (const role of ['login', 'signup'] as const) {
    if (!i.spec.auth) break;
    const page = i.spec.pages.find((p) => p.role === role);
    const form = authForms.find((a) => a.kind === role);
    if (!page) continue;
    if (!form) add('accounts', page.file, `This ${role === 'login' ? 'log-in' : 'sign-up'} page has no <form data-vx-auth="${role}">.`);
    else {
      if (!form.hasEmail || !form.hasPassword) add('accounts', form.file, `The ${role} form needs inputs named "email" and "password".`);
      if (!form.hasMessage) add('accounts', form.file, `The ${role} form has no <p data-vx-message></p> line for errors.`);
      if (!form.hasSubmit) add('accounts', form.file, `The ${role} form has no submit button.`);
    }
  }
  if (!i.spec.auth && authForms.length) add('accounts', authForms[0]!.file, 'The page has a sign-in form, but the plan has no accounts.', 'warn');
  for (const s of scans.values()) {
    for (const t of [...s.requireAuth, ...s.skipIfAuth, ...s.redirects]) {
      const target = t.split(/[?#]/)[0]!;
      if (/\.html$/i.test(target) && !pageSet.has(target)) add('accounts', s.file, `A sign-in redirect goes to ${target}, which is not a page of this site.`);
    }
  }

  // backend: the rules and the pages agree
  try {
    const rules = JSON.parse(i.files._backend ?? 'null') as { collections?: { id: string }[]; products?: { id: string }[] } | null;
    const ids = new Set((rules?.collections ?? []).map((c) => c.id));
    const prods = new Set((rules?.products ?? []).map((p) => p.id));
    for (const id of new Set([...allForms, ...dataIds])) if (validCollectionId(id) && !ids.has(id)) add('backend', 'index.html', `Nothing in the backend rules covers "${id}".`);
    for (const b of buys) if (!prods.has(b.id) && i.spec.products.some((p) => p.id === b.id && p.sellable)) add('backend', b.file, `The product "${b.id}" is missing from the backend rules.`);
    if (!rules) add('backend', '_backend', 'The backend rules are missing.');
  } catch {
    add('backend', '_backend', 'The backend rules are not valid JSON.');
  }

  // open items
  const open: string[] = [...i.spec.open_items];
  for (const c of i.plan.launch_checklist) if (!c.done && c.label.trim() && !open.includes(c.label.trim())) open.push(c.label.trim());

  // report
  const checks: LaunchCheck[] = [];
  const touched = new Set(problems.map((p) => p.check));
  for (const id of ORDER) {
    if (id === 'owner') {
      checks.push({ id, label: LABELS[id]!, status: open.length ? 'warn' : 'pass', ...(open.length ? { detail: `${open.length} thing${open.length === 1 ? '' : 's'} only you can supply: ${open.slice(0, 3).map((o) => clip(o, 50)).join('; ')}${open.length > 3 ? '…' : ''}` } : {}) });
      continue;
    }
    const mine = problems.filter((p) => p.check === id);
    if (!touched.has(id)) {
      const skip = (id === 'accounts' && !i.spec.auth && authForms.length === 0) || (id === 'checkout' && i.spec.products.length === 0 && buys.length === 0) || (id === 'prices' && i.plan.pricing.model === 'donation');
      checks.push({ id, label: LABELS[id]!, status: skip ? 'skip' : 'pass' });
      continue;
    }
    const status: CheckStatus = mine.some((p) => p.severity === 'fail') ? 'fail' : 'warn';
    const shown = mine.filter((p) => p.severity === status);
    const files = new Set(mine.map((p) => p.file));
    checks.push({
      id,
      label: LABELS[id]!,
      status,
      detail: `${shown
        .slice(0, 3)
        .map((p) => `${p.file}: ${p.message}`)
        .join(' ')}${shown.length > 3 ? ` (+${shown.length - 3} more)` : ''}`.slice(0, 900),
      ...(files.size === 1 ? { page: [...files][0]! } : {}),
    });
  }
  return { ok: !checks.some((c) => c.status === 'fail'), checks, problems, open_items: open };
}

/** Every price (in cents) the owner has stated: the plan's items, the products, and any $ amount written in the plan's own text. */
function allowedAmounts(plan: Plan, spec: BuildSpec): Set<number> {
  const out = new Set<number>([0]);
  for (const it of plan.pricing.items) out.add(it.price_cents);
  for (const p of spec.products) if (p.price_cents !== null) out.add(p.price_cents);
  const text = JSON.stringify({ ...plan, pricing: undefined, scenario: undefined });
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) out.add(Math.round((Number(m[1]!.replace(/,/g, '')) + (m[2] ? Number(`0.${m[2]}`) : 0)) * 100));
  return out;
}

const COLOR_VALUE = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(/i;
/** Black or white at some opacity: the neutral shadows and scrims every design uses, not a palette choice. */
const NEUTRAL_ALPHA = /\brgba?\(\s*(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)\s*,/gi;
const isRaw = (value: string): boolean => COLOR_VALUE.test(value.replace(/url\([^)]*\)/gi, '').replace(NEUTRAL_ALPHA, ''));

/** Colours written straight into a real property (not a custom property): `color: #fff`, `fill="#000"`, inline `style="background: rgb(…)"`. */
function rawColors(css: string, els: El[]): string[] {
  const out: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
    const prop = m[1]!;
    if (prop.startsWith('--')) continue;
    if (isRaw(m[2]!)) out.push(`${prop}: ${clip(m[2]!.trim(), 24)}`);
  }
  for (const e of els) {
    for (const k of ['fill', 'stroke', 'stop-color', 'flood-color', 'color']) {
      const v = e.attrs[k];
      if (v && isRaw(v)) out.push(`${k}="${clip(v, 16)}"`);
    }
    const style = e.attrs.style;
    if (style) {
      for (const m of style.matchAll(/([a-z-]+)\s*:\s*([^;]+)/gi)) {
        if (!m[1]!.startsWith('--') && isRaw(m[2]!)) out.push(`${m[1]}: ${clip(m[2]!.trim(), 24)}`);
      }
    }
  }
  return [...new Set(out)];
}

/** The problems the AI can repair, grouped by page: failures that sit in one of the build's pages. */
export function repairable(result: VerifyResult, spec: BuildSpec): Map<string, Problem[]> {
  const pages = new Set(spec.pages.map((p) => p.file));
  const out = new Map<string, Problem[]>();
  for (const p of result.problems) {
    if (p.severity !== 'fail' || !pages.has(p.file)) continue;
    // Platform-derived problems never come from the model's page text.
    if (p.check === 'backend') continue;
    out.set(p.file, [...(out.get(p.file) ?? []), p]);
  }
  return out;
}
