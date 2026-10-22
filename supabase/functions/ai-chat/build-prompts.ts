// FULL BUILD prompts: one cached system block shared by every page (and every repair) of a build, and a small per-call suffix that
// says which page this call writes. Pure functions (no I/O), unit-tested in supabase/tests/build_prompts.test.ts.
//
// Prompt-cache layout: the system block depends only on (plan, locked style, the example page, the project's image files), so the first
// page of a build writes it to the cache and every other page — and every repair — reads it at a tenth of the price. Anything that
// differs per call (the page, its forms and products, the problems to fix) goes in the suffix.
import type { Plan, StyleSpec } from '../_shared/artifacts.ts';
import { BROKEN_PAGE_RULES, FRONTEND_CRAFT, REAL_CONTENT_RULES, SHARED_FILE_RULES } from './craft.ts';
import type { BuildPage, BuildSpec } from './build-plan.ts';
import { canonicalJson, COMMON } from './stages.ts';
import type { Problem } from './verifier.ts';

/** Output budget of one page. A page that needs more than this is too long: the verifier reports it cut off and the repair asks for a shorter one. */
export const BUILD_PAGE_MAX_TOKENS = 20_000;
/** What the studio sends when the owner presses Build without a note; not shown to the model as an instruction. */
export const BUILD_DEFAULT_MESSAGE = 'Build my site';

const MAX_EXAMPLE_CHARS = 60_000;
const MAX_CSS_CHARS = 60_000;
const MAX_REPAIR_CHARS = 120_000;
const MAX_NOTE_CHARS = 1_500;

export const BUILD_BRIEF = `STAGE: FULL BUILD. The owner approved the plan and locked the style; now the real site is built. Several writers build it at the same time and each writes ONE page, seeing only the material below — so everything the pages share is fixed in advance and written by the platform:
- styles.css — the locked style (shown below). Never write it and never redefine its tokens.
- site.js — the menu, brand and footer, built from the SITE MAP. Never write it, and never write nav or footer markup: the two placeholders are all a page has.
- manifest.json and the backend rules — read from your page afterwards. The forms and buy buttons you write ARE the backend: a form's named inputs become the fields of what visitors send, a buy button becomes a product checkout.
Rules 1–7 of SHARED-FILE RULES describe how the finished site hangs together; ignore their instructions to write styles.css, site.js or manifest.json yourself, and every instruction about memory files (_longterm, _shortterm, _pages, _backend).

THE PAGE YOU WRITE
- One complete HTML document, <!DOCTYPE html> to </html>, for the page named under PAGE TO BUILD, with: <html lang="…"> in the owner's language, charset, viewport, a <title> ("Page title — Brand"), a meta description of one honest sentence, <link rel="stylesheet" href="styles.css"/>, <header data-vx-nav></header>, a <main> with the content, <footer data-vx-footer></footer> and <script src="site.js"></script> last. Exactly one <h1>.
- Look: the page must read as part of the same site as the APPROVED EXAMPLE PAGE — the same hero treatment, section rhythm, buttons, cards and spacing — and uses the classes already in styles.css. What only this page needs goes in its own <style> (rule 6), using only var(--tokens), with class names that start with a short prefix for this page (.pricing-grid, .about-story) so pages never collide. Do not repeat rules styles.css already has.
- Copy: real and specific, in the owner's language and in the voice of the style spec, built only from the plan and what the owner said. The page's purpose line says what it must achieve. A page may be short when the plan gives little to say, but it is finished, useful, and ends with a clear next step.
- Links: only to pages of the SITE MAP, by file name; to an id on the same page (#id); or to the home page's own ids (index.html#id, only ones that exist in the example page). Every link and button goes somewhere real. The main call to action points at the page where the visitor acts (shop, contact, sign up).
- Prices: the only prices you may write are the ones in the plan's pricing items. One-time items listed under PRODUCTS get a buy button. Any other price (a monthly plan, a quote) is shown as information and its call to action leads to the contact or sign-up page; there is no online checkout for it. With no prices in the plan, write none.
- Visuals: CSS only, or the project's own image files by name; never an outside image address. Every <img> has alt text.
- Finish it: every section has real content, every tag and bracket is closed, and any script you add is short and complete. A page that is cut off breaks the whole site.`;

