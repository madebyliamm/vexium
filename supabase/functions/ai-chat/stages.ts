// Stage endpoints for the guided flow — prompt assembly and output handling, as pure functions (no I/O, no Deno APIs) so they
// are unit-tested under Node (supabase/tests/ai_stages.test.ts). stage-handler.ts does the I/O around them; index.ts wires it in.
//
// STATUS: PLAN (Step 8) and EXAMPLE (Step 9) have their real prompts; the other stages' briefs are still the Step 7 skeleton and
// Steps 10 (FULL BUILD) and 11 (TWEAKS) replace them. The mechanics are real — which artifacts each stage reads, a prompt-cache-stable
// layout, strict parsing and validation of what the model saves. A stage that produces FILES has its own finisher (EXAMPLE:
// finishExample below). See docs/STAGES.md.
//
// Prompt-cache layout (why it looks like this): Anthropic caches a prompt PREFIX, so the system block must be byte-identical
// across every call of a stage session. It therefore holds only things that cannot change while the stage runs — the stage
// instructions and the stage's INPUT artifacts (upstream, frozen, fresh). The artifact the stage is editing changes every turn,
// so it goes in the non-cached suffix, together with the per-call reminder.
import { normalizeArtifact, validateArtifact } from '../_shared/artifacts.ts';
import { applyStyleSpec, deriveStyleSpec, manifestWithStyle, TONES } from '../_shared/style.ts';
import { BROKEN_PAGE_RULES, FRONTEND_CRAFT, REAL_CONTENT_RULES, SHARED_FILE_RULES } from './craft.ts';
import { STAGE_IO, STAGE_LABELS, STAGE_RULES, type ArtifactKind, type Blocker, type LatestArtifacts, type Stage } from '../_shared/stages.ts';

export interface StagePrompt {
  /** The prompt-cached system block: stage instructions + input artifacts. Depends ONLY on (stage, input artifacts). */
  system: string;
  /** Not cached: the artifact being edited + the per-call reminder. */
  suffix: string;
  /** 'build' = the main (Sonnet) model, 'fast' = the cheap one; index.ts maps these to model ids. */
  model: 'build' | 'fast';
  maxTokens: number;
}

export const ARTIFACT_OPEN = '[[ARTIFACT]]';
export const ARTIFACT_CLOSE = '[[/ARTIFACT]]';

const COMMON = `You are Vertly's guide for turning an idea into a real, launch-ready business website. The work happens in explicit stages — plan, example, full build, tweaks, launch, business — and the person decides when to move on; you work only on the stage you are given.

Talk like a sharp co-founder: plain English, short, no jargon, never any code in chat. Never invent facts the owner has not given you — no made-up customers, testimonials, logos, statistics, awards, prices they did not choose, or legal text. If something real is missing, say so and put it on the launch checklist instead of filling the gap.`;

