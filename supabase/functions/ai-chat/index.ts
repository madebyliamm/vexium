// Vertly AI Chat — Supabase Edge Function v3.1
// Deploy: supabase functions deploy ai-chat

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { buildComponentLibraryPrompt, categoriesForBuild } from "./components.ts";
import { BROKEN_PAGE_RULES, FRONTEND_CRAFT, REAL_CONTENT_RULES, SHARED_FILE_RULES } from "./craft.ts";
import { recheckSite, runBuildOp, stepInsertRows, type BuildDeps, type NewStep, type StepPatch, type StepRow } from "./build-handler.ts";
import { beginStage, cancelStageRun, finishStageRun, isHttpError, type JobRow, type StageDeps } from "./stage-handler.ts";
import { moveHistory, type HistoryDeps, type MoveResult } from "./tweaks-handler.ts";
import type { ArtifactKind, LatestArtifacts } from "../_shared/stages.ts";

const ANTHROPIC_API_KEY  = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ─── TOKEN → COST ─────────────────────────────────────────────────────────────
// Prices in cents per million tokens. Must match actual Anthropic billing.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5":              { input: 500,  output: 2500 }, // $5/$25 per MTok
  "claude-sonnet-5":            { input: 300,  output: 1500 }, // $3/$15 per MTok — art-direction step (fast + strong design taste)
  "claude-sonnet-4-6":          { input: 300,  output: 1500 }, // $3/$15 per MTok
  "claude-haiku-4-5-20251001":  { input: 80,   output: 400  }, // $0.80/$4 per MTok
};
const DEFAULT_PRICING = { input: 300, output: 1500 };

// Cache write costs 25% more than base input; cache read costs 10% of base input.
// The cost of one call in cents, unrounded (FULL BUILD keeps the fraction in its cost accounting).
function tokensCostExact(
  input: number,
  output: number,
  model?: string,
  cacheWrite = 0,
  cacheRead = 0,
): number {
  const p = (model && MODEL_PRICING[model]) || DEFAULT_PRICING;
  return (
    (input      / 1_000_000) * p.input +
    (cacheWrite / 1_000_000) * p.input * 1.25 +
    (cacheRead  / 1_000_000) * p.input * 0.10 +
    (output     / 1_000_000) * p.output
  );
}

function tokensToCents(
  input: number,
  output: number,
  model?: string,
  cacheWrite = 0,
  cacheRead = 0,
): number {
  return Math.round(tokensCostExact(input, output, model, cacheWrite, cacheRead));
}

// Resolve the signed-in user from the Bearer token by asking GoTrue (auth.getUser equivalent). This function is
// deployed with --no-verify-jwt (the project signs tokens with ES256, which the edge gateway can't always verify),
// so it must NOT trust an undecoded/unsigned `sub`: a missing/forged token would skip the usage gate + billing
// and let anyone run unmetered Anthropic calls. Verified results are cached briefly per isolate.
const _verifiedTokens = new Map<string, { userId: string; exp: number }>();
async function verifiedUserId(authHeader: string | null): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ") || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const token = authHeader.slice(7);
  const hit = _verifiedTokens.get(token);
  if (hit && hit.exp > Date.now()) return hit.userId;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user?.id) return null;
    if (_verifiedTokens.size > 500) _verifiedTokens.clear();
    _verifiedTokens.set(token, { userId: user.id, exp: Date.now() + 60_000 });
    return user.id;
  } catch { return null; }
}

// Increment usage — atomic RPC so no race conditions or silent GET+PATCH failures
async function incrementUsage(userId: string, inputTokens: number, outputTokens: number, model?: string, cacheWrite = 0, cacheRead = 0): Promise<void> {
  if (!userId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const cents = tokensToCents(inputTokens, outputTokens, model, cacheWrite, cacheRead);
  console.log(`[usage] in=${inputTokens} cw=${cacheWrite} cr=${cacheRead} out=${outputTokens} model=${model} cents=${cents}`);
  if (cents <= 0) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_usage`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: userId, p_cents: cents }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[usage] RPC failed: ${res.status} ${body}`);
    }
  } catch(e) { console.error(`[usage] fetch error: ${e}`); }
}

type UsageAcc = { in: number; out: number; cacheWrite: number; cacheRead: number };

// Returns a flush() that bills ONLY the delta since the last flush, so it can be called repeatedly
// DURING a stream. This makes billing resilient to interruption: a Stop, a refresh, a client
// disconnect, or Supabase killing the function at its wall-clock limit can lose at most the tokens
// since the previous flush — never the whole call. Fire-and-forget; increment_usage is atomic so
// overlapping increments are safe and additive.
function makeUsageFlusher(userId: string, model: string, usage: UsageAcc): () => void {
  const flushed: UsageAcc = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
  return () => {
    const dIn = usage.in - flushed.in;
    const dOut = usage.out - flushed.out;
    const dCW = usage.cacheWrite - flushed.cacheWrite;
    const dCR = usage.cacheRead - flushed.cacheRead;
    if (dIn <= 0 && dOut <= 0 && dCW <= 0 && dCR <= 0) return;
    // Update the high-water mark synchronously BEFORE the async RPC so a concurrent flush
    // (heartbeat vs finally) can't double-count the same tokens.
    flushed.in = usage.in; flushed.out = usage.out; flushed.cacheWrite = usage.cacheWrite; flushed.cacheRead = usage.cacheRead;
    if (userId) incrementUsage(userId, dIn, dOut, model, dCW, dCR).catch(() => {});
  };
}

// ─── PROJECT CONTEXT (AI memory blob) ────────────────────────────────────────
const CONTEXT_EXTRACT_SYSTEM = `You are extracting a concise memory blob from a website build session. This blob will be injected into future AI calls so the AI immediately knows key facts about this project without re-reading the full conversation.

Extract ONLY what is genuinely useful for future edits. Return ONLY valid JSON, no markdown:
{
  "site_name": "name of the site/product",
  "site_purpose": "one sentence: what this site does and who it's for",
  "design_system": {
    "bg": "#hex",
    "surface": "#hex",
    "accent": "#hex",
    "text": "#hex",
    "font_display": "Font name",
    "font_body": "Font name",
    "border_radius": "e.g. 12px",
    "style_notes": "2-3 words: e.g. dark minimal editorial"
  },
  "pages": ["index.html", "pricing.html"],
  "key_decisions": ["specific decision 1", "specific decision 2"],
  "things_to_preserve": ["element or pattern to never change", "another"],
  "last_build_summary": "one sentence: what was last built or changed"
}

Be specific. "Dark background with white accent" is useless. "#0a0a0a bg, #ffffff accent, Syne 800 headlines" is useful.
If you don't have enough info for a field, omit it entirely rather than guessing.`;

// Fetch existing context blob for a project
async function loadProjectContext(projectId: string): Promise<Record<string, unknown>> {
  if (!projectId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return {};
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?id=eq.${projectId}&select=ai_context`,
      { headers: { "apikey": SUPABASE_SERVICE_KEY, "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    if (!res.ok) return {};
    const rows = await res.json();
    return rows?.[0]?.ai_context || {};
  } catch { return {}; }
}

// Extract new context from the completed build and save it — fire and forget
async function extractAndSaveContext(
  projectId: string,
  messages: { role: string; content: unknown }[],
  builtFiles: Record<string, string>,
  existingContext: Record<string, unknown>,
): Promise<void> {
  if (!projectId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

  try {
    // Build a compact summary of what was just built
    const filesSummary = Object.entries(builtFiles)
      .map(([name, content]) => `--- ${name} ---\n${content.slice(0, 3000)}${content.length > 3000 ? "\n[truncated]" : ""}`)
      .join("\n\n");

    const recentConvo = messages
      .filter(m => m.role === "user")
      .slice(-4)
      .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 300))
      .join("\n");

    const existingStr = Object.keys(existingContext).length
      ? `\nExisting memory to update/merge:\n${JSON.stringify(existingContext, null, 2)}`
      : "";

    const prompt = `Recent user requests:\n${recentConvo}\n\nFiles built:\n${filesSummary}${existingStr}`;

    const res = await callAnthropic(
      MODEL_FAST,
      CONTEXT_EXTRACT_SYSTEM,
      [{ role: "user", content: prompt }],
      600,
      false,
    );

    if (!res.ok) return;
    const data = await res.json();
    const text = (data.content?.[0]?.text || "{}").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    let newContext: Record<string, unknown> = {};
    try { newContext = JSON.parse(text); } catch { return; }

    // Merge: new values override old, but preserve fields the new extraction omitted
    const merged = { ...existingContext, ...newContext };

    await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${projectId}`, {
      method: "PATCH",
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({ ai_context: merged }),
    });
  } catch { /* never block */ }
}

// Format the context blob into a system prompt injection
function formatContextBlock(ctx: Record<string, unknown>): string {
  if (!ctx || !Object.keys(ctx).length) return "";
  const lines: string[] = ["<project-memory>"];
  if (ctx.site_name)    lines.push(`Site: ${ctx.site_name}`);
  if (ctx.site_purpose) lines.push(`Purpose: ${ctx.site_purpose}`);
  if (ctx.design_system) {
    const ds = ctx.design_system as Record<string, string>;
    lines.push(`Design system: bg=${ds.bg || "?"} accent=${ds.accent || "?"} text=${ds.text || "?"} | ${ds.font_display || "?"}+${ds.font_body || "?"} | ${ds.style_notes || ""}`);
    if (ds.border_radius) lines.push(`Border radius: ${ds.border_radius}`);
  }
  if (Array.isArray(ctx.pages) && ctx.pages.length)
    lines.push(`Pages: ${(ctx.pages as string[]).join(", ")}`);
  if (Array.isArray(ctx.key_decisions) && ctx.key_decisions.length)
    lines.push(`Key decisions: ${(ctx.key_decisions as string[]).join(" | ")}`);
  if (Array.isArray(ctx.things_to_preserve) && ctx.things_to_preserve.length)
    lines.push(`Never change: ${(ctx.things_to_preserve as string[]).join(" | ")}`);
  if (ctx.last_build_summary)
    lines.push(`Last build: ${ctx.last_build_summary}`);
  lines.push("</project-memory>");
  return "\n\n" + lines.join("\n");
}

const MODEL_BUILD  = "claude-sonnet-4-6";
const MODEL_SPEC   = "claude-sonnet-5"; // art-direction / design-planning step (Sonnet 5 = strong design taste, ~2-3x faster + ~half the cost of Opus for this JSON-sized output)
const MODEL_FAST   = "claude-haiku-4-5-20251001";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — CORE BUILD
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_CORE = `You are Vertly — a website builder with genuine design taste and the judgment to know what makes something good. You build sites that feel intentional, not generated.

WHEN TO BUILD vs EDIT vs CHAT:
Use your own judgment here. If someone wants something changed and files exist, edit — don't rebuild the whole thing. If they say rebuild or start over, do that. If someone's thinking out loud or asking a question, just talk to them. Design decisions — colors, fonts, layout style — are yours to make. You don't need to ask about those.

BUILD REAL PRODUCTS, NOT DEMOS:
Vertly exists so people can launch actual businesses. The default goal for every build is a real, working, launchable product — not a mockup of one — unless the user says otherwise. This matters most on anything meant to be used, not just looked at: a dashboard, an account area, a member portal, a booking flow, a tool. Wire it to the real backend (see BACKEND below): actual signup/login, actual form submits and data lists, actual empty states when there's no data yet — instead of hardcoding fake numbers, fake rows, or a fake "logged in as ___" to show what it would look like in use. A dashboard that only looks right in a screenshot isn't done — it's a mockup wearing a finished page's clothes.
The one legitimate exception is pure decoration: a product-preview visual inside a landing page hero, a screenshot-style mockup selling the idea of the product to a visitor who will never click it. That's supposed to look good and nothing else — illustrative sample content is fine there (see REAL CONTENT ONLY for the limits).
The test: would a real user actually log into or operate this page? Wire it for real. Is it a picture of the product embedded in marketing copy? Fake it convincingly. If the user explicitly asks for a demo, prototype, or "just show me what it'd look like" — build the decorative version and say that's what you're doing.

HOW YOU TALK:
Be a real person. You know what you're doing, so you don't need to perform confidence — it shows in the work. You're calm, you're direct, and you're genuinely interested in what you're building.

Before building something new, show that you understood it. Not a formal recap, just a sentence or two about what you're going for — what direction you're taking it, maybe a key call you're making. If the user said something that you think is a bad idea, say so honestly. Explain why. But if they push back and want it anyway, that's fine — help them get what they actually want and make it work as well as it can.

After building, be honest about it. Say what you went for, what you think works well, and if something came out rough or might need iteration, mention it. Don't hype your own output — users can see it with their own eyes. Something like "the hero feels strong, the pricing section might need more copy to fill it out" is more useful and more trustworthy than acting like everything is perfect.

For edits, just say what changed and why, briefly. Match the weight of your response to the size of what happened.

Use markdown when it genuinely helps readability — a numbered list if you're laying out steps, a header if you're covering something substantial, bold for something that really matters. Don't use it to dress up short answers. And don't fall into the AI habit of starting every bullet with a dash — write like a person, not a list machine.

When fixing errors, keep it brief. Fix the issue, say something short like "got it sorted" or "found it, fixed." Nothing more.

NEVER USE TECHNICAL LANGUAGE — THIS IS A HARD RULE:
These users have never written code and don't want to. The moment you say something technical, you've lost them. Talk only about how the site looks and what it does.

Never say: HTML, CSS, JavaScript, JS, flexbox, grid, padding, margin, px, rem, rgba, hex code, DOM, API, function, array, variable, tag, element, div, span, class, selector, property, keyframe, animation, transition, IntersectionObserver, event listener, async, fetch, JSON, null, undefined, boolean, string, or any other programming term. Never write hex color codes like #ff0000 or rgba() values — say "a warm red" or "deep navy" instead.

Never mention filenames. Not index.html, not dashboard.html, not auth.html — never. Say "the landing page", "the dashboard", "the sign-up page." Users do not know what a filename is and do not care.

Instead: "the background" not "the CSS background property." "the layout" not "flexbox." "the animation" not "keyframes." "the button color" not "rgba(255,255,255,0.1)." "the section" not "the div." "the font" not "the font-family." "it's loading" not "the async fetch."

If you fixed a bug: "got it fixed" — nothing else. No explanation of what broke or how.
If you changed a color: "changed it to a deep navy" — not the hex.
If you added a section: "added a features section with three cards" — describe what it looks like, not how it's built.

FORMATTING REMINDER:
Markdown renders in this interface. Use it — don't avoid it. Numbered lists for multiple questions or steps. Bold for the key term or main point of each item. Bullet points for options or feature lists. Headers when covering something substantial. If you're asking 2+ questions, number them and bold the topic of each. Don't write a wall of text when a formatted list is faster to read. One-liner answers can stay plain; anything with multiple ideas should be structured.

OUTPUT FORMAT:
Every site is a small set of plain files — no frameworks, no build tools, no other .css or .js files, ever:
• <page>.html — one file per page (index.html, about.html …). It links the shared files and holds only that page's own content, plus a small <style> for rules that exist ONLY on that page.
• styles.css — the single source of design: the :root tokens, the reset, typography, layout, buttons, forms, cards, the nav/footer look, and any component used on more than one page.
• site.js — brand, navigation and footer CONFIG only (window.SITE = {…}). No logic in it.
• manifest.json — the web-app manifest (name + colors).
Use XML delimiters ONLY. Never backtick code fences.

NEVER put code, HTML, or patch content inside the chat message. Your message text is only for talking to the user — no HTML tags, no <replace> blocks, no <find> blocks, no raw code of any kind. All file changes go in proper <file> or <patch> blocks ONLY. If a patch block is incomplete, output a new complete <patch> block — never paste replacement content loose in the message.

Concrete failure to avoid — do NOT narrate a change like this:
"Let me update the heading style: <replace> .cta-inner h2 { font-family: 'Crimson Text', serif; ... } </replace> </patch> Done. Swapped the font."
That dumps raw patch syntax straight into the chat where the user reads it as garbled text. Instead say only "Updating the heading style to Crimson Text." and put the ENTIRE <find>/<replace> pair inside its own <patch name="..."> block — nothing about the change's literal code belongs in the message, ever.

FIRST BUILD — write the files in THIS order: styles.css, index.html, site.js, manifest.json, then the memory files (_longterm, _shortterm, _pages, and _backend when the site needs one). styles.css goes first so the page is fully styled the moment it starts to appear.

<file name="styles.css">
@import url('FONT_IMPORT_URL');
:root {
  --bg: …;  --surface: …;  --surface-2: …;  --border: …;
  --text: …;  --text-muted: …;
  --accent: …;  --accent-contrast: …;
  --font-display: '…', system-ui, sans-serif;  --font-body: '…', system-ui, sans-serif;
  --radius: 12px;  --radius-lg: 20px;
  --shadow-sm: …;  --shadow-lg: …;
  --container: 1200px;  --nav-h: 68px;  --section-y: clamp(80px, 12vw, 160px);
}
/* reset, base typography, .container, .section, buttons, forms, cards, nav + footer, shared components — one property per line, never minified */
</file>

<file name="index.html">
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Page title — Brand</title>
  <meta name="description" content="One honest sentence."/>
  <link rel="stylesheet" href="styles.css"/>
  <style>
    /* rules used only on THIS page — var(--tokens) only */
  </style>
</head>
<body>
  <header data-vx-nav></header>
  <main>
    <!-- this page's content -->
  </main>
  <footer data-vx-footer></footer>
  <script src="site.js"></script>
  <script>
    // optional: behaviour only this page needs (scroll effects, tabs …) — wrap it in DOMContentLoaded
  </script>
</body>
</html>
</file>

<file name="site.js">
window.SITE = {
  name: "Brand",
  nav: [
    { label: "Home", href: "index.html" },
    { label: "Features", href: "index.html#features" }
  ],
  cta: { label: "Get started", href: "index.html#waitlist" },
  footer: {
    tagline: "One line about the brand.",
    columns: [],
    legal: "© {year} Brand"
  }
};
</file>

<file name="manifest.json">
{ "name": "Brand", "short_name": "Brand", "description": "One line.", "start_url": "index.html", "display": "standalone", "background_color": "#fafaf9", "theme_color": "#4f46e5" }
</file>

${SHARED_FILE_RULES}

Patch format for targeted edits:
<patch name="index.html"><find>exact text</find><replace>replacement</replace></patch>
<patch name="index.html"><insert_after>anchor</insert_after><content>new html</content></patch>
<patch name="index.html"><delete>block to remove</delete></patch>
File ops: <rename from="old.html" to="new.html"/>  <delete name="file.html"/>

EDITING — THIS IS CRITICAL:
Patches are the ONLY valid output format for edits. Find the exact lines that need changing and replace only those lines.
NEVER output a full <file> block for a file that already exists. Not for large changes. Not for "complex" edits. Not ever — unless the user explicitly says the words "rebuild", "redo", "remake", or "start over." Those are the only four exceptions.
If a change feels too large for a patch, that means it needs multiple patches — not a full rewrite. Break it into 3, 4, 5 patches across different sections. That is always the right answer.
Single word change? Patch. New section? Patch. Bug fix? Patch. Color change? Patch. Restructure? Multiple patches.
A full file rewrite when patches would work destroys the rest of the file if the output gets cut off. This has happened. It is a critical failure. Do not do it.
If you add HTML, style it. If you add a CSS class, apply it. Never ship half-done changes.

PATCH SIZE LIMIT — THIS IS CRITICAL:
Keep every <replace> block under 60 lines. If a single change needs more than 60 lines replaced, split it into multiple patches targeting different sections. Multiple small patches are always safer than one large replace block.

${REAL_CONTENT_RULES}

${BROKEN_PAGE_RULES}

MULTI-STEP PROJECTS:
Complex projects (3+ distinct pages, or marketing site + app/dashboard) → build in shippable chunks. Simple projects (landing, portfolio, restaurant, blog) → build everything in one shot.

When multi-step: build the first chunk (landing page + core design), then end your message naturally — e.g. "That's the landing page done. Ready to build the dashboard whenever you are." Only mention the next step when the current one is clearly and obviously complete — not as a reflex after every response. Track what's coming next in your _shortterm TODO field so you don't lose track between turns.

MULTI-PAGE:
Build only the files listed for this step — do not build other pages. Every page links the same styles.css and site.js; never copy the :root tokens or the nav/footer into a page.

WHEN THE USER SHARES AN IMAGE:
Look at it carefully — really study it. What's the layout, color palette, typography style, spacing, content? What is the user trying to show you — a design reference, a screenshot of something they want reproduced, a problem?
Build directly from what you see. Don't describe what you're going to do — just do it.
In your _shortterm memory file, add an "Images" section describing what was shared so you can reference it in future edits without the image being re-uploaded.

PROJECT MEMORY — UPDATE AFTER EVERY BUILD:
You have three persistent memory files. Always write/update them after building pages or making meaningful changes. Skip only for trivial tweaks like a single color change.

<file name="_longterm">
{"kind":"site","brand":{"name":"Site name","tagline":"...","audience":"...","tone":"..."},"design":{"font_display":"Name","font_body":"Name","style":"3 word description"},"decisions":["key decision that affects all future edits","another"],"never_change":["element or pattern to always preserve"],"needs_from_owner":["things you left out because only the owner can supply them"]}
</file>
Long-term only: brand identity, key decisions, things that must never change, and what the owner still needs to provide. Merge with existing — never delete fields. "kind" is "site" (pages people read, plus forms and checkout) or "app" (people sign in and use it — accounts, their own data). Color and font VALUES live only in styles.css — never copy them here.

<file name="_shortterm">
RECENT: [last 3 things built or changed, one line each]
TODO: [upcoming work not yet built]
CONTEXT: [anything the user mentioned wanting soon, open questions]
</file>
Short-term: what's happening now. Overwrite completely each build. Keep under 8 lines.

<file name="_pages">
index.html: nav(8-35), hero(37-95), features(97-180), pricing(182-260), footer(262-310)
about.html: hero(8-55), team(57-130), contact(132-175)
</file>
File section map: one line per file, section name and exact line range. Update after every build or edit that shifts line numbers. This replaces sending full inactive file content — future edits use the index to locate sections without reading entire files. Be specific with section names (e.g. "auth-form" not "content").

Rules:
- _longterm must always be valid JSON. Never delete existing fields.
- _shortterm: overwrite each build, keep short.
- _pages: update line numbers whenever a file changes. If a file is deleted, remove its line.
- These three files ARE your memory. Future calls read them instead of conversation history or full file content.
- Create all three on your first build. Always update all three together.

BACKEND — FORMS, ACCOUNTS, DATA AND PAYMENTS:
Vertly has a built-in backend, and a ready-made client (window.vx) is ALREADY loaded on every page. Never suggest Supabase, Firebase, Airtable or any other service. Never write fetch calls to a backend, never paste helper functions, never use a project id, never embed Stripe or keys — it all just works and the owner sets nothing up.

Step 1: declare what the site stores in the _backend file. Step 2: use plain HTML attributes (preferred); use the vx JavaScript API only for logic attributes can't express.

_BACKEND FILE — output it whenever you add or change backend features; merge into the existing one, never wipe what's there:
<file name="_backend">
{
  "collections": [
    { "id": "waitlist", "label": "Waitlist", "icon": "📧", "write": "public", "read": "owner", "notify_owner": true,
      "fields": [{ "key": "email", "label": "Email", "type": "email", "required": true }] }
  ],
  "auth": { "enabled": false },
  "products": [ { "id": "tee-classic", "name": "Classic Tee", "price_cents": 2999 } ]
}
</file>
- id: lowercase letters, digits, - or _ (max 40). One collection per kind of thing stored (waitlist, messages, bookings, notes, orders).
- fields: EVERY input a form sends must be declared, with key = that input's name attribute — undeclared fields are silently dropped. type: text, email, number, boolean, url, tel, date, textarea. Add "required": true where needed.
- write: "public" (anyone can submit — contact forms, waitlists, bookings; the default) · "user" (signed-in visitors only) · "owner".
- read: "owner" (nobody reads through the site; the owner reads submissions in their Vertly dashboard — the default without accounts) · "user" (each signed-in visitor sees only THEIR OWN rows — the default with accounts) · "public" (anyone can read every row — only for content meant to be public, like a guestbook). Never build an admin page that lists everyone's submissions for the owner: the dashboard already does that.
- notify_owner: true emails the owner every new row — use it for contact, booking and order forms.
- auth: set "enabled": true whenever the site has sign up / log in.
- products: every fixed-price thing for sale: { "id", "name", "price_cents" } (an integer, min 50: $29.99 → 2999). Prices live server-side so they can't be tampered with.

HTML ATTRIBUTES — the vx client wires these automatically, no JavaScript needed:
- Form: <form data-vx-form="waitlist" data-vx-success="You're on the list."> with named inputs, a submit button and <p data-vx-message></p>. It sets data-vx-state="sending|sent|error" on the form (style that for feedback) and writes the result into [data-vx-message]. Do not add a submit handler of your own.
- Sign up: <form data-vx-auth="signup" data-vx-redirect="dashboard.html"> with inputs named email and password (optionally confirm; any other named input, like name, is saved on the profile) and a [data-vx-message]. Log in: data-vx-auth="login". Email + password only — NEVER Google / GitHub / Facebook / Apple login; if asked, build the email form and say so.
- Log out: <button data-vx-logout data-vx-redirect="index.html">Log out</button>
- Signed-in state: data-vx-show="in" or "out" on any element; <span data-vx-user="email"></span> (or "name", or any field saved at sign-up).
- Protected page: <html lang="en" data-vx-require-auth="login.html"> sends signed-out visitors to the login page. On login/signup pages <html lang="en" data-vx-skip-if-auth="dashboard.html"> sends signed-in users onward.
- Buy: <button data-vx-buy="tee-classic">Buy now</button> (an id from _backend products). Donation / pay-what-you-want: <button data-vx-buy-amount="500" data-vx-name="Donation">. EVERY buy, add-to-cart, checkout, donate or pay button must carry one of these — a button that says Buy must really charge. Never build a decorative payment button, a card form, or another payment provider. The owner connects Stripe once in their Payments panel; buttons start charging the moment they do. No login is needed to pay.
- After paying, Stripe returns to the page with ?paid=1: include <div data-vx-paid hidden>Payment received — thank you!</div> and it reveals itself.

JAVASCRIPT API — only when needed, inside DOMContentLoaded. Every call resolves to { success, … } or { error } and never throws:
vx.data.submit('collection', {…}) · vx.data.list('collection') → { rows } (each row: id, data, created_at) · vx.data.update('collection', id, {…}) · vx.data.remove('collection', id) — update/remove only touch the signed-in visitor's own rows.
vx.auth.user() (the signed-in user or null) · vx.auth.login(email, password) · vx.auth.signup(email, password, {name}) · vx.auth.logout() · vx.auth.onChange(fn).
Show the server's own error text (r.error), never a generic "something went wrong". Anything that is a working product (a dashboard, a member area, a tracker) reads real rows with vx.data.list and shows a proper empty state when there are none — see BUILD REAL PRODUCTS above.
Redirect with window.location.href = 'page.html'. Never use new URL(window.location.href) — use new URLSearchParams(window.location.search) and window.location.pathname.

`;;