const BUILD_PROTOCOL = `SAVING YOUR WORK
Write the page as <file name="PAGE.html"> … </file> (PAGE.html is the file named under PAGE TO BUILD), using exactly these XML delimiters and never a code fence. Write nothing else: no other file, no patch, no markers, and no chat before or after the file — nothing outside the file block is shown to anyone. If some section would need facts only the owner has, leave it out; the platform lists what the owner still has to supply.`;

export const WORKING_PARTS = `WORKING PARTS — the SDK is already loaded on every page, so never write helper code for any of these:
- A form whose answers reach the owner (contact, waitlist, booking, quote…): <form data-vx-form="NAME" data-vx-success="what the visitor reads once it is sent"> with labelled inputs that each have a name (letters, digits, - _), type="email" for emails, required where it must be given, maxlength on short fields; ONE <button type="submit">; and ONE <p data-vx-message></p> inside the form, where "sent" or the error appears. Take only what the owner needs to answer (at most 8 fields). The backend learns its fields FROM the form, so every field must be a named input. Never use action=…; never an unnamed form.
- Log in and sign up (only when the SITE MAP has those pages): <form data-vx-auth="login" data-vx-redirect="PAGE.html"> or data-vx-auth="signup": inputs named email and password (type="password"), a submit button, <p data-vx-message></p>. Log out: <button data-vx-logout data-vx-redirect="index.html">.
- Signed-in only: <html data-vx-require-auth="login.html"> sends signed-out visitors to the log-in page. On the log-in and sign-up pages: <html data-vx-skip-if-auth="PAGE.html"> sends signed-in visitors on. data-vx-show="in" or "out" on any element shows it only to signed-in or signed-out visitors; <span data-vx-user="email"> prints the visitor's email.
- Buy: <button data-vx-buy="PRODUCT-ID">Buy — $24</button>, for the products listed under PRODUCTS only. The price comes from the platform; write the same price in the text. Next to it: <div data-vx-paid hidden>Payment received — thank you!</div> so a buyer sees the confirmation. For a donation: <button data-vx-buy-amount="500" data-vx-name="Donation"> (amount in cents).
- Data an app keeps for each signed-in visitor, when the plan lists a store no form fills: vx.data.submit('store', {…}), vx.data.list('store') → { success, rows: [ { id, created_at, data } ] }, vx.data.update('store', id, {…}), vx.data.remove('store', id). Each call resolves to { success: true, … } or { error }; none throws. Use the store names from the plan, call them from one short script at the bottom of the page, and show the visitor a message when a call fails.`;

export interface BuildContext {
  plan: Plan;
  style: StyleSpec;
  spec: BuildSpec;
  versions: { plan: number; style_spec: number };
  /** The finished styles.css (the style written in, the form kit appended). */
  stylesCss: string;
  /** The landing page the owner approved in the EXAMPLE stage, if the project still has it. */
  example: string | null;
  /** Names of the project's own image files. */
  images: string[];
}

const ROLE_WORDS: Record<BuildPage['role'], string> = { home: ' (home page)', page: '', login: ' (log in)', signup: ' (sign up)' };