/** The PLAN stage prompt (REVAMP Step 8). Exported so the tests can pin the rules that matter. */
export const PLAN_BRIEF = `STAGE: PLAN. You are helping the owner turn an idea into a concrete plan for their site. The plan is shown to them as an editable card next to this chat, so the chat is for talking and the card is for the details.

HOW THE CONVERSATION GOES
- Draft fast. The moment you can tell WHAT the business or site is and WHAT it offers, save a first plan in that same reply — even from a single line like "a site for my dog-walking business". Never hold the plan back to ask questions first.
- If you truly cannot tell what it is or what is offered (e.g. "I want to make money online"), do not save yet: ask at most two short questions and offer two or three concrete directions to pick from.
- After the plan is saved, ask at most one or two questions, the ones that would change the plan most (what they charge, what makes them different, who exactly it is for). Plain questions, one per line, no numbering, no lists of options unless it helps.
- Keep the chat short: two to four sentences plus your question(s). Never repeat the plan in chat — the card shows it. Say what you assumed and what you need from them.
- Reply in the language the owner writes in (the plan's text too).
- If the owner asks what they could earn, do not promise or estimate: tell them the revenue what-if on the plan card lets them try their own numbers, and put nothing in "scenario" yourself.

WHAT GOES IN THE PLAN
- "name": the owner's name for it. If they gave none, propose a short working name and mention it is a placeholder they can change.
- "one_liner", "audience", "offer": plain sentences built from what the owner actually said. If the owner said nothing about one of them, make a modest, general statement from the idea itself (not a claim about their business) and say so in "notes".
- "pricing": use ONLY prices the owner stated. If they have not named a price, set "model" to the way they will probably charge (or "none"), leave "items" empty, add a launch-checklist item to decide prices, and ask what they will charge. Never invent a price, discount, plan name or currency.
- "pages": the pages this kind of site actually needs, usually 1–6; "index.html" first; simple lowercase file names ("about.html", "contact.html"); each with a one-line purpose. Don't pad: a one-page site is a fine answer.
- "backend": only what the plan truly needs. A contact or sign-up form → "forms". Things for sale → "products" (names the owner gave; leave empty if they named none). Visitor data to store → "collections". "auth": true only if visitors must log in.
- "launch_checklist": EVERYTHING only the owner can supply, so nothing is made up later: real photos, the real product/service list, prices, their story or bio text, contact details, legal text (a privacy policy if the site collects data, terms if it sells), a domain if they want their own. Short ids, plain labels, "done": false.
- "notes": one or two short sentences listing what you assumed and what the owner should double-check. Leave it out when there is nothing to flag.
- Never invent customers, reviews, testimonials, logos, statistics, awards, team members, addresses, phone numbers or legal text — not in the plan, not in the chat.

EDITING AN EXISTING PLAN
- The CURRENT plan (sent with every message) is what the owner sees and may have edited by hand. Treat their edits as decisions. Change only what they ask for (or what their message clearly implies) and copy everything else back exactly as it is — including every checklist item and its "done" flag, the pricing, and the "scenario".
- When the owner answers a question, update the plan with the answer and ask the next question; don't start over.
- Save the plan again only when something in it changes. A reply that just answers a question leaves the card alone.`;

/** The files the EXAMPLE stage writes, in the order the model writes them. */
export const EXAMPLE_FILES = ['styles.css', 'index.html', 'site.js', 'manifest.json'] as const;