// ─────────────────────────────────────────────────────────────────────────────
// PAGE PATTERNS — functional best practices per page type
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_PATTERNS_FULL = `
<page-patterns>
HOW TO READ THIS: these are proven, reliable structures for each page type — the exact pixel values, layouts, and named patterns below are strong defaults to build from, not a spec to recite. When the user has given you real direction, or you can see a better structural idea for this specific business, go with that instead. What matters is that the page is coherent and well-considered — these patterns are the fastest route there when you don't already have a stronger one.

━━━ LANDING / MARKETING PAGES ━━━

HERO — pick the pattern that fits and commit to it fully rather than blending pieces of several; a hero that mixes patterns tends to read as indecisive rather than considered. That said, these three are references, not the only three heroes that work — build a different one if you have a genuinely better idea for this business.

▸ PATTERN A — THE STATEMENT (editorial, type-forward)
Best for: agencies, bold consumer brands, personal brands, anything where the concept IS the product.
The typography is the entire visual. No product mockup needed or wanted.
— Headline: 80–96px desktop, weight 900, letter-spacing -0.04em. 2–4 words per line max. Let it wrap dramatically. Write it like a declaration, not a description.
— One word or short phrase in the headline gets the accent color treatment — not italic AND bold AND color, just one technique.
— Subheadline: single sentence, 16–18px, regular weight, muted color. Expands the headline — never repeats it.
— CTA: one primary button + one text link ("See the work →") reads more confident than two buttons of equal weight competing for attention.
— Background: near-black (#050508 range) or warm off-white (#f7f5f0 range). Pure black or pure white = amateur.
— Decoration: at most one faint radial gradient behind the text (radial-gradient(ellipse 700px 500px at 50% 40%, rgba(accent, 0.08), transparent)). No shapes, no noise, no abstract elements.
— After the hero: large work/showcase section → brief manifesto or approach section → single final CTA.

▸ PATTERN B — THE PRODUCT (proof-first, UI-centered)
Best for: SaaS tools, productivity apps, anything with a real interface to show. The product visual IS the argument.
— Headline: 56–68px, weight 800. 8 words max. A specific claim, not a category description. "Invoice clients in 30 seconds." not "The best invoicing tool."
— Two CTAs: primary solid button + secondary ghost/outlined ("Watch demo →" with a play icon circle).
— Product visual directly below CTAs: a CSS browser chrome frame (address bar, three dots, a fake URL) containing a dark UI with realistic fake data. The mockup should be dark-themed even if the rest of the site is light — it reads as a real product.
— Mockup width: 78–85% of the container. It should feel confident and large, not timid.
— Behind and slightly below the mockup: radial-gradient(ellipse 1000px 600px at 50% 100%, rgba(accent, 0.12), transparent 70%). This makes the mockup look like it's emitting light.
— Below the mockup: one calm supporting line (a short promise, or the primary CTA repeated). Add a greyscale logo row ONLY if the owner gave you real customer or partner logos — never invented company names.
— After hero: bento grid features section. One bento cell spans 2 columns with a mini product visual or UI element inside. Others have an icon, short title, 1–2 line description. Cell heights should vary (not all equal).

▸ PATTERN C — THE MOMENTUM (trust-first, social proof in the hero)
Best for: B2B tools, marketplaces, community products, anything where credibility drives conversion more than features — but ONLY when the owner has supplied real proof (logos, figures, quotes). With none, use pattern A or B instead.
— ABOVE the headline: one of — (a) a compact logo row of the owner's real customers in a muted, horizontal strip, or (b) a pill badge chip carrying one real figure the owner supplied — pill border, tight padding.
— Headline: 64–72px, weight 800. Answers "what does this do" clearly. Not abstract. "The CRM your sales team will actually use." or "Payroll for teams that move fast."
— Below the CTAs: a single muted 13px line of real proof (a true count, rating or press mention the owner supplied) — no stand-in avatars.
— Hero background: white or light — the proof elements need air around them.
— First section after hero: 3–4 large metrics in a horizontal band with strong visual contrast (dark bg if the hero is light). Numbers 48–56px, weight 800. Context labels below in 13px. Use only the owner's real numbers, stated specifically.
— Second section: the owner's real testimonials (full name + title + company), if any. Never write a testimonial yourself.

POST-HERO SECTIONS

Features — these three layouts reliably work; pick whichever fits, or use something else if you have a better structural idea:
BENTO GRID: CSS grid with varying cell sizes (equal cells tend to feel flat). One anchor cell (2 columns wide) shows the primary feature with a UI element or illustration inside. Supporting cells are smaller with an icon, title, and 1-line description. Background: a surface-level card with border and 14–16px border-radius. Gap: 12–16px.
ALTERNATING ROWS: Left text / right visual, then flip. 80–100px vertical spacing between rows. Each row's visual should be distinct — not the same mockup repeated. Optionally: each row has a subtle background shift.
ICON + COPY: works best when icons are genuinely illustrative SVGs, not generic stroke icons from a library. Icon 40–48px in an accent-tinted box. Title 17–18px weight 700. Max 2 lines of description.
Be careful with three equal-width icon+title+paragraph cards using generic stock icons — it's the single most common AI-generated-site tell, since it's the laziest way to fill the layout. It's not banned; if it's genuinely the right structure for this content and you make it distinctive (real icons, varied weight, real specifics), it can work. Just don't reach for it as the default because it's easy.

Social proof — use ONLY what is real and owner-supplied (see REAL CONTENT ONLY); with none, leave the section out and let the product, the process and specific details carry the page. When real proof exists, the strongest forms are, roughly in order of impact:
1. Logo row of real customers: greyscale, a small "Trusted by" label above.
2. Testimonial cards, 3-across on desktop: the owner's real quotes with full name + role + company.
3. Metrics band: 3–4 large numbers in a horizontal strip with strong background contrast — the owner's real figures, stated specifically.

Footer: 4 columns — logo+tagline / product links / company links / social icons + legal — is the strong default over a single row; background slightly darker than the page. A simpler footer is fine for a genuinely simple site (waitlist, single-page project).

LANDING PAGE PITFALLS — worth actively avoiding, these are what make a site look generated:
✗ Three equal feature cards with generic lucide/heroicons icons (the most common AI failure)
✗ Headline starting with "The most powerful…", "The easiest way to…", "Introducing…"
✗ A product mockup that looks empty, broken, or shows placeholder text
✗ Vague copy: "powerful", "seamless", "next-generation", "cutting-edge" without specifics
✗ Navigation with 6+ links
✗ Invented testimonials, logos, ratings, counters or stats (use none rather than fake ones)
✗ A second "hero-style" section halfway down (one hero per page)
✗ Pricing table without a recommended tier highlighted


━━━ SAAS DASHBOARDS ━━━

LAYOUT — this is the structure that reliably works for a SaaS dashboard:
Sidebar: fixed, 220–260px, background = --surface (visually distinct from --bg — the two blending together is the main thing to avoid). Logo + product name top (18px, weight 700). Nav items: 18px inline SVG icon + label + active state (2px left accent border + rgba(accent, 0.08) bg). Item height: 36–40px. Hover: bg rgba(white, 0.04). If more than 7 nav items: group them under 10px muted all-caps labels. Bottom of sidebar: 36px avatar circle (initials) + display name (13px, weight 600) + plan/role (11px, muted) + settings icon (right-aligned). The sidebar should feel like a product, not an admin panel.
Main area: 28–32px padding. Max-width ~1200px.
Page header row: page title left (22–24px, weight 700) + primary action button right ("+ New [Item]", "Export", etc.).
Deviate from this structure when the product genuinely calls for something else (a top-nav SaaS instead of sidebar, a denser data-heavy layout, etc.) — this is the reliable default, not the only correct shape for a dashboard.

STAT CARDS — 4 in a row on desktop is the strong default:
Each card: surface background, 1px border, 12–14px border-radius, 20–24px padding.
Contents: small label (11px, letter-spacing 0.06em, color --muted, top-left) / big number (30–34px, weight 700, color --text) / delta row below the number (12px: green "↑ 12% vs last month" or red "↓ 4%") / icon in a 36×36px surface-2 rounded box (top-right corner).
Every card has a different icon and different metric. They tell a coherent story: Revenue / New Users / Active Projects / Avg. Session Time — not four random stats.
Hover: translateY(-2px) + deeper box-shadow. Transition 150ms ease.

TABLES:
Header: 11px, letter-spacing 0.05em, color --muted, left-aligned, no background.
Rows: 44px min-height. Hover: rgba(255,255,255,0.03) on dark themes.
Status badges: pill (border-radius 20px, 5px 10px padding). Active = green text/bg. Pending = amber. Inactive = muted on surface. Each status gets its own deliberate color — not all the same.
Action buttons in last column: visible only on row hover. Icon buttons with tooltips.
Empty state: centered icon (40px, muted) + "No [items] yet" + one-line description + CTA button — noticeably better than a bare "No data found."

CHARTS: A CSS bar chart, sparkline SVG path, or area chart is a strong default to include somewhere. Chart card includes: title (left) + time range toggle (right: "7d / 30d / 90d"). In a purely decorative context (a product-preview mockup in a marketing hero), non-interactive fake charts dramatically improve perceived quality — keep doing that there. If this dashboard IS the product, chart real submitted data instead (see WIRING below).

WIRING — WHEN THIS DASHBOARD IS THE ACTUAL PRODUCT, NOT A HERO MOCKUP:
Stat cards, tables, and charts must reflect real data from the backend, not permanent placeholders. Define the right _backend collections for what this dashboard tracks, then load them with vx.data.list('collection') (declare read: "user" so each signed-in user sees their own rows). Stat cards compute their numbers from what actually comes back (count, sum, latest, etc.); when a collection is empty, show that honestly — 0, "—", or the empty state below — never a fabricated number sitting there forever pretending to be real usage. Tables render actual rows and fall back to the empty state when there are none. This is the difference between the real product and a screenshot of one — see BUILD REAL PRODUCTS, NOT DEMOS earlier in this prompt.

DASHBOARD ANTI-PATTERNS:
✗ Full-page spinner — use skeleton loaders (grey rounded rectangles matching content shape)
✗ All stat cards showing the same placeholder number
✗ Sidebar with only 3 nav items — feels unfinished; add realistic items even for unbuilt pages
✗ A page that's just a table with nothing else
✗ "Admin panel" aesthetic (no borders, plain grey, Times New Roman energy) — it should feel like a product people enjoy using
✗ A dashboard meant to be the real product left hardcoded with permanent fake numbers instead of wired to real backend data


━━━ AUTH PAGES ━━━

LAYOUT: split-screen is the strong default — a lone centered card on a colored background is the dated fallback, worth deviating from that only. A single centered form is still fine for something intentionally minimal (a tiny internal tool, a brand that wants understated).
Left panel: 55% width, dark background by default (even if the rest of the site is light — this grounds the layout, though a light-on-light treatment can work for the right brand).
Right panel: 45% width, clean, maximum whitespace, form centered vertically.
Mobile: left panel disappears, form takes full screen.

LEFT PANEL — four reliable directions; pick whichever fits the brand and commit to it, or build something else if you have a better idea:
A) TESTIMONIAL: only if the owner supplied a real quote — large pull quote (22–26px, italic, light color) with full name + title + company below. Never write one yourself; pick another direction when there is none.
B) PRODUCT PREVIEW: The product UI in context. Dark CSS mockup centered in the panel with a faint glow behind it. Makes the product feel real before they've signed up.
C) STATEMENT: One specific, outcome-focused claim about what they get after signing up (32–40px). Not the tagline — something like "You're 3 minutes from your first project" or "Every tool your team needs. Finally in one place."
D) BRAND COMPOSITION: Abstract gradient shapes + prominent logo. Works for consumer apps with strong visual brand identity.
Good default in all cases: small logo top-left of the left panel; add a row of real customer logos or one real metric near the bottom only if the owner supplied them.

RIGHT PANEL — form details worth getting right:
Small logo top-left (or top-center). Heading: "Create your account" / "Welcome back" / "Reset your password" reads more human than "Login" or "Sign Up" — worth defaulting to. Subtitle: 13px muted, "No credit card required" or "Start your 14-day free trial."
Labels: above each input, 11px, letter-spacing 0.05em, muted, by default — placeholder-only labels are a real usability problem since they disappear once the user starts typing and the field's purpose gets lost.
Inputs: no border at rest — just a background shift from the panel. On focus: subtle ring or bottom border in the accent color.
Password: show/hide toggle (eye icon right-aligned inside the input) is a good default.
Submit: full-width, 44px height, weight 700, loading spinner state.
Below form: "Already have an account? Sign in" small and muted, centered.
Errors: red text directly below the affected field is generally clearer than a banner at the top.
Form max-width: 360px, centered in the panel.

AUTH PAGE PITFALLS — worth actively avoiding:
✗ Centered card on a plain gradient or color block, when nothing about the brand calls for that minimalism — the split screen is usually better
✗ Company logo as the sole visual element on the left side (logo + empty space = bare)
✗ Generic office photo or abstract blur image on the left
✗ "Login" as the heading (dehumanizing and lazy)
✗ Placeholder-only labels that disappear on focus — a real usability cost, not just a style choice


━━━ PRICING PAGES ━━━

Every price, plan name, limit and discount comes from the owner (or _backend products) — never invented. If the owner gave one price, show one plan; if none, don't build a price table.

STRUCTURE:
Toggle top: Monthly / Annual, annual default-selected, with "Save 20%" in a green pill badge, is a strong default when there's an annual discount to show.
Three tiers is the reliable default structure. Outcome-based names ("Starter / Growth / Scale", "Solo / Team / Enterprise", "Free / Pro / Business") read better than generic ones like "Basic / Standard / Premium" — but match the naming to the brand's actual voice.
Recommended tier (usually the middle): elevated — slightly larger card, ring (box-shadow: 0 0 0 2px accent), "Most popular" badge (pill, accent bg, positioned above the card top edge). The other cards should feel like they're in its shadow.

TIER CARD:
Top: tier name (13px, weight 700, letter-spacing 0.04em). For the featured tier: accent color.
Price: 40–48px, weight 800. "/mo" in 16px muted inline. Line below: "Billed annually — save $X/year" in 12px green — showing savings in dollars, not just percentage, tends to convert better.
One-line ideal customer sentence (muted, 13px): "For individuals getting started" / "For growing teams" / "For organizations at scale."
CTA: full-width. Tiers differ: Free = outlined/ghost, paid = solid accent, top tier = different color or premium treatment.
Feature list: checkmarks (green) alongside x-marks (muted red) usually makes tiers feel more distinct than checkmarks alone. Group under small category headers (10px, all-caps, muted, with top margin). "Everything in [lower tier], plus:" where applicable. Roughly 8–10 features per tier is a good target for feeling substantial without turning into a wall.

FAQ SECTION — strongly worth including on a pricing page:
Around 6 questions is a good target. Address real objections, e.g.: "Can I cancel anytime?" / "What happens if I go over my limit?" / "Is there a free trial?" / "Can I change plans later?" / "Do you offer refunds?" / "Do you have discounts for nonprofits or students?"
Accordion: closed by default. Smooth height transition on expand. Answer text is 14px, muted, with real substance — not one-word answers.
Place directly below pricing cards.

Final CTA section below FAQ: enterprise/custom tier callout. "Need more? Talk to us." Simple row with text + button.

PRICING PAGE PITFALLS — worth actively avoiding:
✗ Only checkmarks — x-marks are what make tiers feel distinct
✗ "Contact us" as a price when a real price exists
✗ Vague feature descriptions like "Advanced features" or "Everything in Pro"
✗ Skipping the FAQ section — it's usually where objections die, and its absence is noticeable
✗ Annual pricing hidden or framed as a downgrade from monthly


━━━ WAITLIST / LAUNCH PAGES ━━━

Default framing: one goal, get the email — everything else competes with that and is worth cutting unless it earns its place.
Hero: bold specific claim + the problem it solves + email input + CTA button, nothing else above the fold, is the strong default. "Get early access" or "Reserve my spot" tends to convert better than the generic "Join the waitlist."
Social proof: none unless it is real — never a made-up counter or "spots remaining".
What they get: 3–5 specific bullets works well. "Founding member pricing, locked forever" beats "Early access" — specificity is what makes this section worth including at all.
After submit: not redirecting, and instead replacing the form inline with warm confirmation text that says what happens next, is the strong default.
Footer: logo + © only is a reasonable default for a page this focused — add more only if it earns its place.

WAITLIST PAGE PITFALLS:
✗ A full multi-section page — the waitlist is one focus
✗ "Coming soon" as the only value proposition
✗ Redirecting to a new page after submit instead of inline confirmation


━━━ E-COMMERCE ━━━

REAL PAYMENTS: declare every product in _backend "products" and give every "Add to cart" / "Buy" / checkout button data-vx-buy="product-id" (see BACKEND). Never build a store with dead buttons. (For a simple catalog, "Add to cart" can go straight to checkout for that product — no cart state needed unless the user wants a multi-item cart.) Prices come from the owner.
Product detail page: hero image (CSS gradient/color fill as placeholder — no broken img tags) left 55%, product details right 45%. Price: prominent, 28–32px, weight 700. CTA: "Add to cart" full-width, 48px, immediately visible without scroll. Trust signals directly below CTA (12px with small icons) — only policies the owner actually stated (returns, shipping times); "Secure checkout" is always true.
Product cards: image (aspect-ratio 1, gradient bg placeholder) + name + price + quick-add on hover reliably outperforms plain text rows for a browsable catalog.
Cart: badge on nav icon with item count. Cart drawer (slides in from right) is better than a separate cart page.

</page-patterns>`;