function clipped(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (cut here: ${s.length - max} more characters)` : s;
}

export function buildSystem(c: BuildContext): string {
  const map = c.spec.pages.map((p) => `- ${p.file} — ${p.title}${ROLE_WORDS[p.role]}: ${p.purpose || 'no purpose given'}`).join('\n');
  const account = c.spec.auth
    ? `This site has ACCOUNTS: visitors sign up and log in; signing in sends them to ${c.spec.afterLogin}.`
    : 'This site has no accounts: no log-in, sign-up or sign-in-only content anywhere.';
  const images = c.images.length ? `PROJECT IMAGE FILES (real, usable by file name): ${c.images.join(', ')}` : 'PROJECT IMAGE FILES: none — build every visual with CSS.';
  const project = [
    `THE PROJECT (settled by earlier stages — treat as fixed):`,
    `### plan (version ${c.versions.plan})\n${canonicalJson(c.plan)}`,
    `### style_spec (version ${c.versions.style_spec}, locked)\n${canonicalJson(c.style)}`,
    `SITE MAP — every page of the site, and the only pages you may link to:\n${map}\n${account}\n${images}`,
    `STYLES.CSS — the locked stylesheet every page uses. The platform writes it; read it to reuse its classes and tokens:\n=== styles.css ===\n${clipped(c.stylesCss, MAX_CSS_CHARS)}\n=== end of styles.css ===`,
    c.example
      ? `THE APPROVED EXAMPLE PAGE — the owner saw this landing page and chose this look. Every page of the site must feel like its sibling (it is the home page's starting point):\n=== index.html (example) ===\n${clipped(c.example, MAX_EXAMPLE_CHARS)}\n=== end of the example ===`
      : 'There is no example page to match: let styles.css set the look.',
  ].join('\n\n');
  return [COMMON, BUILD_BRIEF, BUILD_PROTOCOL, WORKING_PARTS, SHARED_FILE_RULES, REAL_CONTENT_RULES, BROKEN_PAGE_RULES, FRONTEND_CRAFT, project].join('\n\n');
}

const money = (cents: number): string => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

function roleBrief(c: Pick<BuildContext, 'spec' | 'plan'>, page: BuildPage): string {
  const { spec } = c;
  const loginPage = spec.pages.find((p) => p.role === 'login')?.file ?? 'login.html';
  const signupPage = spec.pages.find((p) => p.role === 'signup')?.file;
  switch (page.role) {
    case 'home':
      return `This is the home page, the first page every visitor sees. Start from the APPROVED EXAMPLE PAGE: keep its look, layout and the copy that holds up; replace its in-page-only links with links to the real pages now that they exist; add what this brief needs. It should lead with what the site offers and send visitors to the page where they act.`;
    case 'login':
      return `This is the log-in page: a short welcome, then <form data-vx-auth="login" data-vx-redirect="${spec.afterLogin}"> (email, password, a submit button, <p data-vx-message></p>)${signupPage ? ` and a link to ${signupPage} for people with no account yet` : ''}. Put data-vx-skip-if-auth="${spec.afterLogin}" on <html>. Keep it small and calm; no marketing sections.`;
    case 'signup':
      return `This is the sign-up page: a short welcome saying what an account gives the visitor (from the plan only), then <form data-vx-auth="signup" data-vx-redirect="${spec.afterLogin}"> (email, password, a submit button, <p data-vx-message></p>) and a link to ${loginPage} for people who already have an account. Put data-vx-skip-if-auth="${spec.afterLogin}" on <html>. Keep it small; no marketing sections.`;
    default: {
      const gated = spec.auth
        ? c.plan.kind === 'app'
          ? ` This site is an app: every page except the home, log-in and sign-up pages is for signed-in visitors, so put data-vx-require-auth="${loginPage}" on <html>.`
          : ` Put data-vx-require-auth="${loginPage}" on <html> only if this page shows a visitor's own information (their account, orders, dashboard).`
        : '';
      return `This is a content page.${gated}`;
    }
  }
}

