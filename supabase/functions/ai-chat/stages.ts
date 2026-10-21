// Stage endpoints for the guided flow — prompt assembly and output handling, as pure functions (no I/O, no Deno APIs) so they
// are unit-tested under Node (supabase/tests/ai_stages.test.ts). stage-handler.ts does the I/O around them; index.ts wires it in.
//
// STATUS: SKELETON (REVAMP Step 7). The mechanics are real — which artifacts each stage reads, a prompt-cache-stable layout,
// strict parsing and validation of what the model saves — but the per-stage instructions below are deliberately short. Steps 8
// (PLAN), 9 (EXAMPLE), 10 (FULL BUILD) and 11 (TWEAKS) replace STAGE_BRIEF[stage] with the real prompts and, where a stage
// produces files, add its own finisher. See docs/STAGES.md.
//
// Prompt-cache layout (why it looks like this): Anthropic caches a prompt PREFIX, so the system block must be byte-identical
// across every call of a stage session. It therefore holds only things that cannot change while the stage runs — the stage
// instructions and the stage's INPUT artifacts (upstream, frozen, fresh). The artifact the stage is editing changes every turn,
// so it goes in the non-cached suffix, together with the per-call reminder.
import { normalizeArtifact, validateArtifact } from '../_shared/artifacts.ts';
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

const STAGE_BRIEF: Record<Stage, string> = {
  plan: PLAN_BRIEF,
  example: `STAGE: EXAMPLE. Using the plan, define the visual style (theme, colors as CSS custom properties, fonts, density, tone of voice) for a one-page example of the site. The style you save is what the full build will obey once the owner locks it.`,
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

function protocolFor(stage: Stage): string {
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

  const system = [COMMON, STAGE_BRIEF[stage], protocolFor(stage), inputs ? `THE PROJECT SO FAR (settled by earlier stages — treat as fixed):\n\n${inputs}` : '']
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
  error?: string;
}

/** Turn the model's finished reply into something safe to save. Never throws; anything unusable becomes `error` and saves nothing. */
export function finishStage(stage: Stage, message: string): FinishedStage {
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