/** The EXAMPLE stage prompt (REVAMP Step 9). Exported so the tests can pin the rules that matter. */
export const EXAMPLE_BRIEF = `STAGE: EXAMPLE. You are building the owner's LANDING PAGE and, through it, the visual style of their whole site, from the plan below. It is a free preview: ONE page. The owner then changes the look with one-click controls (light or dark, accent colour, font pairing, spacing, tone) and locks the style; the full site is built later in exactly that style.

WHAT YOU WRITE
- Four files, in this order, as <file name="…"> blocks in the format described under SAVING YOUR WORK: styles.css, index.html, site.js, manifest.json. Nothing else — no other pages, no memory files (_longterm, _shortterm, _pages, _backend; ignore every instruction about them), no patches. Always write each file completely, even when a page exists already: every run starts the page afresh.
- Chat, kept short and in the language of the plan: before the files, two or three plain sentences on the direction you took (the mood, what the page leads with) and any call you made that the owner should know about; after the files, ONE sentence naming what you left out because only the owner can supply it (real photos, prices, customer quotes, contact details…), or nothing if there is nothing. Never describe how it is built, never name files, never write colour codes in chat.

THE LANDING PAGE
- Built only from the plan: its name, one-liner, audience, offer, and the prices it states. 4–6 focused sections: a hero (headline + a line of support + one main call to action + a visual built from CSS), what is offered or how it works, one more value section the plan supports (pricing only if the plan lists prices), and a closing call to action. Add a section only when the plan gives you true material for it.
- Real, specific copy in the owner's voice. No lorem ipsum, no "coming soon", no invented proof of any kind (see REAL CONTENT ONLY).
- The example has no working forms or accounts yet — the backend is set up in the full build. So write no <form>, no sign-up or payment box. Every button and link must work: it scrolls to a section of THIS page (index.html#section-id). The nav lists this page's own sections only; do not link to pages that do not exist yet. The main call to action points at the section that explains how to get started; the full build makes it real, and you can say so in chat.
- Visuals are CSS only (gradients, shapes, drawn interface mockups with illustrative content) — never an invented image address.

THE STYLE MUST SWAP WITHOUT YOU
The owner re-skins the page in a second, without asking you again. That only works if the whole look comes from the tokens in the :root block of styles.css:
- Every colour is a token. The page must look right in BOTH light and dark: the neutral tokens (--bg --surface --surface-2 --border --text --text-muted and the two shadows) are swapped for a dark or light set, and the accent is swapped for another colour. So never hard-code a "dark section" on a light page or the reverse — build contrast between sections from tokens (var(--surface), var(--surface-2), color-mix(in srgb, var(--text) 6%, var(--bg))). Text on an accent background uses var(--accent-contrast).
- Fonts only through var(--font-display) and var(--font-body). One @import of Google Fonts at the very top of styles.css, never a <link> in the page. Choose a pairing that fits the business.
- Rounded corners use var(--radius) (buttons, inputs, small cards) and var(--radius-lg) (large panels); a pill shape (9999px) only for tags and badges. The owner's tone control changes these two.
- Vertical space between sections is var(--section-y), and nothing else sets section padding. The owner's spacing control changes it.
- The look of the nav and footer lives in styles.css (.vx-nav, .vx-link, .vx-cta, .vx-footer …); their content lives in site.js.

THE TONE
In the optional note (see SAVING YOUR WORK) set "tone" to the closest of these: ${TONES.map((t) => `"${t.tone}"`).join(', ')} — the owner's tone control matches on the exact words. "voice" is one line on how the copy of the whole site should sound, written the way the owner's own plan sounds.

WHEN THERE IS A CURRENT STYLE
The owner may already have tuned the style with the controls. If the message below includes a CURRENT style_spec, keep its colour tokens, fonts, spacing and tone exactly as they are in the new styles.css (copy the values) unless the owner's message asks to change them. If the owner writes a note ("bolder", "more like a magazine", "less pink"), act on it — a redesign of layout and copy is fine; the style values stay unless the note is about them.`;

/** Reference material appended after a stage's brief and protocol (cached system block). */
const STAGE_REFERENCE: Partial<Record<Stage, string>> = {
  example: [SHARED_FILE_RULES, REAL_CONTENT_RULES, BROKEN_PAGE_RULES, FRONTEND_CRAFT].join('\n\n'),
};

const STAGE_BRIEF: Record<Stage, string> = {
  plan: PLAN_BRIEF,
  example: EXAMPLE_BRIEF,
  build: `STAGE: FULL BUILD. Build the complete site from the plan, obeying the locked style exactly. Report what was built.`,
  tweaks: `STAGE: TWEAKS. Make the specific change the owner asks for to the built site, obeying the locked style, and change nothing else.`,
  launch: `STAGE: LAUNCH. Help the owner get ready to go live: walk through what is still open and explain the launch check results in plain language.`,
  business: `STAGE: BUSINESS. Act as the owner's business partner, grounded ONLY in the real data you are given. If there is not enough data yet, say so plainly instead of guessing.`,
};

/** Per-stage model + output budget. Skeleton values — Steps 8–11 tune them. */
const STAGE_RUN: Record<Stage, { model: 'build' | 'fast'; maxTokens: number }> = {
  plan: { model: 'fast', maxTokens: 4000 },
  example: { model: 'build', maxTokens: 24000 },
  build: { model: 'build', maxTokens: 24000 },
  tweaks: { model: 'fast', maxTokens: 12000 },
  launch: { model: 'fast', maxTokens: 4000 },
  business: { model: 'fast', maxTokens: 4000 },
};

/** JSON with object keys sorted at every level, so the same data always serializes to the same bytes (prompt-cache stability). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/**
 * What stops an AI run of `stage` right now: every INPUT artifact must exist, be fresh, and carry its required flags (the style
 * must be locked wherever it is an input). The artifact the stage works on need not exist yet.
 */