function hostedBrief(c: Pick<BuildContext, 'spec' | 'plan'>, page: BuildPage): string {
  const { spec } = c;
  const lines: string[] = [];
  for (const id of page.forms) {
    lines.push(
      spec.formIds.includes(id)
        ? `FORM "${id}" lives on this page, and only here: <form data-vx-form="${id}">. Decide its fields from what the owner needs to act on it (see the plan), and write a data-vx-success line in the owner's voice.`
        : `The plan keeps a data store called "${id}". If this page lets visitors save or see that data, use it through vx.data with exactly that name; otherwise leave it alone.`,
    );
  }
  const mine = spec.products.filter((p) => page.products.includes(p.id));
  if (mine.length) {
    lines.push(
      'PRODUCTS sold on this page, each with its own buy button — nothing else here has one:\n' +
        mine
          .map((p) => {
            if (p.sellable && p.price_cents !== null) return `- id "${p.id}": ${p.name} — ${money(p.price_cents)}, one time → <button data-vx-buy="${p.id}">`;
            const why = p.price_cents === null ? 'no price has been set' : p.interval ? 'it is a recurring price, which has no online checkout yet' : 'its price is not a payable one-time amount';
            return `- "${p.name}": show it without a buy button (${why})${p.price_cents && p.price_cents > 0 ? `, price ${money(p.price_cents)}${p.interval ? `/${p.interval}` : ''}` : ''}; the call to action leads to the contact or sign-up page.`;
          })
          .join('\n'),
    );
  }
  if (!lines.length) lines.push('This page hosts no form and sells nothing: do not add a form, a sign-up box or a buy button.');
  return lines.join('\n');
}

/** What differs per call: which page, what it hosts, and the owner's note. */
export function pagePrompt(c: Pick<BuildContext, 'spec' | 'plan'>, page: BuildPage, opts: { note?: string } = {}): string {
  const note = (opts.note ?? '').trim();
  const parts = [
    `PAGE TO BUILD: ${page.file}\nTitle: ${page.title}\nPurpose: ${page.purpose || 'the plan gives no more detail than the title'}`,
    roleBrief(c, page),
    hostedBrief(c, page),
  ];
  if (note && note !== BUILD_DEFAULT_MESSAGE) parts.push(`THE OWNER'S NOTE FOR THIS BUILD (follow it when it is about this page; ignore the rest):\n${note.slice(0, MAX_NOTE_CHARS)}`);
  parts.push(`Write ${page.file} now, in the format under SAVING YOUR WORK.`);
  return `\n\n${parts.join('\n\n')}`;
}

/** A repair call: the page's usual assignment, the page as it is, and the problems found in it. `html` is null when the page was never built. */
export function fixPrompt(c: Pick<BuildContext, 'spec' | 'plan'>, page: BuildPage, html: string | null, problems: Pick<Problem, 'check' | 'message'>[], opts: { note?: string } = {}): string {
  const cutOff = html !== null && !/<\/html>\s*$/i.test(html.trimEnd());
  const list = problems.slice(0, 20).map((p, n) => `${n + 1}. ${p.message}`).join('\n');
  const body =
    html === null || html.trim() === ''
      ? `The earlier attempt at this page failed, so there is nothing to repair: write the whole page afresh.\nWhat went wrong:\n${list}`
      : `The page below was checked the way a visitor meets it, and these problems were found. Fix every one of them, change nothing else, and write the COMPLETE page again.\nPROBLEMS:\n${list}\n${
          cutOff ? '\nThe page was cut off because it was too long to finish: write a SHORTER page — at most five sections, tight copy, no long script — and make sure it ends with </html>.\n' : ''
        }\nTHE PAGE AS IT IS NOW:\n=== ${page.file} ===\n${clipped(html, MAX_REPAIR_CHARS)}\n=== end of ${page.file} ===`;
  return `${pagePrompt(c, page, opts)}\n\nREPAIR\n${body}`;
}

const MAX_PAGE_CHARS = 300_000;

/** The page a reply wrote: the file named `file`, or a reason it cannot be used. Other files in the reply are ignored (the platform owns them). */
export function pageFromReply(file: string, files: Record<string, string>): { html: string } | { error: string } {
  const want = file.toLowerCase();
  const key = Object.keys(files).find((k) => k.replace(/^\.?\//, '').toLowerCase() === want);
  if (!key) return { error: `The AI did not write ${file}.` };
  const html = files[key]!;
  if (html.trim().length < 200) return { error: `The AI wrote an empty ${file}.` };
  if (html.length > MAX_PAGE_CHARS) return { error: `${file} came out too long to use.` };
  return { html };
}