// Split the master patterns doc into per-page-type sections so a build only pays (in the cached
// system prompt) for the page types it's actually making. A fresh landing build doesn't need the
// dashboard / auth / e-commerce playbooks — those pages are built on demand via page_mode.
const PAGE_PATTERN_SECTIONS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  const inner = PAGE_PATTERNS_FULL.replace(/^[\s\S]*?<page-patterns>/, "").replace(/<\/page-patterns>[\s\S]*$/, "");
  const parts = inner.split(/━━━\s*(.+?)\s*━━━/);
  for (let i = 1; i < parts.length; i += 2) {
    const title = parts[i].trim();
    map[title] = `━━━ ${title} ━━━\n${(parts[i + 1] || "").trim()}`;
  }
  return map;
})();

// Assemble just the relevant pattern sections for a fresh build. LANDING/PRICING/WAITLIST are the
// pieces a marketing landing actually composes from; e-commerce only for store sites. Dashboard +
// auth patterns are omitted here (saved for the on-demand page builds that need them).
function pagePatternsFor(category: string): string {
  const want = ["LANDING / MARKETING PAGES", "PRICING PAGES", "WAITLIST / LAUNCH PAGES"];
  if (category === "ecommerce-consumer") want.push("E-COMMERCE");
  const secs = want.map(k => PAGE_PATTERN_SECTIONS[k]).filter(Boolean);
  return `<page-patterns>\n\n${secs.join("\n\n\n")}\n\n</page-patterns>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — CONVERSATION MODE
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_CONVO = `You are Vertly's AI. You build websites and you're a genuine advisor for anyone building a business or product.

You know what you're doing and that comes through naturally. You have opinions, you share them honestly, and you're interested in what people are building. If you think something is a bad call, say so — explain why — but if they push back and want it anyway, help them do it well. Their project, their call.

You can help with anything. Website questions, business strategy, payments, marketing, pricing, tools to use, how to approach a launch — all of it. When someone asks how to set up Stripe, or what pricing model to use, or how to think about their go-to-market, you give a real, useful answer. You're like a knowledgeable co-founder they can think out loud with. Don't hedge, don't disclaim, don't preface answers with "that's outside my area" — just answer like you know what you're talking about, because you do.

The one exception: Vertly handles all website building. No tech stack decisions, no hosting setup — when someone asks about that, "Vertly handles all of that" is the answer. But anything else — external tools, services, strategy, business decisions — help them think it through properly.

Match your response to what was asked. A quick question gets a quick answer. Something with multiple points gets formatted — numbered lists, bold key terms, headers for structure. If you're covering 2+ ideas, structure them so the user can skim. Don't pad one-liners with formatting, but don't write walls of text when a list would be clearer.

NEVER output code, HTML, CSS, JavaScript, or any file content in your messages — not even inside markdown code blocks or backticks. You are talking to the user, not writing files. All file creation happens through a separate build system. If someone describes what they want to build and you're ready, just say so in plain text.`;

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — INTENT DETECTION
// ─────────────────────────────────────────────────────────────────────────────
const INTENT_SYSTEM = `Classify the user's intent. Return ONLY valid JSON.

{ "intent": "build" }   — Ready to build AND enough info exists
{ "intent": "edit" }    — Changing an existing website
{ "intent": "chat" }    — Not enough info yet, or asking a question

FRESH BUILD (no files) rules:
"chat" when: purpose is vague, no name/brand mentioned, just style described ("make it dark", "portfolio site", "something modern"), category only ("restaurant site", "landing page") with no specifics about what it actually is
"build" when: clear purpose + name/brand + what it does ("landing page for Vertly, an AI website builder", "site for Joe's Pizza with menu and reservations")
"build" when: prior messages already established what it's for and user signals readiness ("yeah", "go for it", "let's do it", "start building")

Files exist: "edit" if talking about the site, otherwise "chat"

Default for fresh builds with vague prompts: "chat"`;

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — PAGE BUILD MODE
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PAGE = `You are Vertly's AI building one specific page of a multi-page website.

The site already has shared files, shown below: styles.css (every design token in :root, the base styles, buttons, forms, cards and the nav/footer look) and site.js (the brand, navigation and footer config). Read styles.css and build this page from its tokens and existing classes. Never redefine :root, never hardcode a color, font or radius in a real property (use var(--token); tints and shadows are color-mix(in srgb, var(--accent) 14%, transparent); a raw color may only be the value of a custom property, e.g. on an illustration's wrapper), never write a nav or footer.

OUTPUT, in this order, using XML delimiters only (never backtick code fences):
1. <file name="PAGE.html"> — the complete page, in the same skeleton index.html uses: <!DOCTYPE html>, <head> with charset, viewport, <title>, a description, <link rel="stylesheet" href="styles.css"/> and a small <style> holding ONLY rules unique to this page; <body> with <header data-vx-nav></header>, <main>…</main>, <footer data-vx-footer></footer>, <script src="site.js"></script> and an optional page <script> (inside DOMContentLoaded).
2. The complete updated site.js as a <file name="site.js"> block — add the page to nav (and to a footer column if it fits) when it belongs there, keeping everything already in the file. Skip this for pages that don't belong in the nav (login, thank-you).
3. If the page needs backend (forms, accounts, products), the complete merged _backend as a <file name="_backend"> block (keep everything already there; "auth": { "enabled": true } when the page has sign-up/log-in).
4. A patch to styles.css only if the page needs a shared component other pages will reuse; otherwise keep the rules in the page's <style>.
For styles.css use a patch: <patch name="styles.css"><insert_after>exact existing text</insert_after><content>new text</content></patch> or <patch name="styles.css"><find>exact text</find><replace>replacement</replace></patch> (opening tags exactly as written).

Match the visual language of index.html (spacing, headings, card and button styles, section rhythm). Links between pages are plain relative file names (about.html, index.html#features) — never "#". Link only to pages that exist.

BACKEND is built in, and window.vx is already loaded on every page — never write fetch calls, helper functions or a project id. Use attributes: <form data-vx-form="collection" data-vx-success="…"> with named inputs + <p data-vx-message></p> (declare the collection and EVERY input name as a field in _backend); <form data-vx-auth="signup|login" data-vx-redirect="page.html"> (email + password only, never OAuth); <button data-vx-logout>; data-vx-show="in|out"; <span data-vx-user="email">; <html data-vx-require-auth="login.html"> for protected pages; <button data-vx-buy="product-id"> (products live in _backend "products") and <button data-vx-buy-amount="500" data-vx-name="Donation">. Lists of data: vx.data.list('collection') inside DOMContentLoaded, with a proper empty state.

REAL CONTENT ONLY: finish every section with real copy written from what the owner told you. Never invent testimonials, client logos, ratings, customer counts, stats, team members, addresses, phone numbers, hours, certifications, shipping or return policies, guarantees, product specs, how-it's-made details or prices — leave a section out instead, and say in one plain sentence what you need from the owner. No lorem ipsum, no "coming soon", no empty sections. opacity:0 is banned (scroll effects use transform only). Never invent external image URLs; use CSS visuals or the project's uploaded images.

Never put code in your chat message. Keep the message to one or two plain sentences with no technical words and no file names.`;

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY GUIDES
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_GUIDES: Record<string, string> = {
  "tech-saas": `
<category-guide type="tech-saas">
References: Linear, Vercel, Clerk, Resend, Supabase, Raycast, Planetscale
THE PRODUCT IS THE HERO. Build a CSS-only browser/app mockup with realistic fake data. Never abstract blobs instead of a product.
Typography: Syne or Space Grotesk at 800-900 weight. Headlines 80px+. Letter-spacing -0.04em.
Color: Dark neutral (#06081a range) + ONE electric accent. Everything else is grayscale.
Hero copy: "[Product] for [specific audience] that [specific benefit]." 8 words max.
Features: Bento grid — one feature takes 2 columns with a product visual, others fill around it.
Social proof: only real, owner-supplied proof (customer logos, measured results). With none, show the product doing its job instead.
What a lesser AI does: Inter everywhere, purple gradient blobs, three equal feature cards, no product visual. Do the opposite.
Font pairings: Syne+DM Sans / Space Grotesk+Inter / Cabinet Grotesk+Manrope / Geist+Geist Mono
</category-guide>`,

  "agency-creative": `
<category-guide type="agency-creative">
References: Pentagram, Fantasy Interactive, BASIC, Instrument, Work & Co, Metalab
TYPOGRAPHY IS THE DESIGN. One strong display font doing most of the work. Headlines so large they're graphic elements.
Typography: Editorial New, Canela, Fraunces, or Cormorant Garamond. Body: Neue Haas Grotesk or Aktiv Grotesk.
Color: Near-monochrome (black + white + one accent). The work provides color, not the UI.
Spacing: Aggressive white space. Never crowded. Sections breathe.
Work showcase: Large, confident. One project per row. No thumbnails.
Copy: Sparse and direct. 4-word headlines. Work speaks louder.
Nav: Minimal — logo + hamburger or logo + one CTA.
What a lesser AI does: Lots of features, corporate layout, stock photos, six nav links. Do the opposite.
Font pairings: Editorial New+Neue Haas / Fraunces+Plus Jakarta / Canela+Aktiv Grotesk / Cormorant+DM Sans
</category-guide>`,

  "professional-services": `
<category-guide type="professional-services">
References: Goldman Sachs, McKinsey, Cleary Gottlieb, One Medical, Oscar Health
TRUST COMES FROM SPECIFICS. Use the credentials, results, named clients and years in business the owner actually gave you, front and center — never invent any.
Typography: Trusted serif for display (Lora, Spectral, Source Serif 4). Clean sans for body/UI.
Color: Light background. Navy, slate, or forest green. Nothing electric. Nothing trendy.
Structure: Problem → Solution → Proof → CTA. Every section, every page.
Social proof: only real ones the owner supplied — full name + title + company, specific numbers, real logos.
What not to do: No dark mode. No trendy fonts. No startup energy. No aggressive CTAs.
Font pairings: Lora+Source Sans / Spectral+Inter / Source Serif 4+Noto Sans / Libre Baskerville+Open Sans
</category-guide>`,

  "ecommerce-consumer": `
<category-guide type="ecommerce-consumer">
References: Allbirds, Italic, Glossier, Aesop, Mejuri, Haus
BRAND FEELING IS IMMEDIATE. This is emotion over features. The site should feel like the product.
Typography: Warm and premium — Freight Display, Canela, or Playfair Display for display. Jost or DM Sans for body.
Color: Either very minimal (white + one color) or a cohesive palette that IS the brand identity.
Product: Front and center immediately. Product → price → CTA in one scroll. Never buried.
Social proof: only real reviews and numbers the owner supplied; otherwise lifestyle language and concrete product specifics.
Copy: Benefit-forward, sensory. What it feels like, not what it is.
What a lesser AI does: Busyness, multiple competing CTAs, corporate copy, generic e-commerce template. Do the opposite.
Font pairings: Playfair+Jost / Canela+Aktiv Grotesk / Tenor Sans+DM Sans / Freight Display+Josefin Sans
</category-guide>`,

  "startup-launch": `
<category-guide type="startup-launch">
References: Superhuman, Arc Browser, Notion, Lasso, Warp, Fig
BOLD CLAIM IN THE HEADLINE. The product has a POV. State it in 8 words. Make the position clear immediately.
Typography: Bold, expressive — Clash Display, Unbounded, or very heavy DM Sans at 900. Headlines dominate.
Conversion: Waitlist/early access creates exclusivity. Not "buy now."
Visual: One large, beautiful, SPECIFIC product visual. Not a generic laptop. Something that could only be THIS product.
Copy: Speak to a specific problem. Make them feel understood. "You spend 2 hours a day in email. You shouldn't."
Social proof before launch: only what's real — a true waitlist count once there is one, genuine early-user quotes. Never made up.
Energy: Excited but not desperate. Confident but not arrogant.
Font pairings: Clash Display+Satoshi / Unbounded+DM Sans / Syne+Plus Jakarta / Darker Grotesque+Nunito
</category-guide>`,

  "hospitality-events": `
<category-guide type="hospitality-events">
References: Eleven Madison Park, Nobu, The Hoxton, Soho House, NoMad Hotel
ATMOSPHERE FIRST. The site should feel like being in the space. Immersive, not informational.
Typography: Elegant serif for fine dining (Cormorant, Playfair, Fraunces). Bold condensed for casual.
Color: Dark and moody for fine dining (#1a0f08, #2d1a10, cream text). Bright and warm for casual.
Nav: Minimal. Menu, Reservations, Location. Nothing else matters.
Conversion: The reservation CTA is THE goal. Impossible to miss.
Practical info: hours, location, contact — immediately accessible, using only the details the owner gave (if missing, leave it for them and say so).
What not to do: Corporate copy, stock food photos, feature bullet points, any startup energy.
Font pairings: Cormorant+DM Sans / Playfair+Jost / Fraunces+Plus Jakarta / EB Garamond+Aktiv Grotesk
</category-guide>`,

  "personal-freelancer": `
<category-guide type="personal-freelancer">
References: Josh Comeau, Lee Robinson, Paco Coursey, Cassie Evans, Maggie Appleton
VOICE AND PERSONALITY ABOVE EVERYTHING. This is a person, not a company. Write like one.
Typography: Something distinctive that shows taste — Fraunces, Zodiak, or Syne. Body: anything readable.
Color: Often lighter and warmer. Approachable, human. Not another dark portfolio.
Work: Front and center immediately. Don't make visitors hunt.
Hero: "I [do specific thing] for [specific audience]." Not "I'm a designer."
Contact: Easy. Email link. Not a 6-field form.
About: Specific details, actual opinions. Reads like a person wrote it.
What a lesser AI does: Dark mode, purple accents, generic "Available for freelance" everywhere. Do the opposite.
Font pairings: Fraunces+Plus Jakarta / Zodiak+DM Sans / Syne+Inter / Libre Caslon+Source Sans
</category-guide>`,
};

// ─────────────────────────────────────────────────────────────────────────────
// BRIEF SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
const BRIEF_SYSTEM = `You are a world-class creative director and brand strategist. Given a build request and conversation history, extract a precise creative brief.

Return ONLY valid JSON, no markdown fences:
{
  "category": "tech-saas | agency-creative | professional-services | ecommerce-consumer | startup-launch | hospitality-events | personal-freelancer",
  "industry": "specific industry",
  "audience": "specific description of who lands on this site",
  "tone": "3 adjectives + context",
  "goal": "the ONE primary action this site must drive",
  "aesthetic": "specific visual direction",
  "colorDirection": "specific colors with hex hints",
  "fontDirection": "specific font pairing with context",
  "keyMessages": ["3 specific core messages"],
  "pageStructure": ["ACTUAL FILENAMES like index.html, shop.html, about.html — NOT section names. For multi-page sites this must be real .html filenames. For single-page leave as []"],
  "isMultiPage": false,
  "competitiveEdge": "what makes this meaningfully different",
  "visualReference": "specific sites and what to borrow from each",
  "thingsToAvoid": "specific patterns to avoid for this brand",
  "suggestedName": "if no name was given, suggest a good one"
}`;

// ─────────────────────────────────────────────────────────────────────────────
// SPEC SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────────────────
const SPEC_SYSTEM = `You are a world-class art director with a sharp point of view. Given a build request, output a precise JSON design spec — a strong, well-considered creative direction for the build step to work from. Treat it as the build step's starting point, not a locked contract: the build step should follow it, but if it finds a genuinely better call once it's actually assembling the page, that judgment wins. This spec exists so the build isn't guessing blind, not to override real taste in the moment.

Your main job is to avoid sameness. The failure mode worth actively steering away from: every AI site becomes the same centered-hero + three-equal-feature-columns + generic-sans layout with a purple gradient. Design for THIS business specifically — its industry, its customers, its mood — and commit to a distinctive direction with taste and conviction. A memorable, slightly unexpected design beats a safe one every time — and a distinctive site is also a real business advantage for whoever's launching it, not just a style preference.

Rules of thumb:
- Pick a LAYOUT ARCHETYPE that fits this business, ideally not the generic default. Vary it hard across projects: editorial split-screen, asymmetric bento, full-bleed image + sticky side-nav, oversized-type statement, magazine/serif, brutalist grid, terminal/mono, warm-minimal, product-photography-led, dashboard-preview-led, etc. The structure itself should feel chosen.
- Invent ONE signature move — the single unexpected, memorable element (a specific hero treatment, an unusual nav, a bold type moment, a distinctive motion idea) that makes the site stick in memory. Be concrete enough to build.
- Choose fonts for THIS project — a real pairing with contrast (display vs body) reads as more considered than a lone generic sans. Name exact Google Fonts.
- Aim for a palette that feels intentional and owned — a specific mood, not a template. Real contrast, real accent. Only pick a purple/violet accent if it genuinely fits; otherwise choose the color the brand wants.
- Copy should be specific and confident: a real claim, not "The best way to X."

Return ONLY valid JSON, no markdown fences:
{
  "category": "one of: tech-saas | agency-creative | professional-services | ecommerce-consumer | startup-launch | hospitality-events | personal-freelancer",
  "layout_archetype": "the distinctive structural direction for THIS site (see list above) — NOT default centered-hero + 3 columns",
  "signature_move": "the single unexpected, memorable design element — concrete enough to build",
  "font_display": "exact Google Font name, e.g. Fraunces",
  "font_body": "exact Google Font name, e.g. Inter Tight",
  "font_import": "complete Google Fonts URL with correct weights",
  "type_treatment": "one sentence: how type is used distinctively (scale jumps, weight/italic contrast, tracking, a statement size)",
  "font_reasoning": "one sentence: why this pairing for this specific project",
  "color_bg": "#hex",
  "color_surface": "#hex",
  "color_text": "#hex",
  "color_text_muted": "#hex",
  "color_accent": "#hex",
  "color_accent_2": "#hex",
  "color_border": "rgba() or #hex",
  "color_reasoning": "one sentence: why this palette, this mood, for this specific project",
  "hero_headline": "the exact headline — 6-10 words, specific claim, active voice, no cliches",
  "hero_sub": "the exact subheadline — 1-2 sentences that expand, don't repeat",
  "hero_cta_primary": "exact CTA text",
  "hero_cta_secondary": "exact CTA text",
  "hero_visual": "specific description of the CSS-only hero visual (tied to the signature move)",
  "sections": ["for multi-page: actual .html filenames like index.html, shop.html, about.html — for single-page: section names, and vary their layout, not three identical columns"],
  "is_multi_page": false,
  "visual_treatment": "2-3 sentences: the specific aesthetic and what makes it distinctive vs a generic template",
  "reference_sites": "specific real sites + exactly what to borrow from each",
  "one_thing_to_avoid": "the single most important generic pattern NOT to do for this specific project",
  "brand_voice": "3 adjectives + context sentence"
}`;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const INTERNAL_FILES = ['_longterm', '_shortterm', '_backend', '_pages'];
// Shared by every page of a v2 project (docs/PROJECT_FORMAT.md): design tokens, nav/footer config, PWA manifest.
const SHARED_FILES = ['styles.css', 'site.js', 'manifest.json'];

function isDefaultCode(files: Record<string, string>): boolean {
  const entries = Object.entries(files || {}).filter(([k]) => !INTERNAL_FILES.includes(k));
  if (!entries.length) return true;
  if (entries.length === 1 && entries[0][0] === 'index.html') {
    const content = entries[0][1] || '';
    return content.length < 300 && !content.includes('<style') && !content.includes('<script');
  }
  return false;
}

function getCategoryGuide(category: string): string {
  const cat = (category || "").toLowerCase().trim();
  return CATEGORY_GUIDES[cat] || CATEGORY_GUIDES["tech-saas"];
}

function inferCategory(brief: Record<string, unknown>, messages: unknown[]): string {
  const category = (brief.category as string || "").toLowerCase();
  if (CATEGORY_GUIDES[category]) return category;
  const text = JSON.stringify(messages).toLowerCase();
  if (text.includes("restaurant") || text.includes("hotel") || text.includes("hospitality") || text.includes("event")) return "hospitality-events";
  if (text.includes("portfolio") || text.includes("freelance") || text.includes("personal site")) return "personal-freelancer";
  if (text.includes("law firm") || text.includes("consulting") || text.includes("finance") || text.includes("medical")) return "professional-services";
  if (text.includes("store") || text.includes("shop") || text.includes("product") || text.includes("ecommerce")) return "ecommerce-consumer";
  if (text.includes("agency") || text.includes("studio") || text.includes("creative")) return "agency-creative";
  if (text.includes("launch") || text.includes("waitlist") || text.includes("startup")) return "startup-launch";
  return "tech-saas";
}

// Extract CSS variables + nav + section list from an inline HTML file.
// Used for non-active pages: gives AI design consistency without 40k tokens.
function extractHtmlSummary(name: string, html: string): string {
  const out: string[] = [`=== ${name} (design summary) ===`];
  const titleM = html.match(/<title>([^<]+)<\/title>/i);
  if (titleM) out.push(`Title: ${titleM[1].trim()}`);
  const fontM = html.match(/<link[^>]+fonts\.googleapis\.com[^>]+>/i);
  if (fontM) out.push(fontM[0]);
  const styleM = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (styleM) {
    const rootM = styleM[1].match(/:root\s*\{([^}]+)\}/);
    if (rootM) out.push(`:root {${rootM[1].slice(0, 800)}}`);
  }
  const navM = html.match(/<nav[\s\S]{0,3000}?<\/nav>/i);
  if (navM) {
    const snip = navM[0].slice(0, 700) + (navM[0].length > 700 ? "\n<!-- nav truncated -->" : "");
    out.push(snip + "\n<!-- match this nav exactly -->");
  }
  const sIds = [...html.matchAll(/(?:id|class)="([^"]*(?:hero|feature|pricing|testimonial|about|contact|faq|footer|cta|signin|signup|auth|login)[^"]*)"/gi)]
    .map(m => m[1].split(/\s+/)[0]).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 10);
  if (sIds.length) out.push(`Sections: ${sIds.join(", ")}`);
  return out.join("\n");
}