export function inputBlockers(stage: Stage, latest: LatestArtifacts): Blocker[] {
  const out: Blocker[] = [];
  const flags: Record<string, string> = STAGE_RULES.required_flags;
  for (const kind of STAGE_IO[stage].inputs) {
    const a = latest[kind];
    const flag = flags[kind];
    if (!a) out.push({ kind, reason: 'missing' });
    else if (a.stale) out.push({ kind, reason: 'stale' });
    else if (flag && a.data[flag] !== true) out.push({ kind, reason: `flag:${flag}` });
  }
  return out;
}

/** The exact JSON each saved artifact must have (validateArtifact in _shared/artifacts.ts enforces it). Part of the cached system block. */
const ARTIFACT_SHAPES: Partial<Record<ArtifactKind, string>> = {
  plan: `{
  "schema": 1,
  "name": "the business or site name",
  "kind": "site" | "app",
  "one_liner": "what it is, in one sentence",
  "audience": "who it is for",
  "offer": "what a customer gets or buys",
  "pricing": { "model": "free" | "one_time" | "subscription" | "donation" | "quote" | "none", "items": [ { "name": "Standard", "price_cents": 1900, "interval": "month" | "year" } ] },
  "pages": [ { "file": "index.html", "title": "Home", "purpose": "what this page is for" } ],
  "backend": { "collections": ["waitlist"], "products": ["soy-candle"], "forms": ["contact"], "auth": false },
  "launch_checklist": [ { "id": "photos", "label": "Real photos of your product", "type": "photo" | "text" | "legal" | "product" | "domain" | "other", "done": false } ],
  "scenario": null,
  "notes": "what you assumed that the owner should double-check (optional)"
}
Rules: prices are whole cents; leave "interval" out unless it is a subscription (never write null for anything except "scenario"); "backend" lists are plain lists of short lowercase names (strings only, no objects) — collections hold visitor data, products are things for sale, forms are contact/sign-up forms, auth is true only if visitors need accounts; "launch_checklist" lists everything only the owner can supply; "scenario" is the owner's revenue what-if ({ "price_cents", "monthly_visitors", "conversion_pct" }) — it stays null until the owner makes one, and once it exists you copy it back unchanged; "notes" is optional text.`,
  style_spec: `{
  "schema": 1,
  "locked": false,
  "vibe": { "theme": "light" | "dark", "density": "compact" | "comfortable" | "airy", "tone": "a few words, e.g. warm and friendly" },
  "tokens": { "--bg": "#f6f1e9", "--surface": "#ffffff", "--text": "#1f1a17", "--accent": "#b4532a" },
  "fonts": { "display": "Fraunces", "body": "Inter", "import_url": "https://fonts.googleapis.com/css2?family=Fraunces&family=Inter" },
  "voice": "one line on how the copy should sound"
}
Token names are CSS custom properties (--name) with plain values. Always set "locked" to false — only the owner locks a style.`,
  manifest: `{
  "schema": 1,
  "built_at": "ISO date-time",
  "pages": [ { "file": "index.html", "title": "Home", "in_nav": true } ],
  "shared_files": ["styles.css", "site.js"],
  "backend": { "collections": [], "products": [], "forms": [], "auth": false }
}`,
};

/** EXAMPLE saves FILES; the style spec is read out of styles.css afterwards, so the model only adds an optional note about tone and voice. */
const EXAMPLE_PROTOCOL = `SAVING YOUR WORK
Write each file as <file name="styles.css"> … </file> (and likewise index.html, site.js, manifest.json), using exactly these XML delimiters and never a code fence. The style is read from the :root tokens of the styles.css you write, so there is no separate style to fill in. The format of each file is under OUTPUT FORMAT / SHARED-FILE RULES below.

After the last file you may add ONE optional note, on lines of its own between ${ARTIFACT_OPEN} and ${ARTIFACT_CLOSE}:
{ "tone": "warm and friendly", "voice": "one line on how the copy should sound", "art_direction": { "layout": "the page layout in a few words", "signature": "the one distinctive move of this design" } }
Every field is optional. Keep the chat outside the markers.`;