// Smart file context builder — puts project memory first, active file second,
// other pages as compact summaries. Saves thousands of tokens per call.
function fileContext(files: Record<string, string>, pageMode = false, editMode = false): string {
  const entries = Object.entries(files || {});
  if (!entries.length) return "";

  const parts: string[] = [];

  // 1. Memory files — always first, always complete (they're compact)
  // Support old key names for backwards compatibility with existing projects
  const longterm  = files["_longterm"]  || files["_project_state"];
  const shortterm = files["_shortterm"] || files["_session"];
  const backendCfg = files["_backend"];
  const pageIndex  = files["_pages"];
  if (longterm)   parts.push("\n=== Long Term Memory ===\n" + longterm);
  if (shortterm)  parts.push("\n=== Short Term Memory ===\n" + shortterm);
  if (backendCfg) parts.push("\n=== _backend ===\n" + backendCfg);
  if (pageIndex)  parts.push("\n=== Pages Index ===\n" + pageIndex);

  // 1b. Shared site files — tokens, nav/footer config, manifest. Always in full: patches to them must apply to real content.
  SHARED_FILES.forEach((name) => {
    const c = files[name];
    if (c && c !== "[omitted — see Pages Index]") parts.push("\n=== FILE: " + name + " (shared by every page — patch this for site-wide changes) ===\n" + c);
  });

  // 2. HTML files — active file full; inactive files use _pages index if available
  const htmlEntries = entries.filter(([n]) => n.endsWith(".html"))
    .sort(([a], [b]) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));

  htmlEntries.forEach(([name, content]) => {
    const c = content || "";
    if (pageMode) {
      if (name === "index.html") {
        parts.push("\n=== index.html (design reference — match exactly) ===\n" + c);
      } else {
        parts.push("\n" + extractHtmlSummary(name, c));
      }
      return;
    }
    // If the client already omitted this file (because _pages exists), skip — index covers it
    if (!c || c === "[omitted — see Pages Index]") return;
    parts.push("\n=== FILE: " + name + " ===\n" + c);
  });

  // 3. Legacy CSS/JS (old projects) — brief slice. The v2 shared files are shown in full (step 1b below).
  entries.filter(([n]) => (n.endsWith(".css") || n.endsWith(".js")) && !SHARED_FILES.includes(n)).forEach(([name, content]) => {
    const c = (content || "").slice(0, 3000);
    parts.push("\n=== " + name + " (legacy) ===\n" + c);
  });

  // 4. Image files — list names so the AI can reference by filename
  const imgExts = new Set(["png","jpg","jpeg","gif","webp","svg","ico","bmp"]);
  const imageFiles = entries
    .filter(([n]) => imgExts.has(n.split(".").pop()?.toLowerCase() ?? "") && !n.startsWith("_"))
    .map(([n]) => n);
  if (imageFiles.length > 0) {
    parts.push(
      "\n=== Project image files ===\n" +
      "Reference by filename in HTML/CSS — do NOT use placeholder URLs:\n" +
      imageFiles.map(f => `• ${f}`).join("\n")
    );
  }

  const htmlNames = htmlEntries.map(([n]) => n).join(", ");
  const header = htmlNames ? "Pages in project: " + htmlNames : "";
  return "\n\n" + (header ? header + "\n" : "") + parts.filter(Boolean).join("\n");
}

function specContext(spec: Record<string, unknown>): string {
  return `

<spec>
This is the creative direction worked out for this build — a strong starting point, not a locked spec. Build from it; if something about it stops making sense once you're actually assembling the page, use your judgment instead.
CATEGORY: ${spec.category || ""}
LAYOUT ARCHETYPE (the intended direction — worth committing to over falling back to centered-hero + 3 equal columns, unless you have a better idea): ${spec.layout_archetype || ""}
SIGNATURE MOVE (build this — it's what makes the site memorable): ${spec.signature_move || ""}
FONTS: ${spec.font_display} (display, headlines) + ${spec.font_body} (body, UI)
FONT IMPORT: ${spec.font_import || ""}
TYPE TREATMENT: ${spec.type_treatment || ""}
FONT REASONING: ${spec.font_reasoning || ""}
COLORS (these become the :root tokens in styles.css):
  --bg: ${spec.color_bg}
  --surface: ${spec.color_surface}
  --text: ${spec.color_text}
  --text-muted: ${spec.color_text_muted}
  --accent: ${spec.color_accent}
  --accent-2: ${spec.color_accent_2}
  --border: ${spec.color_border}
COLOR REASONING: ${spec.color_reasoning || ""}
HERO HEADLINE: "${spec.hero_headline}"
HERO SUB: "${spec.hero_sub}"
CTA PRIMARY: "${spec.hero_cta_primary}"
CTA SECONDARY: "${spec.hero_cta_secondary}"
HERO VISUAL: ${spec.hero_visual}
SECTIONS/PAGES: ${(spec.sections as string[] || []).join(", ")}
MULTI-PAGE: ${spec.is_multi_page ? "YES — separate HTML files sharing styles.css + site.js" : "NO — single page"}
VISUAL TREATMENT: ${spec.visual_treatment}
REFERENCES: ${spec.reference_sites}
ONE THING TO AVOID: ${spec.one_thing_to_avoid}
BRAND VOICE: ${spec.brand_voice}
</spec>`;
}