function protocolFor(stage: Stage): string {
  if (stage === 'example') return EXAMPLE_PROTOCOL;
  const produces = STAGE_IO[stage].produces;
  if (!produces) return 'This stage does not save anything: reply with chat text only.';
  return `SAVING YOUR WORK
Whenever your reply changes the ${produces}, end it with the COMPLETE updated ${produces} as one JSON object between ${ARTIFACT_OPEN} and ${ARTIFACT_CLOSE}, each marker on its own line — never inside a code fence, never partial. Everything outside the markers is shown to the person as chat. If your reply changes nothing, leave the markers out.

The ${produces} must have exactly this shape:
${ARTIFACT_SHAPES[produces] ?? '{ "schema": 1 }'}`;
}

/** Assemble the cache-stable prompt for one AI run of `stage`. Precondition: inputBlockers(stage, latest) is empty. */
export function buildStagePrompt(stage: Stage, latest: LatestArtifacts, opts: { projectName?: string } = {}): StagePrompt {
  const io = STAGE_IO[stage];
  const inputs = io.inputs
    .map((kind) => {
      const a = latest[kind];
      return a ? `### ${kind} (version ${a.version})\n${canonicalJson(a.data)}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const system = [COMMON, STAGE_BRIEF[stage], protocolFor(stage), STAGE_REFERENCE[stage] ?? '', inputs ? `THE PROJECT SO FAR (settled by earlier stages — treat as fixed):\n\n${inputs}` : '']
    .filter(Boolean)
    .join('\n\n');

  const cur = io.worksOn ? latest[io.worksOn] : undefined;
  const parts: string[] = [];
  if (opts.projectName) parts.push(`Project name: ${opts.projectName}`);
  if (io.worksOn) {
    parts.push(
      cur
        ? `CURRENT ${io.worksOn} (version ${cur.version}${cur.stale ? ', OUT OF DATE — an earlier stage changed after it was made' : ''}):\n${canonicalJson(cur.data)}`
        : `There is no ${io.worksOn} yet.`,
    );
  }
  parts.push(`You are working on the ${STAGE_LABELS[stage]} stage only.`);

  return { system, suffix: `\n\n${parts.join('\n\n')}`, ...STAGE_RUN[stage] };
}

export interface ExtractedArtifact {
  /** The reply with the artifact block removed — what the person should read. */
  chat: string;
  /** Parsed JSON of the last artifact block, if there was one. */
  json?: unknown;
  /** Set when a block was present but unusable (unterminated / not JSON). */
  error?: string;
}

/** Pull the last [[ARTIFACT]]…[[/ARTIFACT]] block out of a reply. Tolerates a code fence around the JSON. */
export function extractArtifact(message: string): ExtractedArtifact {
  const open = message.lastIndexOf(ARTIFACT_OPEN);
  if (open === -1) return { chat: message.trim() };
  const before = message.slice(0, open);
  const rest = message.slice(open + ARTIFACT_OPEN.length);
  const close = rest.indexOf(ARTIFACT_CLOSE);
  if (close === -1) return { chat: before.trim(), error: 'The AI stopped in the middle of saving. Nothing was changed — please try again.' };
  const after = rest.slice(close + ARTIFACT_CLOSE.length);
  const chat = `${before}${after}`.replace(/\n{3,}/g, '\n\n').trim();
  const raw = rest.slice(0, close).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return { chat, json: JSON.parse(raw) };
  } catch {
    return { chat, error: 'The AI saved something that could not be read. Nothing was changed — please try again.' };
  }
}

export interface FinishedStage {
  chat: string;
  /** What to save (validated), or null for a chat-only turn / a failure. */
  artifact: { kind: ArtifactKind; data: Record<string, unknown> } | null;
  /** Site files to write into projects.files BEFORE the artifact is saved (EXAMPLE only). */
  files?: Record<string, string>;
  error?: string;
}

/** Turn the model's finished reply into something safe to save. Never throws; anything unusable becomes `error` and saves nothing. */
export function finishStage(stage: Stage, message: string, files: Record<string, string> = {}): FinishedStage {
  if (stage === 'example') return finishExample(message, files);
  const x = extractArtifact(message);
  const produces = STAGE_IO[stage].produces;
  if (x.error) return { chat: x.chat, artifact: null, error: x.error };
  if (x.json === undefined || !produces) return { chat: x.chat, artifact: null };
  const v = validateArtifact(produces, normalizeArtifact(x.json));
  if (!v.ok) {
    return { chat: x.chat, artifact: null, error: `The AI's ${produces.replace('_', ' ')} was incomplete (${v.errors.slice(0, 3).join('; ')}). Nothing was changed — please try again.` };
  }
  const data = v.value as unknown as Record<string, unknown>;
  // Locking a style is the owner's decision (it freezes what the full build must obey) — a model can never lock one.
  if (produces === 'style_spec') data.locked = false;
  return { chat: x.chat, artifact: { kind: produces, data } };
}

const FILE_WORDS: Record<(typeof EXAMPLE_FILES)[number], string> = { 'styles.css': 'the styling', 'index.html': 'the page itself', 'site.js': 'the menu and footer details', 'manifest.json': 'the app details' };
const MAX_FILE_CHARS = 300_000;

/**
 * The EXAMPLE run's result: the four files the model wrote + the style read out of them. The stylesheet is the source of truth —
 * deriveStyleSpec() reads the style from its :root tokens, applyStyleSpec() writes the completed tokens and the single font import
 * back into it (so file and spec can never disagree), and manifest.json follows the palette. Whatever the model wrote beyond the
 * four files is dropped. The spec is never locked here.
 */
export function finishExample(message: string, written: Record<string, string>): FinishedStage {
  const x = extractArtifact(message); // the optional tone/voice note; a damaged note is simply ignored
  const note = x.json && typeof x.json === 'object' && !Array.isArray(x.json) ? (x.json as Record<string, unknown>) : {};
  const fail = (why: string): FinishedStage => ({ chat: x.chat, artifact: null, error: `${why} Nothing was changed — please try again.` });

  const files: Record<string, string> = {};
  for (const name of EXAMPLE_FILES) {
    const text = written[name];
    if (typeof text === 'string' && text.trim()) files[name] = text;
  }
  const missing = EXAMPLE_FILES.filter((n) => n !== 'manifest.json' && !files[n]);
  if (missing.length === EXAMPLE_FILES.length - 1) return fail("The AI didn't write your page.");
  if (missing.length > 0) return fail(`The AI stopped before finishing — ${missing.map((n) => FILE_WORDS[n]).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.`);
  for (const [n, t] of Object.entries(files)) if (t.length > MAX_FILE_CHARS) return fail(`${FILE_WORDS[n as (typeof EXAMPLE_FILES)[number]]} came out too large.`);

  const html = files['index.html']!;
  if (!/<\/html\s*>/i.test(html)) return fail('The page was cut off before its end.');
  if (!/<link[^>]+href=["']styles\.css["']/i.test(html)) return fail("The page isn't connected to its style.");

  const derived = deriveStyleSpec(files['styles.css']!, note);
  if (derived.problems.length > 0) return fail(`The style was incomplete (${derived.problems.slice(0, 3).join('; ')}).`);
  const spec = derived.spec;
  const valid = validateArtifact('style_spec', normalizeArtifact(spec));
  if (!valid.ok) return fail(`The style was incomplete (${valid.errors.slice(0, 3).join('; ')}).`);

  files['styles.css'] = applyStyleSpec(files['styles.css']!, spec);
  if (files['manifest.json']) files['manifest.json'] = manifestWithStyle(files['manifest.json'], spec);
  return { chat: x.chat, files, artifact: { kind: 'style_spec', data: valid.value as unknown as Record<string, unknown> } };
}