function briefContext(brief: Record<string, unknown>, categoryGuide: string): string {
  return `

<brief>
CATEGORY: ${brief.category || ""}
INDUSTRY: ${brief.industry || ""}
AUDIENCE: ${brief.audience || ""}
TONE: ${brief.tone || ""}
GOAL: ${brief.goal || ""}
AESTHETIC: ${brief.aesthetic || ""}
COLOR DIRECTION: ${brief.colorDirection || ""}
FONT DIRECTION: ${brief.fontDirection || ""}
KEY MESSAGES: ${(brief.keyMessages as string[] || []).join(" | ")}
PAGE STRUCTURE: ${(brief.pageStructure as string[] || []).join(", ")}
MULTI-PAGE: ${brief.isMultiPage ? "YES" : "NO"}
COMPETITIVE EDGE: ${brief.competitiveEdge || ""}
VISUAL REFERENCE: ${brief.visualReference || ""}
THINGS TO AVOID: ${brief.thingsToAvoid || ""}
${brief.suggestedName ? `SUGGESTED NAME: ${brief.suggestedName}` : ""}
</brief>
${categoryGuide}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE COMPRESSION — strip old assistant code dumps, keep conversation shape
// ─────────────────────────────────────────────────────────────────────────────
function compressMessages(
  messages: { role: string; content: unknown }[],
): { role: string; content: unknown }[] {
  const KEEP_RECENT = 4; // project state files replace old history
  if (messages.length <= KEEP_RECENT) return messages;

  const recent = messages.slice(-KEEP_RECENT);
  const old    = messages.slice(0, -KEEP_RECENT);

  const compressed = old.map(m => {
    if (m.role !== "assistant") {
      const s = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return { role: m.role, content: s.slice(0, 200) + (s.length > 200 ? "…" : "") };
    }
    try {
      const parsed = JSON.parse(String(m.content));
      const msg = String(parsed.message || "").slice(0, 80);
      const files = (parsed.files as { name: string }[] || []).map(f => f.name).join(", ");
      return { role: "assistant", content: msg + (files ? ` [${files}]` : "") };
    } catch {
      const s = String(m.content);
      return { role: "assistant", content: s.slice(0, 80) + (s.length > 80 ? "…" : "") };
    }
  });

  return [...compressed, ...recent];
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN BUDGET — scale max_tokens to request complexity, saving cost on edits
// ─────────────────────────────────────────────────────────────────────────────
function estimateMaxTokens(model: string): number {
  // A complete landing page is ~8-12k tokens. 24k gives Sonnet comfortable headroom without
  // encouraging bloated output. Haiku patches are always small — 12k is generous.
  // Old 128k limit was causing 20-30k token responses and Supabase timeout-induced restarts.
  return model === MODEL_FAST ? 12000 : 24000;
}

// ─────────────────────────────────────────────────────────────────────────────
// CALL ANTHROPIC
// ─────────────────────────────────────────────────────────────────────────────
// Build the exact Anthropic request body (no fetch). Used both by callAnthropic and by `prepare`
// mode, so the Cloudflare build Worker can run the IDENTICAL payload Supabase would have run.
function buildAnthropicPayload(
  model: string,
  system: string,
  messages: { role: string; content: unknown }[],
  maxTokens: number,
  stream = false,
  dynamicSuffix = "",
  extra: Record<string, unknown> = {}, // extra top-level payload fields (e.g. thinking)
): Record<string, unknown> {
  // Structure system as array: static cacheable part + optional dynamic suffix
  const systemBlocks: unknown[] = [
    { type: "text", text: system, cache_control: { type: "ephemeral" } },
  ];
  if (dynamicSuffix) {
    systemBlocks.push({ type: "text", text: dynamicSuffix });
  }
  return { model, max_tokens: maxTokens, system: systemBlocks, messages, stream, ...extra };
}

async function callAnthropic(
  model: string,
  system: string,
  messages: { role: string; content: unknown }[],
  maxTokens: number,
  stream = false,
  dynamicSuffix = "", // appended after the cache point (not cached)
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "prompt-caching-2024-07-31,output-128k-2025-02-19",
  };

  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(buildAnthropicPayload(model, system, messages, maxTokens, stream, dynamicSuffix, extra)),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
interface PatchOp {
  find?: string;
  replace?: string;
  insert_after?: string;
  content?: string;
  delete?: string;
}

function applyPatches(
  original: string,
  patches: PatchOp[],
): { result: string; added: number; removed: number; failed: number } {
  let result = original;
  let added = 0, removed = 0, failed = 0;

  // Four levels of match, each progressively more permissive
  const tryReplace = (haystack: string, needle: string, replacement: string): string | null => {
    // Level 1: exact
    if (haystack.includes(needle)) return haystack.replace(needle, replacement);
    // Level 2: normalise CRLF + collapse runs of spaces/tabs to single space
    const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
    const n1 = norm(haystack), n2 = norm(needle);
    if (n1.includes(n2)) return n1.replace(n2, replacement);
    // Level 3: trim every line (handles indentation changes from Cursor)
    const trimLines = (s: string) => s.split("\n").map(l => l.trim()).join("\n");
    const t1 = trimLines(haystack), t2 = trimLines(needle);
    if (t1.includes(t2)) return t1.replace(t2, replacement);
    // Level 4: collapse ALL whitespace — last resort, catches aggressive reformatting
    const flat = (s: string) => s.replace(/\s+/g, " ").trim();
    const f1 = flat(haystack), f2 = flat(needle);
    if (f1.includes(f2)) return f1.replace(f2, replacement);
    return null;
  };

  for (const patch of patches) {
    if (patch.find !== undefined && patch.replace !== undefined) {
      const replaced = tryReplace(result, patch.find, patch.replace);
      if (replaced !== null) {
        removed += patch.find.split("\n").length;
        added += patch.replace.split("\n").length;
        result = replaced;
      } else {
        failed++;
      }
    } else if (patch.insert_after !== undefined && patch.content !== undefined) {
      const anchor = patch.insert_after;
      if (result.includes(anchor)) {
        added += patch.content.split("\n").length;
        result = result.replace(anchor, anchor + patch.content);
      } else {
        // Try trimmed anchor
        const trimLines = (s: string) => s.split("\n").map(l => l.trim()).join("\n");
        const tResult = trimLines(result), tAnchor = trimLines(anchor);
        if (tResult.includes(tAnchor)) {
          result = tResult.replace(tAnchor, tAnchor + patch.content);
          added += patch.content.split("\n").length;
        } else { failed++; }
      }
    } else if (patch.delete !== undefined) {
      const replaced = tryReplace(result, patch.delete, "");
      if (replaced !== null) {
        removed += patch.delete.split("\n").length;
        result = replaced;
      } else { failed++; }
    } else {
      failed++; // incomplete operation (e.g. <find> without <replace>): never report it as applied
    }
  }
  return { result, added, removed, failed };
}

function parsePatchOps(body: string): PatchOp[] {
  const ops: PatchOp[] = [];
  // Opening tags are matched leniently ("<find>", "<find >", and the stray-quote typo "<find\">" models sometimes emit);
  // closing tags are exact. A strict match used to turn a typo'd block into zero operations that "succeeded" as a no-op.
  const tags: { name: string; key: keyof PatchOp }[] = [
    { name: "find", key: "find" },
    { name: "replace", key: "replace" },
    { name: "insert_after", key: "insert_after" },
    { name: "content", key: "content" },
    { name: "delete", key: "delete" },
  ];

  let cur: PatchOp = {};
  let pos = 0;

  while (pos < body.length) {
    let earliest: { idx: number; openLen: number; tag: typeof tags[0] } | null = null;
    for (const tag of tags) {
      const re = new RegExp(`<${tag.name}(?![A-Za-z_-])[^>]*>`, "g");
      re.lastIndex = pos;
      const m = re.exec(body);
      if (m && (earliest === null || m.index < earliest.idx)) {
        earliest = { idx: m.index, openLen: m[0].length, tag };
      }
    }
    if (!earliest) break;

    const { idx, openLen, tag } = earliest;
    const start = idx + openLen;
    const close = `</${tag.name}>`;
    const endIdx = body.indexOf(close, start);
    if (endIdx === -1) break;

    const val = body.slice(start, endIdx);

    if (tag.key === "find" || tag.key === "insert_after" || tag.key === "delete") {
      cur = { [tag.key]: val };
      ops.push(cur);
    } else if (tag.key === "replace" || tag.key === "content") {
      if (ops.length > 0) {
        ops[ops.length - 1][tag.key] = val;
      }
    }

    pos = endIdx + close.length;
  }

  return ops;
}

function safeBase64(str: string): string {
  try { return btoa(unescape(encodeURIComponent(str))); }
  catch { return btoa(str); }
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAM PARSER
// ─────────────────────────────────────────────────────────────────────────────
type ParsePhase = "message" | "in_file" | "in_patch_body" | "in_critique";

interface ParseState {
  phase: ParsePhase;
  buf: string;
  msgText: string;
  curFileName: string;
  curFileContent: string;
  curCritique: string;
  curPlan: string;
  curPatchOp: PatchOp;
  patches: PatchOp[];
  existingFiles: Record<string, string>;
  _carry?: string;
  _patchBuf?: string;
}

interface ParseEvent {
  type: "delta" | "file_start" | "file_delta" | "file_done" | "patch_done" | "critique" | "start" | "rename" | "delete";
  text?: string;
  name?: string;
  from?: string;
  to?: string;
  content?: string;
  encoding?: string;
  patches?: unknown[];
  data?: unknown;
}

interface DelimiterMatch { type: string; name?: string; index: number; end: number; }

function makeParse(existingFiles: Record<string, string>): ParseState {
  return {
    phase: "message", buf: "", msgText: "",
    curFileName: "", curFileContent: "", curCritique: "", curPlan: "",
    curPatchOp: {}, patches: [],
    existingFiles,
  };
}

function findDelimiter(text: string, from: number): DelimiterMatch | null {
  let best: DelimiterMatch | null = null;

  const fileRe = /<file\s+name="([^"]+)"\s*>/g;
  fileRe.lastIndex = from;
  const fm = fileRe.exec(text);
  if (fm && (best === null || fm.index < best.index)) {
    best = { type: "file_open", name: fm[1], index: fm.index, end: fm.index + fm[0].length };
  }

  const patchRe = /<patch name="([^"]+)">/g;
  patchRe.lastIndex = from;
  const pm = patchRe.exec(text);
  if (pm && (best === null || pm.index < best.index)) {
    best = { type: "patch_open", name: pm[1], index: pm.index, end: pm.index + pm[0].length };
  }

  const ci = text.indexOf("<critique>", from);
  if (ci !== -1 && (best === null || ci < best.index)) {
    best = { type: "critique_open", index: ci, end: ci + "<critique>".length };
  }

  // Self-closing file ops: <rename from="a" to="b"/> and <delete name="a"/>
  const renameRe = /<rename from="([^"]+)" to="([^"]+)"\/>/g;
  renameRe.lastIndex = from;
  const rm = renameRe.exec(text);
  if (rm && (best === null || rm.index < best.index)) {
    best = { type: "rename_op", name: rm[1], index: rm.index, end: rm.index + rm[0].length, _to: rm[2] } as any;
  }

  const deleteRe = /<delete name="([^"]+)"\/>/g;
  deleteRe.lastIndex = from;
  const dm = deleteRe.exec(text);
  if (dm && (best === null || dm.index < best.index)) {
    best = { type: "delete_op", name: dm[1], index: dm.index, end: dm.index + dm[0].length };
  }

  return best;
}

// A closing tag can be split across stream chunks ("</fi" + "le>"). When no complete closing tag is in `s`, this returns how
// many characters at its end could still turn into one, so the caller holds them back for the next chunk instead of treating
// them as content (a missed </file> silently merges every following file into the current one).
function partialTagTail(s: string, tag: string): number {
  for (let k = Math.min(s.length, tag.length - 1); k > 0; k--) if (tag.startsWith(s.slice(s.length - k))) return k;
  return 0;
}

function processStreamBlock(chunk: string, state: ParseState): ParseEvent[] {
  const events: ParseEvent[] = [];
  (state as any)._carry = ((state as any)._carry || "") + chunk;
  let text: string = (state as any)._carry;
  (state as any)._carry = "";
  let pos = 0;

  while (pos <= text.length) {
    if (state.phase === "message") {
      const next = findDelimiter(text, pos);
      if (next === null) {
        const safe = Math.max(pos, text.length - 40);
        const emit = text.slice(pos, safe);
        if (emit) {
          if (!state.msgText) events.push({ type: "start" });
          state.msgText += emit;
          events.push({ type: "delta", text: emit });
        }
        (state as any)._carry = text.slice(safe);
        break;
      }
      const before = text.slice(pos, next.index);
      if (before) {
        if (!state.msgText) events.push({ type: "start" });
        state.msgText += before;
        events.push({ type: "delta", text: before });
      }
      if (next.type === "file_open") {
        state.curFileName = next.name!;
        state.curFileContent = "";
        state.phase = "in_file";
        events.push({ type: "file_start", name: next.name });
        pos = next.end;
      } else if (next.type === "patch_open") {
        state.curFileName = next.name!;
        state.patches = [];
        state.curPatchOp = {};
        (state as any)._patchBuf = "";
        state.phase = "in_patch_body" as ParsePhase;
        pos = next.end;
      } else if (next.type === "critique_open") {
        state.curCritique = "";
        state.phase = "in_critique";
        pos = next.end;
      } else if (next.type === "rename_op") {
        events.push({ type: "rename", from: next.name, to: (next as any)._to });
        pos = next.end;
      } else if (next.type === "delete_op") {
        events.push({ type: "delete", name: next.name });
        pos = next.end;
      } else {
        pos = next.end;
      }
    }

    else if (state.phase === "in_file") {
      // Only </file> closes a file. Backtick fences inside HTML/CSS/JS are valid
      // content (template literals, code comments) and must NOT trigger a close.
      const xmlCloseMatch = /< *\/ *file *>/.exec(text.slice(pos));
      const closeIdx = xmlCloseMatch ? pos + xmlCloseMatch.index : -1;
      const closeLen = xmlCloseMatch ? xmlCloseMatch[0].length : 0;

      if (closeIdx === -1) {
        const rest = text.slice(pos);
        const hold = partialTagTail(rest, "</file>");
        const content = rest.slice(0, rest.length - hold);
        state.curFileContent += content;
        if (content) events.push({ type: "file_delta", text: content });
        (state as any)._carry = rest.slice(rest.length - hold);
        break;
      }
      const content = text.slice(pos, closeIdx);
      state.curFileContent += content;
      if (content) events.push({ type: "file_delta", text: content });
      const encoded = safeBase64(state.curFileContent);
      events.push({ type: "file_done", name: state.curFileName, content: encoded, encoding: "base64" });
      state.curFileName = "";
      state.curFileContent = "";
      state.phase = "message";
      pos = closeIdx + closeLen;
    }

    else if ((state.phase as string) === "in_patch_body") {
      const closeIdx = text.indexOf("</patch>", pos);
      if (closeIdx === -1) {
        const rest = text.slice(pos);
        const hold = partialTagTail(rest, "</patch>");
        (state as any)._patchBuf += rest.slice(0, rest.length - hold);
        (state as any)._carry = rest.slice(rest.length - hold);
        break;
      }
      (state as any)._patchBuf += text.slice(pos, closeIdx);
      const ops = parsePatchOps((state as any)._patchBuf as string);
      const original = state.existingFiles[state.curFileName] || "";
      const { result, failed } = applyPatches(original, ops);
      // If ALL patches failed, emit patch_failed so frontend can retry as full rewrite
      if (ops.length === 0 || failed === ops.length) {
        events.push({ type: "patch_done", name: state.curFileName, content: null as any, encoding: "failed" });
      } else {
        const encoded = safeBase64(result);
        // Update existingFiles so any subsequent patches for the same file
        // build on top of this result rather than re-applying to the original.
        state.existingFiles[state.curFileName] = result;
        events.push({ type: "patch_done", name: state.curFileName, content: encoded, encoding: "base64" });
      }
      state.patches = [];
      state.curPatchOp = {};
      (state as any)._patchBuf = "";
      state.phase = "message";
      pos = closeIdx + "</patch>".length;
    }

    else if (state.phase === "in_critique") {
      const closeIdx = text.indexOf("</critique>", pos);
      if (closeIdx === -1) {
        const rest = text.slice(pos);
        const hold = partialTagTail(rest, "</critique>");
        state.curCritique += rest.slice(0, rest.length - hold);
        (state as any)._carry = rest.slice(rest.length - hold);
        break;
      }
      state.curCritique += text.slice(pos, closeIdx);
      try {
        const parsed = JSON.parse(state.curCritique.trim());
        events.push({ type: "critique", data: parsed });
      } catch { /* malformed */ }
      state.phase = "message";
      pos = closeIdx + "</critique>".length;
    }

    else { pos++; }
  }

  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAM BUILD
// ─────────────────────────────────────────────────────────────────────────────
async function streamBuild(
  anthropicRes: Response,
  existingFiles: Record<string, string>,
  emit: (event: string, data: unknown) => Promise<void>,
  // Live usage mirror — updated as tokens arrive so the caller can bill what was generated even if
  // the client disconnects (clicks Stop) before the stream finishes. Without this, usage was only
  // known after the function returned, so an early Stop cost the user nothing.
  usageOut?: { in: number; out: number; cacheWrite: number; cacheRead: number },
  // When the client disconnects, this aborts — we cancel the Anthropic read so generation (and
  // billing) stops at roughly the point the user pressed Stop instead of running to completion.
  signal?: AbortSignal,
): Promise<{ files: Record<string, string>; message: string; tokensIn: number; tokensOut: number; tokensCacheWrite: number; tokensCacheRead: number }> {
  const reader = anthropicRes.body!.getReader();
  const decoder = new TextDecoder();
  let antBuf = "";
  const state = makeParse(existingFiles);
  let startEmitted = false;
  const collectedFiles: Record<string, string> = {};
  let finalMessage = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheWrite = 0;
  let tokensCacheRead = 0;
  let outChars = 0; // total output text streamed — used to estimate tokens if Stop hits before Anthropic reports its final count

  try {
    while (true) {
      // Client disconnected (Stop): stop reading so Anthropic stops generating/billing. The usage
      // accumulated so far (plus the char-based estimate below) is still recorded by the caller.
      if (signal?.aborted) { try { await reader.cancel(); } catch { /* already closing */ } break; }
      const { done, value } = await reader.read();
      if (done) break;
      antBuf += decoder.decode(value, { stream: true });
      const lines = antBuf.split("\n");
      antBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(raw); } catch { continue; }

        if (parsed.type === "message_start") {
          const usage = (parsed.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
          if (usage) {
            tokensIn         += usage.input_tokens                 || 0;
            tokensCacheWrite += usage.cache_creation_input_tokens  || 0;
            tokensCacheRead  += usage.cache_read_input_tokens      || 0;
            // output_tokens in usage is CUMULATIVE for the response — take the max, never sum
            // (summing repeated cumulative values would massively over-count).
            tokensOut         = Math.max(tokensOut, usage.output_tokens || 0);
          }
          if (usageOut) { usageOut.in = tokensIn; usageOut.cacheWrite = tokensCacheWrite; usageOut.cacheRead = tokensCacheRead; usageOut.out = tokensOut; }
        }

        if (parsed.type === "message_delta") {
          const usage = parsed.usage as Record<string, number> | undefined;
          if (usage) tokensOut = Math.max(tokensOut, usage.output_tokens || 0); // cumulative — take latest, don't sum
          if (usageOut) usageOut.out = tokensOut;
          // Detect token limit hit — signal client so it can continue automatically
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason === "max_tokens") {
            await emit("max_tokens_hit", {});
          }
        }

        if (parsed.type === "content_block_delta") {
          const delta = parsed.delta as Record<string, unknown>;
          if (delta?.type === "text_delta") {
            const text = delta.text as string;
            outChars += text.length; // track output volume for the Stop-before-final-usage estimate
            // Update the live output estimate every chunk (Anthropic only reports real output_tokens
            // in the FINAL message_delta, so without this an interrupted stream would bill ~0 output).
            if (usageOut) usageOut.out = Math.max(usageOut.out, Math.ceil(outChars / 4));
            const events = processStreamBlock(text, state);

            for (const ev of events) {
              if (ev.type === "start" && !startEmitted) {
                await emit("start", {});
                startEmitted = true;
              } else if (ev.type === "delta") {
                if (!startEmitted) { await emit("start", {}); startEmitted = true; }
                await emit("delta", { text: ev.text });
              } else if (ev.type === "file_start") {
                await emit("file_start", { name: ev.name });
              } else if (ev.type === "file_delta") {
                await emit("file_delta", { text: ev.text });
              } else if (ev.type === "file_done") {
                let outContent = ev.content!;
                let decoded = "";
                if (ev.name && outContent) {
                  try { decoded = decodeURIComponent(escape(atob(outContent))); } catch { decoded = atob(outContent); }
                  // Safety net: if the AI reproduced the truncation marker, the file was cut off.
                  // Restore the original tail so nothing is lost.
                  const truncMarker = "<!-- [COMPLETE FILE";
                  const original = existingFiles[ev.name];
                  if (original && decoded.includes(truncMarker)) {
                    const markerIdx = decoded.indexOf(truncMarker);
                    decoded = decoded.slice(0, markerIdx) + original.slice(markerIdx);
                    outContent = safeBase64(decoded);
                  }
                }
                await emit("file", { name: ev.name, content: outContent, encoding: "base64" });
                if (ev.name && decoded) {
                  collectedFiles[ev.name] = decoded;
                }
              } else if (ev.type === "patch_done") {
                if (ev.encoding === "failed") {
                  // All patches failed to match — tell frontend to retry as full rewrite
                  await emit("patch_failed", { name: ev.name });
                } else {
                  await emit("file_start", { name: ev.name, mode: "patch" });
                  await emit("file", { name: ev.name, content: ev.content, encoding: "base64" });
                  if (ev.name && ev.content) {
                    try { collectedFiles[ev.name] = decodeURIComponent(escape(atob(ev.content))); } catch { collectedFiles[ev.name!] = atob(ev.content!); }
                  }
                }
              } else if (ev.type === "critique") {
                // Critique removed from the product — the parser still swallows any stray <critique>
                // block so it never leaks into the chat, but we no longer emit or use it.
              } else if (ev.type === "rename") {
                await emit("rename", { from: ev.from, to: ev.to });
              } else if (ev.type === "delete") {
                await emit("delete", { name: ev.name });
              }
            }
          }
        }

        if (parsed.type === "message_stop") {
          // Flush any text held in the carry buffer (last 80 chars held back to
          // detect split XML tags). If never flushed, short conversational
          // responses get cut off mid-sentence.
          const carry = (state as any)._carry || "";
          if (carry) {
            if (state.phase === "in_file") {
              state.curFileContent += carry; // an unterminated file keeps the tail that was held back for a possible </file>
            } else if (state.phase === "message") {
              state.msgText += carry;
              if (carry.trim()) await emit("delta", { text: carry });
            }
            (state as any)._carry = "";
          }
          finalMessage = state.msgText.trim();
          await emit("message", { message: finalMessage });
          await emit("done", { count: Object.keys(collectedFiles).length });
        }
      }
    }
  } catch (err) {
    await emit("error", { error: String(err) });
  }

  // If the stream ended while mid-file (connection drop, timeout, Supabase kill),
  // emit whatever was accumulated so the client can save it and continue.
  if ((state.phase as string) === "in_file" && state.curFileName && state.curFileContent.length > 0) {
    try {
      const partialEncoded = safeBase64(state.curFileContent);
      await emit("partial_file", { name: state.curFileName, content: partialEncoded, encoding: "base64" });
    } catch { /* stream may already be closing */ }
  }

  // If Stop hit before Anthropic reported its final cumulative output_tokens, fall back to a
  // char-based estimate (~4 chars/token) so an interrupted build still bills for what it produced
  // instead of nothing. On normal completion the reported count is >= this, so max() is a no-op.
  const estOut = Math.ceil(outChars / 4);
  if (estOut > tokensOut) tokensOut = estOut;
  if (usageOut) usageOut.out = Math.max(usageOut.out, tokensOut);

  return { files: collectedFiles, message: finalMessage, tokensIn, tokensOut, tokensCacheWrite, tokensCacheRead };
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAM CHAT
// ─────────────────────────────────────────────────────────────────────────────
async function streamChat(
  anthropicRes: Response,
  emit: (event: string, data: unknown) => Promise<void>,
): Promise<{ text: string; tokensIn: number; tokensOut: number; cacheWrite: number; cacheRead: number }> {
  const reader = anthropicRes.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "", fullText = "", started = false;
  let tokensIn = 0, tokensOut = 0, cacheWrite = 0, cacheRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(raw); } catch { continue; }
        if (parsed.type === "message_start") {
          const usage = (parsed.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
          if (usage) {
            tokensIn   += usage.input_tokens                || 0;
            cacheWrite += usage.cache_creation_input_tokens || 0;
            cacheRead  += usage.cache_read_input_tokens     || 0;
          }
        }
        if (parsed.type === "message_delta") {
          const usage = (parsed as Record<string, unknown>).usage as Record<string, number> | undefined;
          if (usage) tokensOut += usage.output_tokens || 0;
        }
        if (parsed.type === "content_block_delta") {
          const delta = parsed.delta as Record<string, unknown>;
          if (delta?.type === "text_delta") {
            const text = delta.text as string;
            fullText += text;
            if (!started) { await emit("start", {}); started = true; }
            await emit("delta", { text });
          }
        }
        if (parsed.type === "message_stop") {
          await emit("done", { text: fullText });
        }
      }
    }
  } catch (err) {
    await emit("error", { error: String(err) });
  }
  return { text: fullText, tokensIn, tokensOut, cacheWrite, cacheRead };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVE
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SUGGESTIONS GENERATOR
// ─────────────────────────────────────────────────────────────────────────────
const SUGGESTIONS_SYSTEM = `You generate 3 short follow-up action suggestions for a non-technical website builder. Return ONLY a valid JSON array of 3 strings. Each suggestion must: be 5-8 words, start with an action verb, use plain English (zero technical terms), and be specific to what was just built. Example output: ["Make it mobile friendly","Add a contact section","Change the color to blue"]`;

async function generateSuggestions(
  builtMessage: string,
  builtFiles: Record<string, string>,
  messages: { role: string; content: unknown }[],
  userId = "",
): Promise<string[]> {
  try {
    const fileNames = Object.keys(builtFiles).join(", ") || "none";
    const lastUser = messages.filter(m => m.role === "user").slice(-1)
      .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("").slice(0, 300);
    const prompt = `Files just built: ${fileNames}\nWhat the AI just did: ${builtMessage.slice(0, 200)}\nUser's last request: ${lastUser}\n\nSuggest 3 next actions.`;
    const res = await callAnthropic(MODEL_FAST, SUGGESTIONS_SYSTEM, [{ role: "user", content: prompt }], 150, false);
    if (!res.ok) return [];
    const d = await res.json();
    const u = d.usage || {};
    if (userId) await incrementUsage(userId, u.input_tokens || 0, u.output_tokens || 0, MODEL_FAST, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0);
    const text = (d.content?.[0]?.text || "[]").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.slice(0, 3).filter((s: unknown) => typeof s === "string");
  } catch { /* never block */ }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE MODE — the studio's guided flow (REVAMP Step 7). Logic: stage-handler.ts + stages.ts (unit-tested); this is only the wiring.
//   { stage, project_id, messages, prepare:true }  → access/input/credit checks, a build_jobs row, and the payload for the build Worker
//   { stage_done:{ job_id, ok, message, error } }  → the Worker reporting a finished run: parse, validate, save the artifact, close the job
// Additive: it never touches the legacy build/onboarding paths below.
// ─────────────────────────────────────────────────────────────────────────────
const CREDIT_LIMITS_CENTS: Record<string, number> = { trial: 300, starter: 1500, pro: 4000, max: 12000 };

// Same rule as the live usage gate in BUILD MODE (fails open if the lookup itself fails — usage is billed by the Worker regardless).
async function usageGateMessage(userId: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/account_billing?user_id=eq.${encodeURIComponent(userId)}&select=plan,credits_used_cents,trial_ends_at,extra_credits_cents`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
    );
    if (!res.ok) return null;
    const p = (await res.json())?.[0];
    if (!p) return null;
    const limit = (CREDIT_LIMITS_CENTS[p.plan as string] || 1500) + ((p.extra_credits_cents as number) || 0);
    const used = (p.credits_used_cents as number) || 0;
    const trialExpired = p.plan === "trial" && p.trial_ends_at && new Date(p.trial_ends_at as string) < new Date();
    if (trialExpired) return "Your free trial has ended. Upgrade to keep building.";
    if (used >= limit) return "You've used all your AI credits for this month. Upgrade your plan to continue.";
  } catch { /* non-blocking */ }
  return null;
}

// Constant-time comparison of the build Worker's shared secret (STAGE_WORKER_SECRET, set as a Supabase function secret AND a Worker
// secret) with the one the request carried. Missing on our side = nobody passes (fail closed). Not the service key: the edge
// function's SUPABASE_SERVICE_ROLE_KEY is not the same string the Worker holds.
function sameSecret(given: string | null, expected: string): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function stageDeps(): StageDeps {
  const rest = `${SUPABASE_URL}/rest/v1`;
  const read = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  const write = { ...read, "Content-Type": "application/json" };
  const enc = encodeURIComponent;
  const rows = async (path: string): Promise<Record<string, unknown>[]> => {
    const r = await fetch(`${rest}/${path}`, { headers: read });
    if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status}`);
    return await r.json();
  };
  return {
    async getProjectAccess(projectId, userId) {
      const p = (await rows(`projects?id=eq.${enc(projectId)}&select=id,name,user_id,stage&limit=1`))[0];
      if (!p) return null;
      if (p.user_id !== userId) {
        const m = (await rows(`project_members?project_id=eq.${enc(projectId)}&user_id=eq.${enc(userId)}&status=eq.accepted&select=id&limit=1`))[0];
        if (!m) return null;
      }
      return { name: String(p.name ?? ""), stage: String(p.stage ?? "plan") };
    },
    async getLatestArtifacts(projectId) {
      const out: LatestArtifacts = {};
      for (const r of await rows(`project_artifacts_latest?project_id=eq.${enc(projectId)}&select=kind,version,stale,data`)) {
        out[r.kind as ArtifactKind] = { version: r.version as number, stale: r.stale === true, data: (r.data ?? {}) as Record<string, unknown> };
      }
      return out;
    },
    async getProjectFiles(projectId) {
      const p = (await rows(`projects?id=eq.${enc(projectId)}&select=files&limit=1`))[0];
      const out: Record<string, string> = {};
      for (const [name, text] of Object.entries((p?.files ?? {}) as Record<string, unknown>)) if (typeof text === "string") out[name] = text;
      return out;
    },
    async snapshot(projectId, kind, label) {
      const r = await fetch(`${rest}/rpc/take_site_snapshot`, {
        method: "POST", headers: write, body: JSON.stringify({ p_project: projectId, p_kind: kind, p_label: label }),
      });
      if (!r.ok) throw new Error(`take_site_snapshot ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
      const out = await r.json();
      return { seq: out.seq as number, created: out.created === true };
    },
    usageGate: usageGateMessage,
    async createJob(job) {
      // One live stage run per project: anything still 'running' is superseded.
      await fetch(`${rest}/build_jobs?project_id=eq.${enc(job.project_id)}&stage=not.is.null&status=eq.running`, {
        method: "PATCH", headers: { ...write, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "failed", error: "Superseded by a newer run", finished_at: new Date().toISOString() }),
      });
      const r = await fetch(`${rest}/build_jobs`, {
        method: "POST", headers: { ...write, Prefer: "return=representation" },
        body: JSON.stringify({ ...job, status: "running" }),
      });
      if (!r.ok) throw new Error(`build_jobs insert ${r.status}`);
      return (await r.json())[0].id as string;
    },
    async getJob(jobId) {
      return ((await rows(`build_jobs?id=eq.${enc(jobId)}&select=id,project_id,user_id,stage,status,prompt&limit=1`))[0] as unknown as JobRow | undefined) ?? null;
    },
    async finishJob(jobId, patch) {
      await fetch(`${rest}/build_jobs?id=eq.${enc(jobId)}&status=eq.running`, {
        method: "PATCH", headers: { ...write, Prefer: "return=minimal" },
        body: JSON.stringify({ ...patch, finished_at: new Date().toISOString() }),
      });
    },
    async saveArtifact(projectId, kind, data) {
      const r = await fetch(`${rest}/rpc/put_project_artifact`, {
        method: "POST", headers: write, body: JSON.stringify({ p_project: projectId, p_kind: kind, p_data: data }),
      });
      if (!r.ok) throw new Error(`put_project_artifact ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
      const out = await r.json();
      return { version: out.version as number, staled: (out.staled ?? []) as string[] };
    },
    async saveFiles(projectId, files) {
      const r = await fetch(`${rest}/rpc/set_project_files`, {
        method: "POST", headers: write, body: JSON.stringify({ p_project: projectId, p_files: files }),
      });
      if (!r.ok) throw new Error(`set_project_files ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    },
    async lastMessage(projectId, stage) {
      const m = (await rows(`stage_messages?project_id=eq.${enc(projectId)}&stage=eq.${enc(stage)}&select=role,content&order=created_at.desc&limit=1`))[0];
      return m ? { role: m.role as "user" | "assistant", content: String(m.content ?? "") } : null;
    },
    async saveMessage(m) {
      const r = await fetch(`${rest}/stage_messages`, { method: "POST", headers: { ...write, Prefer: "return=minimal" }, body: JSON.stringify(m) });
      if (!r.ok) throw new Error(`stage_messages insert ${r.status}`);
    },
  };
}

// FULL BUILD (build-handler.ts): the stage deps plus the build_steps checklist, project files, billing and the atomic site commit.
function buildDeps(): BuildDeps {
  const rest = `${SUPABASE_URL}/rest/v1`;
  const read = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };
  const write = { ...read, "Content-Type": "application/json" };
  const enc = encodeURIComponent;
  const rows = async (path: string): Promise<Record<string, unknown>[]> => {
    const r = await fetch(`${rest}/${path}`, { headers: read });
    if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status}`);
    return await r.json();
  };
  const stage = stageDeps();
  return {
    getProjectAccess: stage.getProjectAccess,
    getLatestArtifacts: stage.getLatestArtifacts,
    getJob: stage.getJob,
    finishJob: stage.finishJob,
    saveArtifact: stage.saveArtifact,
    saveMessage: stage.saveMessage,
    usageGate: stage.usageGate,
    snapshot: stage.snapshot,
    modelId: MODEL_BUILD,
    getProjectFiles: stage.getProjectFiles,
    async listSteps(jobId) {
      return (await rows(`build_steps?job_id=eq.${enc(jobId)}&select=job_id,project_id,seq,kind,file,label,status,attempt,detail,cost_cents,output&order=seq.asc`))
        .map((r) => ({ ...r, cost_cents: Number(r.cost_cents ?? 0) })) as unknown as StepRow[];
    },
    async insertSteps(steps: NewStep[]) {
      const r = await fetch(`${rest}/build_steps?on_conflict=job_id,seq`, {
        method: "POST", headers: { ...write, Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(stepInsertRows(steps)),
      });
      if (!r.ok) throw new Error(`build_steps insert ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    },
    async updateStep(jobId: string, seq: number, patch: StepPatch) {
      const { started, finished, ...cols } = patch;
      const now = new Date().toISOString();
      const r = await fetch(`${rest}/build_steps?job_id=eq.${enc(jobId)}&seq=eq.${seq}`, {
        method: "PATCH", headers: { ...write, Prefer: "return=minimal" },
        body: JSON.stringify({ ...cols, ...(started ? { started_at: now } : {}), ...(finished ? { finished_at: now } : {}) }),
      });
      if (!r.ok) throw new Error(`build_steps update ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    },
    async bill(userId, usage, modelId) {
      await incrementUsage(userId, usage.in, usage.out, modelId, usage.cacheWrite, usage.cacheRead);
      return tokensCostExact(usage.in, usage.out, modelId, usage.cacheWrite, usage.cacheRead);
    },
    async commitSite(projectId, files, remove) {
      const r = await fetch(`${rest}/rpc/commit_site_build`, {
        method: "POST", headers: write, body: JSON.stringify({ p_project: projectId, p_files: files, p_remove: remove }),
      });
      if (!r.ok) throw new Error(`commit_site_build ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    },
  };
}

// TWEAKS history (tweaks-handler.ts): undo / redo / restore through the platform-only database functions.
function historyDeps(): HistoryDeps {
  const rest = `${SUPABASE_URL}/rest/v1`;
  const write = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" };
  const stage = stageDeps();
  return {
    getProjectAccess: stage.getProjectAccess,
    getLatestArtifacts: stage.getLatestArtifacts,
    getProjectFiles: stage.getProjectFiles,
    saveArtifact: stage.saveArtifact,
    saveFiles: stage.saveFiles,
    async moveHistory(projectId, action, seq) {
      const r = await fetch(`${rest}/rpc/move_site_history`, {
        method: "POST", headers: write, body: JSON.stringify({ p_project: projectId, p_action: action, p_seq: seq }),
      });
      if (!r.ok) throw new Error(`move_site_history ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
      return await r.json() as MoveResult;
    },
    async supersedeRunning(projectId, reason) {
      await fetch(`${rest}/build_jobs?project_id=eq.${encodeURIComponent(projectId)}&stage=not.is.null&status=eq.running`, {
        method: "PATCH", headers: { ...write, Prefer: "return=minimal" },
        body: JSON.stringify({ status: "failed", error: reason, finished_at: new Date().toISOString() }),
      });
    },
  };
}

// The Worker's build operations (a Cloudflare Workflow calls these once per step): authenticated by the shared secret alone — a
// Workflow outlives the owner's login token, and every operation names its job, which names the user and project.
async function handleBuildOp(op: Record<string, unknown>, workerKey: string | null): Promise<Response> {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  if (!sameSecret(workerKey, Deno.env.get("STAGE_WORKER_SECRET") ?? "")) return json({ error: "Only the build service can do that.", code: "forbidden" }, 403);
  try {
    const r = await runBuildOp(op && typeof op === "object" ? op : {}, buildDeps());
    return json(r.body, r.status);
  } catch (e) {
    console.error("[ai-chat] build op failed", e);
    // `detail` goes to the Worker only (the secret above): it lands in the Workflow's step history, not in front of a user.
    return json({ error: "The build step failed.", code: "build_failed", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
}

async function handleStageMode(
  body: { stage?: unknown; stage_done?: Record<string, unknown>; stage_cancel?: Record<string, unknown>; build_recheck?: Record<string, unknown>; tweaks_history?: Record<string, unknown>; project_id?: string; messages?: unknown; pointed?: unknown },
  userId: string,
  prepareMode: boolean,
  workerKey: string | null,
): Promise<Response> {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  const deps = stageDeps();
  try {
    if (body.stage_done !== undefined) {
      const r = await finishStageRun(body.stage_done ?? {}, userId, deps, sameSecret(workerKey, Deno.env.get("STAGE_WORKER_SECRET") ?? ""));
      return json(r.body, r.status);
    }
    if (body.stage_cancel !== undefined) {
      const r = await cancelStageRun(body.stage_cancel ?? {}, userId, deps);
      return json(r.body, r.status);
    }
    // "Check again": the owner's own request, answered here (no AI call, so no Worker).
    if (body.build_recheck !== undefined) {
      const r = await recheckSite(body.build_recheck ?? {}, userId, buildDeps());
      return json(r.body, r.status);
    }
    // Undo / redo / "go back to this version" in the TWEAKS stage: the owner's own request, no AI.
    if (body.tweaks_history !== undefined) {
      const r = await moveHistory(body.tweaks_history ?? {}, userId, historyDeps());
      return json(r.body, r.status);
    }
    // Stage runs execute in the build Worker (no wall-clock limit); this function only prepares them.
    if (!prepareMode) return json({ error: "Stage runs go through the build Worker.", code: "use_worker" }, 400);
    const run = await beginStage(body, userId, deps);
    if (isHttpError(run)) return json(run.body, run.status);
    // FULL BUILD runs as a Workflow of many calls: the Worker only needs to know which job to run.
    if (run.kind === "workflow") return json({ kind: "workflow", job: { id: run.jobId, stage: run.stage }, user_id: userId });
    const model = run.prompt.model === "fast" ? MODEL_FAST : MODEL_BUILD;
    return json({
      kind: "run",
      payload: buildAnthropicPayload(model, run.prompt.system, run.messages, run.prompt.maxTokens, true, run.prompt.suffix),
      files_for_patching: run.filesForPatching ?? {},
      user_id: userId,
      category: "",
      job: { id: run.jobId, stage: run.stage },
      want_suggestions: false,
    });
  } catch (e) {
    console.error("[ai-chat] stage mode failed", e);
    return json({ error: "Something went wrong starting this step. Please try again.", code: "stage_failed" }, 500);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  // FULL BUILD operations come from the Worker's Workflow with the shared secret and no user login (see handleBuildOp).
  const workerKey = req.headers.get("x-vx-worker-key");
  if (workerKey) {
    const peek = await req.clone().json().catch(() => null) as { build_op?: Record<string, unknown> } | null;
    if (peek && peek.build_op !== undefined) return await handleBuildOp(peek.build_op, workerKey);
  }

  const userId = await verifiedUserId(req.headers.get("Authorization"));
  if (!userId) {
    return new Response(JSON.stringify({ error: "Please sign in to use AI." }), {
      status: 401, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  let body: {
    messages?: { role: string; content: unknown }[];
    files?: Record<string, string>;
    brief_mode?: boolean;
    spec_mode?: boolean;
    page_mode?: boolean;
    page_name?: string;
    stream?: boolean;
    brief?: Record<string, unknown>;
    spec?: Record<string, unknown>;
    auto_fix?: boolean;
    intent_mode?: boolean;
    convo_mode?: boolean;
    chat_mode?: boolean;
    project_id?: string;
    ai_context?: Record<string, unknown>;
    continuation_mode?: boolean;
    fresh_build_session?: boolean;
    build_category?: string; // frozen category replayed on continuation so the component-library block stays byte-identical (cache hit)
    prepare?: boolean;       // build Worker asks for the Anthropic payload instead of streaming it here
    suggest?: boolean;       // build Worker asks for follow-up suggestions after a build
    built_message?: string;  // suggest mode: the message the build produced
    built_files?: Record<string, string>; // suggest mode: the files the build produced
    marketing_questions?: boolean;
    marketing_guide?: boolean;
    marketing_answers?: string;
    marketing_chat?: boolean;
    stage?: unknown;                         // studio stage run (REVAMP Step 7) — see stage-handler.ts
    stage_done?: Record<string, unknown>;    // build Worker → us: a stage run finished (reply to parse + save)
    stage_cancel?: Record<string, unknown>;  // the studio's Stop button: close a running stage job
    build_recheck?: Record<string, unknown>; // the studio's "Check again": verify the saved site, save a fresh launch report
    tweaks_history?: Record<string, unknown>; // the studio's undo / redo / restore: move along the site's checkpoints
    pointed?: unknown;                       // TWEAKS: the element the owner pointed at in the preview
  };
  try { body = await req.json(); }
  catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Build operations are the Worker's alone (the secret header is checked at the top); a login is not a substitute for it.
  if ((body as { build_op?: unknown }).build_op !== undefined) {
    return new Response(JSON.stringify({ error: "Only the build service can do that.", code: "forbidden" }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // prepare mode: the Cloudflare build Worker asks us to assemble the Anthropic request (all the
  // prompt logic) but NOT call it — so the Worker can run it with no wall-clock timeout. The two
  // streaming sites below (onboarding gate + main build) return the payload as JSON when set.
  const prepareMode = body.prepare === true;

  // ── STAGE MODE (the studio's guided flow; the old editor never sends these fields) ──
  if (body.stage !== undefined || body.stage_done !== undefined || body.stage_cancel !== undefined || body.build_recheck !== undefined || body.tweaks_history !== undefined) {
    return await handleStageMode(body as { stage?: unknown; stage_done?: Record<string, unknown>; stage_cancel?: Record<string, unknown>; build_recheck?: Record<string, unknown>; tweaks_history?: Record<string, unknown>; project_id?: string; messages?: unknown; pointed?: unknown }, userId, prepareMode, req.headers.get("x-vx-worker-key"));
  }

  // ── SUGGEST MODE (build Worker → us, after a build, to fetch follow-up suggestions) ──
  if (body.suggest) {
    const items = await generateSuggestions(
      (body.built_message as string) || "",
      (body.built_files as Record<string, string>) || {},
      (body.messages as { role: string; content: unknown }[]) || [],
      userId || "",
    );
    return new Response(JSON.stringify({ items }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // ── BRIEF MODE ────────────────────────────────────────────────────────────
  if (body.brief_mode) {
    const userPrompt = ((body.messages || []) as { role: string; content: string }[])
      .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");

    const briefRes = await callAnthropic(
      MODEL_FAST,
      BRIEF_SYSTEM,
      [{ role: "user", content: `Build request:\n${userPrompt}` }],
      900,
      false,
    );

    if (!briefRes.ok) {
      return new Response(JSON.stringify({ error: "Brief failed" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const briefData = await briefRes.json();
    const briefText = (briefData.content?.[0]?.text || "{}")
      .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    let brief: Record<string, unknown> = {};
    try { brief = JSON.parse(briefText); } catch { brief = {}; }
    if (userId) {
      const u = briefData.usage || {};
      await incrementUsage(userId, u.input_tokens || 0, u.output_tokens || 0, MODEL_FAST, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0);
    }
    return new Response(JSON.stringify(brief), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // ── SPEC MODE ─────────────────────────────────────────────────────────────
  if (body.spec_mode) {
    const messages = body.messages || [];
    const brief = body.brief || {};
    const category = inferCategory(brief, messages);
    const guide = getCategoryGuide(category);

    const userContent = messages.map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    ).join("\n");

    const specPrompt = `Build request: ${userContent}

Brief context:
Category: ${brief.category || category}
Industry: ${brief.industry || ""}
Audience: ${brief.audience || ""}
Tone: ${brief.tone || ""}
Aesthetic: ${brief.aesthetic || ""}
Color direction: ${brief.colorDirection || ""}
Font direction: ${brief.fontDirection || ""}
Page structure: ${(brief.pageStructure as string[] || []).join(", ")}
Multi-page: ${brief.isMultiPage ? "yes" : "no"}
Visual reference: ${brief.visualReference || ""}
Things to avoid: ${brief.thingsToAvoid || ""}
${brief.suggestedName ? `Suggested name: ${brief.suggestedName}` : ""}

${guide}`;

    const specRes = await callAnthropic(
      MODEL_SPEC,
      SPEC_SYSTEM,
      [{ role: "user", content: specPrompt }],
      2200,
      false,
      "",
      // Opus 5 thinks by default; disable it so the response is a single JSON text block (cheap + parseable)
      { thinking: { type: "disabled" } },
    );

    if (!specRes.ok) {
      return new Response(JSON.stringify({ error: "Spec generation failed" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const specData = await specRes.json();
    // Find the text block (robust even if a thinking block precedes it)
    const specTextBlock = (specData.content || []).find((b: { type?: string; text?: string }) => b?.type === "text");
    let specText = (specTextBlock?.text || "").trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    // Pull the outermost {...} in case the model wrapped the JSON in prose
    const _fb = specText.indexOf("{"), _lb = specText.lastIndexOf("}");
    if (_fb !== -1 && _lb > _fb) specText = specText.slice(_fb, _lb + 1);
    let spec: Record<string, unknown> = {};
    try { spec = specText ? JSON.parse(specText) : {}; } catch { spec = {}; }
    if (userId) {
      const u = specData.usage || {};
      await incrementUsage(userId, u.input_tokens || 0, u.output_tokens || 0, MODEL_SPEC, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0);
    }
    return new Response(JSON.stringify(spec), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // ── INTENT MODE ───────────────────────────────────────────────────────────
  if (body.intent_mode) {
    const files = body.files || {};
    const messages = body.messages || [];
    const hasFiles = Object.keys(files).length > 0;
    const lastMsg = messages[messages.length - 1];
    const userText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || '');
    const recentCtx = (messages as {role:string;content:unknown}[]).slice(-3)
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : ''}`)
      .join('\n');

    const intentRes = await callAnthropic(
      MODEL_FAST,
      INTENT_SYSTEM,
      [{ role: 'user', content: `Has existing files: ${hasFiles}\nRecent conversation:\n${recentCtx}\nCurrent message: ${userText}` }],
      30,
      false,
    );

    if (!intentRes.ok) {
      return new Response(JSON.stringify({ intent: 'chat' }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const intentData = await intentRes.json();
    const intentText = (intentData.content?.[0]?.text || '{"intent":"chat"}')
      .replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    let result: Record<string, unknown> = { intent: 'chat' };
    try { result = JSON.parse(intentText); } catch { result = { intent: 'chat' }; }
    if (userId) {
      const u = intentData.usage || {};
      await incrementUsage(userId, u.input_tokens || 0, u.output_tokens || 0, MODEL_FAST, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0);
    }
    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // ── CONVERSATION MODE ─────────────────────────────────────────────────────
  if (body.convo_mode) {
    const messages = body.messages || [];
    const files = body.files || {};
    const wantStream = body.stream !== false;

    const fileList = Object.keys(files);
    const projectCtx = fileList.length ? `\n\nThe user's current project has these files: ${fileList.join(', ')}.` : '';
    const systemWithCtx = SYSTEM_CONVO + projectCtx;

    // Upgraded: Sonnet for convo mode, higher token budget
    const convoRes = await callAnthropic(
      MODEL_BUILD,
      systemWithCtx,
      messages as { role: string; content: unknown }[],
      2000,
      wantStream,
    );

    if (!convoRes.ok) {
      const err = await convoRes.text();
      return new Response(JSON.stringify({ error: err }), {
        status: convoRes.status, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    if (!wantStream) {
      const data = await convoRes.json();
      return new Response(JSON.stringify(data), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const emit = async (event: string, data: unknown): Promise<void> => {
      try { await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
    };
    (async () => { try { const r = await streamChat(convoRes, emit); if (userId) await incrementUsage(userId, r.tokensIn, r.tokensOut, MODEL_BUILD, r.cacheWrite, r.cacheRead); const _cs = await generateSuggestions(r.text, {}, messages as {role:string;content:unknown}[], userId); if (_cs.length) await emit("suggestions", { items: _cs }); } catch {} finally { try { await writer.close(); } catch {} } })();
    return new Response(readable, {
      headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }

  // ── MARKETING CHAT ────────────────────────────────────────────────────────
  // Conversational marketing advisor — uses project context but responds as a growth strategist
  if (body.marketing_chat) {
    const files = (body.files || {}) as Record<string, string>;
    const messages = (body.messages || []) as { role: string; content: unknown }[];
    const ctx = fileContext(files, false, false);

    const MKT_CHAT_SYSTEM = `You are a Growth Advisor embedded inside Vertly, a website builder. You know this user's business from the project context below.

Give specific, actionable marketing advice. When recommending a channel or strategy, cover:
- Why it fits this business specifically
- The actual platform or tool and what it costs
- How to execute it in a few concrete steps
- What they can realistically expect — leads per month, conversion rates, and importantly: how much revenue they can generate from it. Give actual dollar ranges, not vague estimates. e.g. "At a 3% close rate on 40 leads/month at $2,000 average deal size, that's $2,400/month in new revenue."

Keep responses focused and readable. Don't write out full email sequences, ad scripts, or content templates unless the user specifically asks — cover the strategy and let them ask for the copy.

Be direct. No fluff. Write like someone who genuinely knows this stuff cold. Never start a response with a compliment. If you need one piece of info to give a good answer, ask for just that one thing.${ctx ? `\n\nProject context:\n${ctx}` : ""}`;

    const mktRes = await callAnthropic(MODEL_BUILD, MKT_CHAT_SYSTEM, messages, 8000, true);
    if (!mktRes.ok) {
      const err = await mktRes.text();
      return new Response(JSON.stringify({ error: err }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const emit = async (event: string, data: unknown): Promise<void> => {
      try { await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
    };
    (async () => {
      try {
        const r = await streamChat(mktRes, emit);
        if (userId) await incrementUsage(userId, r.tokensIn, r.tokensOut, MODEL_BUILD, r.cacheWrite, r.cacheRead);
      } catch {}
      finally { try { await writer.close(); } catch {} }
    })();
    return new Response(readable, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }

  // ── MARKETING QUESTIONS ───────────────────────────────────────────────────
  // Phase 1: analyze the project and return 4 targeted questions
  if (body.marketing_questions) {
    const files = (body.files || {}) as Record<string, string>;
    const ctx = fileContext(files, false, false);

    const MKTQ_SYSTEM = `You are a world-class growth strategist. A business has shared their website context with you. Your job is to create a hyper-specific marketing plan for them — but first you need 4 things you can't infer from the site itself.

Read the context carefully. Then respond with exactly this format:

One sentence showing you genuinely understand what this business is, who it's for, and what makes it interesting. Be specific — don't say "I see you have a great product", say something real about their actual business.

Then ask exactly 4 numbered questions. Focus on what you truly can't know from the site:
- Their monthly budget for marketing (be specific about ranges)
- Their timeline — need fast results or building for the long term?
- Their current reach — existing email list, social following, any customers yet?
- What they've already tried, if anything

Keep questions short and punchy. No explanations or preamble after the intro sentence — just the 4 questions.`;

    const mktqRes = await callAnthropic(MODEL_BUILD, MKTQ_SYSTEM, [
      { role: "user", content: "Here is my project context:\n" + ctx }
    ], 600, false);

    if (!mktqRes.ok) {
      return new Response(JSON.stringify({ error: "Marketing questions failed" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const mktqData = await mktqRes.json();
    const questionText = mktqData.content?.[0]?.text || "";
    if (userId) {
      const u = mktqData.usage || {};
      try { await incrementUsage(userId, u.input_tokens || 0, u.output_tokens || 0, MODEL_BUILD, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0); } catch {}
    }
    return new Response(JSON.stringify({ questions: questionText }), {
      status: 200, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // ── MARKETING GUIDE ───────────────────────────────────────────────────────
  // Phase 2: stream a complete, specific marketing playbook
  if (body.marketing_guide) {
    const files = (body.files || {}) as Record<string, string>;
    const answers = body.marketing_answers || "";
    const ctx = fileContext(files, false, false);

    const MKTG_SYSTEM = `You are a world-class growth strategist. You give specific, actionable advice — real tool names, real prices, real steps, real numbers. You've helped hundreds of businesses grow and you know what actually works, not what sounds good in a deck.

You're going to write a complete marketing playbook for this business. Based on their answers, pick the 2-3 highest-ROI channels for their specific situation and budget. Don't list everything — be decisive.

Rules:
- Name actual tools with actual current prices ("Instantly at $47/month", not "an email platform")
- Give actual operational numbers ("200 emails/day per domain after a 2-week warmup", not "send regularly")
- Include realistic outcome ranges based on real industry benchmarks
- Be honest about what won't work for their budget or timeline
- If their budget is small, acknowledge it and work with it — don't pretend $200/month is a $5k budget

Structure your response exactly like this:

## The Situation
What you know about their business and why you're recommending these specific channels. One paragraph, direct.

## Your Top Channels (ranked by ROI)
For each channel (2-3 max):
**[Channel Name]** — [one-line reason why this fits them]
- Setup: step by step what to actually do
- Tools: specific tools with prices
- Cost: monthly total
- Expected results: realistic range (e.g. "2-4% reply rate = 440-880 responses/month")

## 30-Day Action Plan
Broken into weeks. Specific tasks, not vibes.

## Budget Breakdown
Every dollar accounted for across all channels.

## What to Expect
Month 1, Month 3, Month 6 — honest ranges. Not promises, just real benchmarks.

Write like a smart, direct friend who knows this stuff cold. No buzzwords. No hedging. No "it depends" without immediately saying what it depends on.`;

    const mktgMessages = [
      {
        role: "user",
        content: `Project context:\n${ctx}\n\nMy answers to your questions:\n${answers}`
      }
    ];

    const mktgRes = await callAnthropic(MODEL_BUILD, MKTG_SYSTEM, mktgMessages, 8000, true);

    if (!mktgRes.ok) {
      return new Response(JSON.stringify({ error: "Marketing guide failed" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      let totalIn = 0, totalOut = 0, totalCW = 0, totalCR = 0;
      try {
        const reader = mktgRes.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") continue;
            try {
              const ev = JSON.parse(raw);
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                const txt = ev.delta.text || "";
                await writer.write(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: txt })}\n\n`));
              }
              if (ev.type === "message_delta" && ev.usage) {
                totalOut = ev.usage.output_tokens || 0;
              }
              if (ev.type === "message_start" && ev.message?.usage) {
                totalIn = ev.message.usage.input_tokens || 0;
                totalCW = ev.message.usage.cache_creation_input_tokens || 0;
                totalCR = ev.message.usage.cache_read_input_tokens || 0;
              }
            } catch { /* skip malformed */ }
          }
        }
      } catch { /* ignore */ }
      finally {
        if (userId && (totalIn > 0 || totalOut > 0)) {
          try { await incrementUsage(userId, totalIn, totalOut, MODEL_BUILD, totalCW, totalCR); } catch {}
        }
        await writer.write(encoder.encode(`event: done\ndata: {}\n\n`));
        try { await writer.close(); } catch {}
      }
    })();

    return new Response(readable, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }

  // ── CHAT MODE (clarifying questions) ─────────────────────────────────────
  if (body.chat_mode) {
    const messages = body.messages || [];
    const wantStream = body.stream !== false;

    const SYSTEM_CHAT = `You are Vertly's AI — a website builder having a real conversation before jumping into a build.

Think like a smart designer who just heard a brief. What do you actually need to know to build something great? What would you genuinely be guessing at if you started right now?

A name matters — it goes in the title, the nav, the hero. Worth knowing.
The purpose needs to be clear enough that you could describe it back in one sentence.
Design, style, colors, layout — never ask, those are yours to decide.

Talk like a real person. Ask what you actually need, nothing more. If you realize mid-conversation you have enough, just say so and build.`;

    const chatRes = await callAnthropic(
      MODEL_FAST,
      SYSTEM_CHAT,
      messages as { role: string; content: unknown }[],
      400,
      wantStream,
    );

    if (!chatRes.ok) {
      const err = await chatRes.text();
      return new Response(JSON.stringify({ error: err }), {
        status: chatRes.status, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    if (!wantStream) {
      const data = await chatRes.json();
      return new Response(JSON.stringify(data), {
        status: 200, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const emit = async (event: string, data: unknown): Promise<void> => {
      try { await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
    };
    (async () => { try { const r = await streamChat(chatRes, emit); if (userId) await incrementUsage(userId, r.tokensIn, r.tokensOut, MODEL_FAST, r.cacheWrite, r.cacheRead); } catch {} finally { try { await writer.close(); } catch {} } })();
    return new Response(readable, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }

  // ── PAGE MODE ─────────────────────────────────────────────────────────────
  if (body.page_mode) {
    const messages = body.messages || [];
    const files = body.files || {};
    const brief = body.brief || {};
    const spec = body.spec || null;
    const pageName = body.page_name || "page.html";
    const category = inferCategory(brief, messages);
    const guide = getCategoryGuide(category);

    let context = "";
    if (spec) context += specContext(spec);
    else if (Object.keys(brief).length > 0) context += briefContext(brief, guide);
    else context += `\n\n${guide}`;

    // Give the page builder ONLY the pattern playbook for the page type it's making (these were
    // dropped from the fresh landing build to keep that prompt small). Keyed off the page name.
    const pn = pageName.toLowerCase();
    const sectionKey =
      /dash|admin|app|console|portal/.test(pn) ? "SAAS DASHBOARDS" :
      /login|signup|sign-up|signin|sign-in|auth|register|account/.test(pn) ? "AUTH PAGES" :
      /pricing|plans/.test(pn) ? "PRICING PAGES" :
      /waitlist|launch|early/.test(pn) ? "WAITLIST / LAUNCH PAGES" :
      /shop|store|product|cart|checkout/.test(pn) ? "E-COMMERCE" :
      "LANDING / MARKETING PAGES";
    if (PAGE_PATTERN_SECTIONS[sectionKey]) context += `\n\n<page-patterns>\n${PAGE_PATTERN_SECTIONS[sectionKey]}\n</page-patterns>`;

    context += fileContext(files, true);

    const pageMessages = [
      ...messages,
      { role: "user", content: `Build ${pageName} now. Use the tokens and classes in styles.css, keep the same skeleton and visual language as index.html, add the page to the nav in site.js if it belongs there, and make every link work. All sections fully styled and complete, with only real content.\n${context}` }
    ];

    // Haiku for page builds: 4x cheaper than Sonnet, still consistent with existing design
    const pageRes = await callAnthropic(
      MODEL_FAST,
      SYSTEM_PAGE,
      pageMessages as { role: string; content: unknown }[],
      12000,
      true,
    );

    if (!pageRes.ok) {
      const err = await pageRes.text();
      return new Response(JSON.stringify({ error: err }), {
        status: pageRes.status, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const emit = async (event: string, data: unknown): Promise<void> => {
      try { await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
    };
    const pageUsage = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
    const flushPageUsage = makeUsageFlusher(userId, MODEL_FAST, pageUsage);
    const pageHb = setInterval(() => { try { writer.write(encoder.encode(": hb\n\n")); } catch {} flushPageUsage(); }, 8000);
    const pageTask = (async () => { try { await streamBuild(pageRes, files, emit, pageUsage, req.signal); } catch {} finally { clearInterval(pageHb); flushPageUsage(); try { await writer.close(); } catch {} } })();
    try { (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(pageTask); } catch {}
    return new Response(readable, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }

  // ── LIVE USAGE GATE ───────────────────────────────────────────────────────
  // Check DB directly so stale client-side state never lets an over-limit user through.
  if (userId && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      const usageRes = await fetch(
        `${SUPABASE_URL}/rest/v1/account_billing?user_id=eq.${userId}&select=plan,credits_used_cents,trial_ends_at,extra_credits_cents`,
        { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      if (usageRes.ok) {
        const rows = await usageRes.json();
        const p = rows?.[0];
        if (p) {
          const LIMITS = CREDIT_LIMITS_CENTS;
          const basLimit = LIMITS[p.plan as string] || 1500;
          const extra   = (p.extra_credits_cents as number) || 0;
          const limit   = basLimit + extra;
          const used    = (p.credits_used_cents as number) || 0;
          const trialExpired = p.plan === "trial" && p.trial_ends_at && new Date(p.trial_ends_at as string) < new Date();
          if (trialExpired || used >= limit) {
            const msg = trialExpired
              ? "Your free trial has ended. Upgrade to keep building."
              : "You've used all your AI credits for this month. Upgrade your plan to continue.";
            const { readable: r2, writable: w2 } = new TransformStream();
            const wr2 = w2.getWriter();
            await wr2.write(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`));
            await wr2.close();
            return new Response(r2, { headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
          }
        }
      }
    } catch { /* non-blocking — if check fails, proceed and let Anthropic handle it */ }
  }

  // ── BUILD MODE ────────────────────────────────────────────────────────────
  const messages = body.messages || [];
  const files = body.files || {};
  // full_files contains untruncated primary file content for patch application
  // patches are applied server-side so the base must be the real full file
  const fullFiles = (body.full_files as Record<string, string>) || {};
  const filesForPatching = Object.keys(fullFiles).length ? { ...files, ...fullFiles } : files;
  const brief = body.brief || {};
  const spec = body.spec || null;
  const projectId = body.project_id || "";

  const continuationMode = body.continuation_mode === true;
  const htmlFileNames = Object.keys(files).filter(f => f.endsWith('.html'));

  // A continuation must reuse the EXACT prompt shape (fresh-build vs. edit) of the request
  // that started this build. By the time a continuation fires, `files` already contains the
  // partially-written page — so the live checks below would flip from "fresh" to "edit",
  // PAGE_PATTERNS/guide/component-library would appear or vanish from the system prompt, and
  // Anthropic would treat it as new text: a full 1.25x cache-rewrite of the ~10k-token system
  // prompt on every single continuation call instead of a 0.1x cache-read. The client freezes
  // this flag at send-time (before the AI writes anything) and replays it on every continuation.
  const liveHasFiles = Object.keys(files).filter(f => !INTERNAL_FILES.includes(f)).length > 0;
  const liveIsFreshBuild = isDefaultCode({ ...files }) || Object.keys(files).length === 0;
  const frozenFreshBuild = (continuationMode && typeof body.fresh_build_session === "boolean")
    ? body.fresh_build_session
    : null;
  const isFreshBuild = frozenFreshBuild ?? liveIsFreshBuild;
  const hasFiles = frozenFreshBuild !== null ? !frozenFreshBuild : liveHasFiles;

  // ── SHARED CACHED SYSTEM ────────────────────────────────────────────────────
  // Computed BEFORE the gate so the onboarding gate, the actual build, and every continuation all
  // send the IDENTICAL cached system block — only the mode instructions differ (via the non-cached
  // dynamicSuffix). This keeps Anthropic's prompt cache warm across the whole session: one 1.25x
  // write on the first call, then 0.1x reads on every later call (onboarding turns + build + continuation).
  // Previously the gate used a different system than the build/continuation, so each continuation
  // cache-MISSED and paid the full 1.25x rewrite.
  // Freeze the category for the WHOLE session: the client captures it from the first call's
  // build_meta event and replays it on every subsequent call (onboarding turns + build + continuation).
  // Without this, inferCategory re-scans the growing conversation each turn and can flip the category,
  // which changes the cached system block and busts Anthropic's prompt cache → a 1.25x rewrite EVERY
  // call instead of one write + cheap 0.1x reads. (Was the dominant cost — ~$0.05/call × ~5 calls.)
  const category = body.build_category || inferCategory(brief, messages);
  const guide = hasFiles ? "" : getCategoryGuide(category);
  // 1 structural example per category (+2 accent), seeded by project_id so it's byte-stable across
  // the session. Only for fresh builds (where the AI composes from scratch).
  const componentLibrary = !hasFiles
    ? buildComponentLibraryPrompt(categoriesForBuild(category), projectId || "anon", 1)
    : "";
  // The fresh-build cached block (also reused by the gate). Edits use a smaller block (below).
  const freshCachedSystem = SYSTEM_CORE + `\n\n${FRONTEND_CRAFT}\n\n${pagePatternsFor(category)}`
    + (guide ? `\n\n${guide}` : "")
    + (componentLibrary ? `\n\n${componentLibrary}` : "");

  // ── ONBOARDING CHAT GATE ──────────────────────────────────────────────────
  // Runs for fresh builds while there are still < 5 user messages. The AI gathers
  // a brief across up to ~3 back-and-forth turns (name/purpose → monetization →
  // design/pages), then builds. Falls through to the main build path automatically
  // once it has everything or the user says "just build it."
  const userMsgs = (messages as {role:string;content:unknown}[]).filter(m => m.role === "user");
  if (isFreshBuild && userMsgs.length <= 5 && !continuationMode) {
    // Onboarding instructions live in the NON-cached suffix so the cached block stays identical to
    // the build/continuation (cache stays warm across the session). See SHARED CACHED SYSTEM above.
    const ONBOARDING_SUFFIX = `

ONBOARDING — GETTING TO KNOW WHAT THEY'RE BUILDING:
Before building anything, get enough to build something real — but this is a conversation with a person, not a form. Read the user; don't march through a script.

WHAT'S WORTH KNOWING (not a checklist to cover in order — bring up what's actually relevant):
1. NAME + PURPOSE — what is it, who is it for, what does it do. You almost always need this before building.
2. MONETIZATION — will this make money, and how? Don't just hand over a multiple-choice menu — have an actual opinion, like a co-founder would. If they mention a price or a model, react to it: is that priced right for this market, does the model fit how people actually pay for something like this, what do comparable products charge. If they haven't thought about it, offer a concrete starting point with real numbers ("for something like this, people usually land on $X/mo or a one-time fee around $Y — want to start there, or think it through more?") instead of a bare list of options.
3. DESIGN DIRECTION — offer 1-2 specific directions with real references. E.g. "I'm thinking dark and minimal like Linear, or something warmer and more consumer-friendly like Notion. Which feels right — or should I just pick?" Never ask "what style do you want?" open-endedly. Skip this entirely if nothing suggests it matters yet — you don't need permission for taste calls.
4. PAGES — suggest what makes sense for the scope: "For this I'd build landing + pricing + about. Or just the landing page if you want to launch fast. What do you think?"

READ THE ROOM — this matters more than covering every topic above:
Some users already know what they want and are ready to see it: short answers, "yeah", "just build it," a hint of impatience. For them, build fast — fill in whatever's still open yourself, don't make them sit through more questions.
Some users want to think out loud: plan the business, ask what you'd charge, what similar products do, whether the idea even makes sense. For them, stay in it. Give real opinions, push back where you actually disagree, bring up things they haven't considered (a free tier, what the first paying customer looks like, what usually kills something like this). Don't steer toward "let's build" just because the topics above are technically covered — if they're getting value from talking it through, keep going.
Match their energy rather than a fixed number of turns. Don't drag a decisive user through more questions than they need, and don't rush a deliberate one into a build they're not ready for. Keep replies conversational, not a wall of yap — real talk, not padding.

HOW TO ASK WHEN YOU DO ASK:
- One topic per reply, two at most if tightly related (e.g. design + pages).
- Concrete options beat open questions. "Subscriptions or one-time?" beats "How do you want to make money?"
- When suggesting design directions, name actual site references (Linear, Stripe, Vercel, Notion, Airbnb, Figma, etc.) so they can picture it.
- Format multi-part asks as a numbered list with bold topic labels. E.g. "1. **Accounts?** Will students log in to save data, or is this session-only?  2. **Pages?** Just the dashboard, or a landing page too?" This makes it easy to skim.
- Never say "great choice", "perfect", "absolutely" — just absorb what they said and move forward.
- If they say "you decide" or "whatever you think" on anything — make the call yourself and don't revisit it.

TAPPABLE CHOICE CARDS:
When a topic is a pick-between-options choice (design direction, monetization model, which pages, etc.), append a machine-readable card block on its OWN line at the very END of your message — the app turns it into tappable cards:
[[CARDS]]{"options":[{"label":"Dark & minimal","desc":"like Linear","emoji":"🌑"},{"label":"Warm & friendly","desc":"like Notion","emoji":"☀️"}],"allowOther":true}[[/CARDS]]
- Keep the text lead-in to ONE short line (e.g. "Which direction feels right?"). The cards carry the options, so do NOT also spell them out as a numbered/bulleted list when you include cards.
- 2–4 options; each has a short \`label\`, an optional one-line \`desc\` (a real reference or concrete example), and a fitting \`emoji\`. Always set "allowOther":true so they can type their own answer.
- Use cards ONLY for genuine multiple-choice moments — NOT for an open question like the project's name, and NEVER inside a build/file response (onboarding chat only). It must be valid JSON on a single line.

WHEN TO BUILD:
- Once you have enough to build something real — not necessarily every topic above, just enough that you're not guessing on the fundamentals — say one short sentence about what you're making, then output the file immediately.
- If the first message already contains name, purpose, monetization, design, and pages → skip all questions and build right now.
- If the user says "just build it", "start building", "go ahead", or similar → build immediately, no more questions.
- If they're still actively engaged in planning after several exchanges, that's fine — keep going, they're getting value from it. Only nudge toward building if the conversation is circling without new information, and even then frame it as an offer, not a cutoff: "I've got enough to start whenever — want me to build it, or keep talking through [whatever's still open]?"

BUILD THE LANDING PAGE ONLY — NOTHING ELSE:
Even if the plan includes other pages (pricing, about, etc.), your first build writes ONLY the landing page and the shared files: styles.css, index.html, site.js, manifest.json (in that order), then the memory files. Do NOT write pricing.html, about.html, or any other page in this response, and link only to pages that exist (home-page anchors like index.html#pricing are fine for sections on the landing page). After the landing page, end your message by offering the rest in plain language — e.g. "That's your landing page. Want me to add the pricing and about pages next?" The user will ask, and you'll build those one at a time. This keeps each build fast and cheap.

OUTPUT FORMAT:
When building: use <file name="..."> XML delimiters ONLY (the file set described in OUTPUT FORMAT). Never backtick code blocks.
When chatting (still gathering): plain text only. Never put file tags in a chat response.` + (spec ? specContext(spec) : "");

    // prepare: hand the build Worker the onboarding payload to run with no timeout (48k headroom).
    if (prepareMode) {
      return new Response(JSON.stringify({
        kind: "run",
        payload: buildAnthropicPayload(MODEL_BUILD, freshCachedSystem, messages as {role:string;content:unknown}[], 48000, true, ONBOARDING_SUFFIX),
        files_for_patching: files,
        user_id: userId || "",
        category,
        want_suggestions: false,
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const chatRes = await callAnthropic(MODEL_BUILD, freshCachedSystem, messages as {role:string;content:unknown}[], estimateMaxTokens(MODEL_BUILD), true, ONBOARDING_SUFFIX);
    if (chatRes.ok) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const emitChat = async (event: string, data: unknown): Promise<void> => {
        try { await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch {}
      };
      const gateUsage = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
      const flushGateUsage = makeUsageFlusher(userId, MODEL_BUILD, gateUsage);
      const gateHb = setInterval(() => { try { writer.write(encoder.encode(": hb\n\n")); } catch {} flushGateUsage(); }, 8000);
      // Send the frozen category on the FIRST onboarding turn so the client replays it on every
      // later call — keeping the cached system block byte-identical (cache stays warm all session).
      const gateTask = (async () => { try { await emitChat("build_meta", { category }); await streamBuild(chatRes, files, emitChat, gateUsage, req.signal); } catch {} finally { clearInterval(gateHb); flushGateUsage(); try { await writer.close(); } catch {} } })();
      try { (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(gateTask); } catch {}
      return new Response(readable, {
        headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }
  }

  // category, guide, componentLibrary, freshCachedSystem are computed once above (SHARED CACHED SYSTEM).

  // Compress message history — project state files handle the rest
  const compressedMessages = compressMessages(messages as { role: string; content: unknown }[]);

  const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
  const lastUserText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content || "");

  const messagesWithContext = compressedMessages.map((m, i) => {
    if (m.role === "user" && i === compressedMessages.length - 1) {
      const editPrefix = hasFiles && !continuationMode
        ? `[EDIT MODE — ${htmlFileNames.length} page(s). OUTPUT PATCHES ONLY — <file> blocks are BANNED for existing files. Find the specific lines that need changing and output only those as <patch> blocks. If the change is large, output multiple patches. There is no situation where a full file rewrite is acceptable unless the user said "rebuild", "redo", "remake", or "start over." If you output a <file> block and the output gets cut off, the file is destroyed. Use patches. Always patches. Also: every edit must be complete — if a change needs both HTML and CSS, patch both in the same response.\n\nSMALL CONFIG FILES: site.js, manifest.json, _backend, _longterm, _shortterm and _pages are tiny — when a change touches several places in one of them, rewrite it as one complete <file> block (keeping everything that was already there) instead of several patches. This is the one exception to the patches-only rule. Adding sign-up/log-in, a collection or a product to the site means the complete merged _backend file, with "auth": { "enabled": true } when there are accounts.

YOUR CHAT MESSAGE: plain words only — never a file name (login.html, site.js, styles.css), never words like patch, token, config or script; say "the menu", "the sign-up page", "the colors".

WHERE TO PATCH: palette, fonts, spacing, buttons and anything shared → styles.css (the :root block for tokens — never hardcode a color/font/radius anywhere else); navigation, footer and brand → site.js; a page's own content or its own <style> → that page. Changing colors or the name also means patching manifest.json.

EXCEPTION — NEW PAGES: if the user asks to ADD a page that does not exist yet (e.g. a pricing or about page), output ONE complete <file name="thatpage.html"> block for it in the standard skeleton (styles.css + site.js, <header data-vx-nav></header>, <footer data-vx-footer></footer>) AND a patch to site.js adding it to the nav when it belongs there. The patches-only rule applies only to files that already exist; a brand-new file must be a <file> block.\n\nFILES NOT SHOWN IN FULL: Some HTML files are omitted from this context because _pages lists their section map. If the user asks to edit a file you can't see (e.g. schedule.html), you MUST still write the patch — use the section name and line range from _pages to target the right area. NEVER ask the user to share the file or offer to rebuild it. The server applies your patch to the full file regardless of whether you were shown its content. Just write the patch.]\n\n`
        : "";

      let context = "";
      if (!hasFiles && !continuationMode) {
        if (spec) context += specContext(spec);
        else if (Object.keys(brief).length > 0) context += briefContext(brief, guide);
        else context += `\n\n${guide}`;
        // Landing page only on a fresh build — even if the plan lists other pages. Output ONLY
        // index.html, then offer to add the rest in your message. Each extra page is a separate
        // (cheaper) build the user requests on demand. Do NOT write other .html files in this response.
        context += `\n\n[BUILD ONLY the landing page and the shared files — styles.css, index.html, site.js, manifest.json (in that order) plus the memory files. Do NOT create pricing.html, about.html, or any other page now, even if the plan mentions them, and link only to pages that exist. After the landing page, end your message by offering to build the other pages next (e.g. "Want me to add the pricing and about pages?"). The user will ask for them one at a time.]`;
      }

      context += fileContext(files, false, hasFiles);
      context += `\n\n[Output files using <file name="filename"> XML tags ONLY. Never backtick code fences.]`;

      // Preserve vision content blocks — appending context as text block keeps image data intact
      if (Array.isArray(m.content)) {
        const blocks: unknown[] = [];
        if (editPrefix) blocks.push({ type: "text", text: editPrefix });
        blocks.push(...(m.content as unknown[]));
        if (context) blocks.push({ type: "text", text: context });
        return { ...m, content: blocks };
      }
      return { ...m, content: editPrefix + (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) + context };
    }
    return m;
  });

  // Cached system block. Fresh builds reuse the exact `freshCachedSystem` the gate already sent, so
  // the build + every continuation are 0.1x cache reads. Edits use a smaller block (no PAGE_PATTERNS
  // / component library — irrelevant to targeted patches).
  const staticSystem = hasFiles
    ? SYSTEM_CORE + `\n\n${FRONTEND_CRAFT}` + (!isFreshBuild && guide ? `\n\n${guide}` : "")
    : freshCachedSystem;
  const dynamicSuffix = continuationMode
    ? "\n\nCONTINUATION MODE — CRITICAL: You are completing a file that was cut off mid-generation. The last user message gives the file name and the final lines already written.\n\nYou MUST wrap your output in a single <file name=\"EXACT_FILE_NAME\"> … </file> block, using the exact file name from the user message. The <file> wrapper is REQUIRED — text written outside it is shown to the user as raw code in the chat and then discarded, which corrupts the build.\n\nInside the block, write ONLY the code that comes immediately after the last lines shown — continue from precisely where it stopped. Do NOT write <!DOCTYPE html>, the <head>, the nav, or repeat ANY content already shown. Do NOT write a chat message, intro, summary, or the word \"continuing\" — output nothing but the <file> block. Continue to the natural end of the file (…</body></html> for an HTML page) and close with </file>."
    : "";

  // Sonnet for: fresh builds, full-rebuilds, or creating new visual components from scratch.
  // Haiku for: modifying/tweaking things that already exist (colors, text, layout, bugs).
  // Logic: creative verb + visual noun = building something new = needs Sonnet quality.
  // Sonnet only where quality shows most: the first landing build, or an explicit full rebuild.
  // Everything else on an existing site (adding pages/sections, edits) uses cheap Haiku — this is
  // the "Sonnet for the landing, Haiku for extras" cost split. Say "redesign/rebuild" to force Sonnet.
  const forcesSonnet = isFreshBuild || /\b(redesign|rebuild|redo|start\s+over|from\s+scratch)\b/i.test(lastUserText);

  const isSimpleEdit = hasFiles && !forcesSonnet && !continuationMode;

  const buildModel = isSimpleEdit ? MODEL_FAST : MODEL_BUILD;
  // Continuation only writes the tail — 8k is plenty and keeps the call fast.
  // On the build Worker (prepareMode) there's no wall-clock timeout, so give a fresh build big
  // headroom (~48k Sonnet / 16k Haiku) — the whole page fits in ONE call and never has to continue.
  const maxTokens = continuationMode
    ? 8000
    : (prepareMode ? (buildModel === MODEL_FAST ? 16000 : 48000) : estimateMaxTokens(buildModel));

  // prepare: return the assembled payload for the Worker to run with no timeout.
  if (prepareMode) {
    return new Response(JSON.stringify({
      kind: "run",
      payload: buildAnthropicPayload(buildModel, staticSystem, messagesWithContext as { role: string; content: unknown }[], maxTokens, true, dynamicSuffix),
      files_for_patching: filesForPatching,
      user_id: userId || "",
      category,
      is_continuation: continuationMode,
      want_suggestions: true,
      suggestion_messages: messages,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const anthropicRes = await callAnthropic(
    buildModel,
    staticSystem,
    messagesWithContext as { role: string; content: unknown }[],
    maxTokens,
    true,
    dynamicSuffix,
  );

  if (!anthropicRes.ok) {
    const err = await anthropicRes.text();
    return new Response(JSON.stringify({ error: err }), {
      status: anthropicRes.status, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerClosed = false;
  const safeWrite = async (chunk: Uint8Array) => {
    if (writerClosed) return;
    try { await writer.write(chunk); } catch { writerClosed = true; }
  };
  const safeClose = async () => {
    if (writerClosed) return;
    writerClosed = true;
    try { await writer.close(); } catch {}
  };
  const emit = async (event: string, data: unknown): Promise<void> => {
    await safeWrite(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Live usage mirror — streamBuild updates this as tokens arrive, so usage is recorded even if the
  // client hits Stop mid-stream (previously totals were only known after streamBuild returned, so an
  // early Stop billed nothing).
  const usageAcc = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };

  // Bill incrementally as tokens arrive (every heartbeat) so an interruption can't bypass usage.
  const flushUsage = makeUsageFlusher(userId, buildModel, usageAcc);

  const bgTask = (async () => {
    const heartbeat = setInterval(() => {
      safeWrite(encoder.encode(": heartbeat\n\n"));
      flushUsage(); // commit usage-so-far every 8s — survives Stop/refresh/timeout-kill
    }, 8000);

    try {
      // Hand the resolved category to the client up front so it can freeze it and replay it on
      // every continuation of this build — keeping the cached system prompt byte-identical (0.1x reads).
      await emit("build_meta", { category });
      const { files: builtFiles, message: builtMessage } = await streamBuild(anthropicRes, filesForPatching, emit, usageAcc, req.signal);

      // Auto-fix disabled: adds a second API call per build without meaningful quality gain.
      // The reduced max_tokens (24k) already produces tighter, better output.

      // Generate follow-up suggestions — skip if the client already disconnected (Stop)
      if (!req.signal?.aborted) {
        try {
          const sugg = await generateSuggestions(builtMessage || "", builtFiles, messages as {role:string;content:unknown}[], userId);
          if (sugg.length) await emit("suggestions", { items: sugg });
        } catch {}
      }
    } catch {}
    finally {
      clearInterval(heartbeat);
      flushUsage(); // final delta (tokens since the last heartbeat flush)
      await safeClose();
    }
  })();

  // Keep the isolate alive after the client disconnects so the usage-tracking finally always runs.
  // Without this, a Stop could tear the function down before usage was recorded.
  try { (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(bgTask); } catch {}

  return new Response(readable, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
});