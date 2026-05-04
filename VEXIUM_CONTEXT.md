# VEXIUM — Complete Project Context
> Read this file before touching any code. It covers everything: what Vexium is, how it works, the full file structure, design system, current state, known bugs/fixes, and the future roadmap.

---

## 1. What Is Vexium?

Vexium is a **browser-based, AI-powered website and code editor** that lets non-technical users describe what they want and have it built automatically — with live preview, hosting, custom domains, analytics, and payments built in.

**Core pitch:** "Describe your idea, watch it build, start earning."

**Target audience:** Non-technical founders, entrepreneurs, and creators aged 16–28 who want to build and monetize websites without touching code or hiring a developer.

**Strategic posture:** Vexium must always present itself as a large, established company — not a solo founder project. Every touchpoint (UI copy, marketing, brand voice) should feel like a well-funded team built it.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Code editor | Monaco Editor (VS Code's editor, CDN) |
| Backend / Auth / DB | Supabase (Postgres + Auth + Storage) |
| AI inference | Supabase Edge Functions (`index.ts`) calling an LLM API |
| Font | Plus Jakarta Sans (Google Fonts) |
| Mono font | JetBrains Mono / Fira Code |
| Hosting | Supabase-hosted edge functions + static file serving |

**Supabase config:**
```
URL:  https://ciuqhxrxcznmgorjeumz.supabase.co
ANON KEY: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...  (in config.js)
```

---

## 3. File Structure

```
/
├── config.js           ← Supabase URL + anon key (never commit secrets here in prod)
├── index.html          ← Public marketing/landing page
├── auth.html           ← Sign up / Sign in page
├── home.html           ← Dashboard (project list, social graph, notifications)
├── editor.html         ← THE MAIN APP — AI chat + Monaco editor + live preview
├── profile.html        ← User profile page
├── viewer.html         ← Public project viewer (iframe-based)
├── vexium_logo.png     ← Logo (white/light version)
├── vexium_logo_black.png ← Logo (dark version)
├── logo_background.png ← Favicon source
└── index.ts            ← Supabase Edge Function — handles all AI calls
```

---

## 4. Design System (Dark Monochrome)

All pages share the same CSS token set. **Never deviate from these.**

```css
:root {
  --bg:       #0a0a0a;   /* true near-black page background */
  --surface:  #141414;   /* cards, panels, topbar */
  --surface2: #1c1c1c;   /* elevated surfaces, hover states */
  --border:   #262626;   /* default border */
  --border2:  #333333;   /* slightly more visible border */
  --border3:  #444444;   /* strong border, focus rings */
  --accent:   #ffffff;   /* primary accent = pure white */
  --accent2:  #888888;   /* secondary accent */
  --text:     #ffffff;   /* body text */
  --muted:    #666666;   /* placeholders, captions */
  --err:      #f87171;   /* errors (red) */
  --warn:     #fbbf24;   /* warnings (amber) */
  --ok:       #4ade80;   /* success (green) */
  --sans:     'Plus Jakarta Sans', sans-serif;
  --mono:     'JetBrains Mono', 'Fira Code', monospace;

  /* Border radius scale */
  --r-sm:   6px;
  --r-md:   10px;
  --r-lg:   14px;
  --r-xl:   20px;
  --r-full: 999px;

  /* Transition shorthands */
  --t-fast:   100ms ease;
  --t-normal: 200ms ease;

  /* Z-index scale */
  --z-topbar:  50;
  --z-overlay: 500;
  --z-modal:   2000;
  --z-toast:   9999;
}
```

**Design rules:**
- Dark background always. Never light mode.
- White is the only accent color. No blues, no purples, no brand colors.
- Scrollbars: 5–6px, transparent track, `--border2` thumb, rounded.
- `-webkit-font-smoothing: antialiased` on `html, body`.
- All interactive states: subtle `--surface2` background on hover, `--border2` border transitions.
- Border radius: consistent use of `--r-sm` through `--r-full`. Pill buttons use `--r-full`.

---

## 5. editor.html — The Core App

This is the heart of Vexium. It contains:

### Layout
```
#topbar          ← 48px sticky bar: logo | project name | mode toggle | publish | user avatar
#workbench       ← flex row: sidebar + mainPanel
  #sidebar       ← file tree + add/upload controls
  #mainPanel
    #editorArea
      #editorPane   ← Monaco editor (hidden in AI mode)
      #aiPanel      ← AI chat interface (visible by default)
    #previewPane  ← live iframe preview (shown when preview is toggled)
```

### Mode System
- **AI mode** (`modeAI`): Shows the AI chat panel. Monaco is hidden.
- **Editor mode** (`modeEditor`): Shows Monaco editor. AI panel is hidden.
- Mode persisted to `localStorage` as `vexium_last_mode`.

### File System
- `fileSystem` object: `{ 'index.html': '...', 'style.css': '...', ... }`
- `mainFile`: currently active/preview file (default `index.html`)
- `dirtyFiles`: Set of filenames with unsaved changes
- Files saved to Supabase `projects` table (column: `files` JSONB) or localStorage fallback

### AI Chat System
- History stored in `aiHistory` array: `[{ role: 'user'|'assistant', content: '...' }]`
- All AI requests go through `aiCallAPI()` → POST to Edge Function `AI_EDGE_URL`
- Streaming response: SSE (Server-Sent Events) parsed token by token
- **Critical rule:** ALL user messages route directly to `aiCallAPI()`. Do NOT add intent detection, readiness checks, or routing logic before `aiCallAPI` — this caused a bug where AI responses appeared in chat instead of the editor.

### AI File Writing
- The AI responds with file blocks in a specific format parsed client-side
- Pills (`aiPillMap`) show file names being written with live line counts
- `aiAbortController` allows stop mid-generation

### Step System
- Complex builds use a multi-step plan (`_stepPlan`)
- Steps shown in `#aiStepHeader` dropdown
- `_currentStep` tracks progress; `renderNextStepCard()` shows the continue button

### Templates
- 5 default templates: SaaS, Portfolio, Online Store, Agency, Restaurant
- User can add custom templates (stored in localStorage)
- Templates shown in `#aiTemplates` only when project is in default/empty state

### Preview
- Live iframe (`#previewFrame`) with `sandbox="allow-scripts allow-same-origin allow-modals allow-forms allow-popups"`
- `refreshPreview()` injects full HTML with resolved asset URLs
- Preview toggle button in topbar

### Monaco Editor
- Language auto-detected from file extension
- Font: JetBrains Mono, size 13, line height 22
- Word wrap on, minimap off, tab size 2, smooth scrolling/cursor animations
- `bracketPairColorization` enabled

### Collaborators
- Users can be added as collaborators on a project
- Collaborator list stored in Supabase project row
- **Known fixed bug:** Collaborator save had a race condition — resolved.

### Topbar UI Details
- Logo: `vexium_logo.png` (20×20px, border-radius 4px) + "VEXIUM" text
- Project name (`#tbProj`): editable inline
- Status bar (`#stMode`): shows "Cloud" or "Local"
- Avatar: white circle, black initials only (no image upload — removed)
- Stop button: cancels AI generation via `aiAbortController.abort()`

---

## 6. home.html — Dashboard

- Lists all user projects as cards (emoji + name + last modified)
- "New project" modal with emoji picker + name input
- **Find users** search bar (searches Supabase `profiles` table)
- Social graph: following / followers
- Shared projects section
- Notifications bell
- Friends/discover slider
- Topbar: logo | search | avatar (initials only, white bg, black text)

---

## 7. auth.html — Authentication

- Two tabs: Sign Up / Sign In
- Username + password only (no email required)
- Uses Supabase auth with fake domain trick: appends `@vexium.ai` to username to create valid email for Supabase's email-based auth
- Guest mode: `localStorage.setItem('vexium_guest', true)` — skips auth
- On successful auth: redirects to `home.html`
- Already-logged-in check on load (redirects immediately)

---

## 8. profile.html

- Displays user's public profile
- Shows display name, username, public projects
- Avatar: initials only (white bg, black text) — image upload removed
- Topbar uses same dark `--surface` background as rest of app
- Follow/unfollow button for other users

---

## 9. index.ts — Supabase Edge Function (AI Backend)

- Receives POST with `{ messages, files, brief? }`
- Authenticates request (checks Supabase JWT)
- Builds system prompt that:
  - Describes Vexium's file-writing protocol
  - **Strictly prohibits technical jargon** (no variable names, CSS terms, code references in chat messages)
  - Instructs AI to write in plain, friendly language
  - Tells AI how to output file blocks for client parsing
- Calls LLM API (streaming)
- Returns SSE stream back to client

---

## 10. Supabase DB Schema (Key Tables)

```sql
profiles
  id          uuid (references auth.users)
  username    text
  display_name text
  is_public   boolean
  show_usage_warning boolean

projects
  id          uuid
  user_id     uuid
  name        text
  emoji       text
  files       jsonb  -- { 'index.html': '...', ... }
  main_file   text
  is_public   boolean
  collaborators uuid[]

chat_history
  id          uuid
  project_id  uuid
  role        text ('user' | 'assistant')
  content     text
  file_names  text[]
  created_at  timestamptz

follows
  follower_id uuid
  following_id uuid
```

---

## 11. Pricing Model

| Plan | Price (monthly) | Price (annual) | Key limits |
|---|---|---|---|
| **Free** | $0 | $0 | 1 project, 3-day trial of full features, no card |
| **Starter** | $12/mo | $10/mo | 3 projects, custom domain, no payments/AI-in-site |
| **Pro** | $29/mo | $23/mo | Unlimited projects, Stripe payments, user accounts, AI-in-site, analytics, marketing guidance |
| **Max** | $79/mo | $63/mo | Everything in Pro + white label, client management, team collab, priority support, custom integrations, advanced analytics |

**Revenue share:** 5% on payments processed through user's Vexium sites (all plans).
**Annual billing:** saves 20%, billed once per year.

---

## 12. Features (Implemented or Planned)

### ✅ Implemented
- AI chat → file generation (streaming, multi-file)
- Monaco code editor with syntax highlighting
- Live preview iframe
- File tree (create, rename, delete, upload images)
- Multi-file project system
- Supabase auth (username/password)
- Cloud save + localStorage fallback
- Collaborators
- Public/private project toggle
- Follow/unfollow users
- Find users search
- Template system (5 defaults + custom)
- Step-based build system for complex projects
- Stop button (abort generation)
- User message actions (redo, edit, copy)
- Usage warning modal (with "don't show again" preference)
- Dark context menus
- Avatar: initials only (no upload)
- Profile topbar dark background
- Inline code highlighting stripped from AI chat output

### 🔲 Planned / Future
- **Stripe payments integration** — users can add Stripe to their published sites via Vexium dashboard
- **User accounts on published sites** — auth system for sites users build
- **AI inside your site** — embed AI chatbots/generators into published projects
- **Analytics dashboard** — visitor counts, traffic sources, conversion events
- **Marketing guidance AI** — analyzes your site and gives specific growth advice
- **Custom domain connection** — point your own domain to your Vexium subdomain
- **One-click publish** — deploy to `yourname.vexium.ai` instantly
- **White label (Max plan)** — remove all Vexium branding for agency use
- **Client management (Max plan)** — manage multiple client projects from one dashboard
- **Real-time collaboration** — multiple cursors, live editing, shared AI chat
- **Advanced analytics** — heatmaps, session recordings, funnel analysis
- **Mobile app** (long term)
- **Vexium marketplace** — sell templates or AI-built sites to other users

---

## 13. Known Bugs Fixed (Do Not Reintroduce)

1. **AI output appearing in chat instead of editor** — was caused by an intent/readiness/plan detection block before `aiCallAPI`. Fix: removed that block entirely. All requests now go directly to `aiCallAPI()`.
2. **Avatar showing colored background with initials** — fixed to white background, black initials only.
3. **Profile topbar wrong background** — fixed to `--surface` (#141414).
4. **Inline code highlights in AI chat** — AI system prompt now explicitly prohibits code blocks in conversational responses.
5. **Collaborator save race condition** — fixed.
6. **Context menu light theme** — fixed to dark tokens.
7. **File capsule label overflow** — fixed.
8. **Find-users search bar** — implemented in home.html.
9. **Stop button signal handling** — `AbortController` wired correctly through to edge function.
10. **User message actions (redo/edit/copy)** — implemented on hover.

---

## 14. AI System Prompt Rules

The Edge Function system prompt enforces:
- No variable names in chat messages (e.g., don't say `const x =` or `div.container`)
- No CSS property names (don't say "I set the `padding`")
- No technical jargon — speak like a friendly product, not an IDE
- Plain English only: "I made the button bigger" not "I increased the padding on `.btn`"
- File writing uses a specific delimiter format the client parses

---

## 15. Marketing Strategy

### Brand voice
- Large, established company feel — never solo founder
- Aspirational, lifestyle-oriented — sell freedom and income, not features
- Tagline energy: "Describe your idea, watch it build, start earning."

### Content channels
- **Official YouTube:** Cinematic, polished, product trailers and demos
- **Faceless YouTube/TikTok:** High-energy, entertaining, ironic, relatable content
- **TikTok (primary viral engine):** Aspirational lifestyle — analytics screens, city lights, viral audio, financial freedom angle
- **Reddit:** Authentic launch posts framed as a founder sharing something real (not ads)

### Launch plan
- Pre-build 15–20 short-form videos before launch to maintain posting consistency during post-launch firefighting
- Official trailer lives on YouTube, pinned to TikTok, submitted to Reddit on launch day
- Target: ~1,500–2,000 paying customers and meaningful MRR within first 2 months, pre-paid-ads

---

## 16. Working With This Codebase

### Conventions
- All JS is vanilla, no build step, no bundler
- Supabase client loaded via CDN: `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`
- Monaco loaded via AMD require from `https://cdn.jsdelivr.net/npm/monaco-editor@0.50.0/min/vs/loader.js`
- `config.js` loaded with `onerror="window._noConfig=true"` — always check `window._noConfig` before using Supabase
- Always init Supabase like:
  ```js
  let sb = null;
  try {
    if (!window._noConfig && typeof supabase !== 'undefined' && typeof SUPABASE_URL !== 'undefined')
      sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch(e) {}
  ```

### Adding a new page
1. Copy topbar HTML from `home.html` or `editor.html`
2. Apply full `:root` token block at top of `<style>`
3. Include `config.js` script + Supabase CDN + auth check
4. Match scrollbar, font-smoothing, and base resets exactly

### Modifying AI behavior
- All AI prompt logic lives in `index.ts` (Edge Function)
- Client-side: `aiCallAPI()` in `editor.html` — do not add routing logic before this function
- To change what AI says in chat vs. what goes to the editor: edit the system prompt in `index.ts`

### Saving projects
- Always save to both Supabase (if session exists) and localStorage as fallback
- Project structure: `{ id, name, emoji, files: {}, main_file: 'index.html', is_public: false, collaborators: [] }`

---

## 17. Environment Notes

- No build pipeline — changes to HTML/CSS/JS files are live immediately
- Edge Function (`index.ts`) must be deployed to Supabase after changes: `supabase functions deploy`
- `config.js` contains public anon key — this is fine (Supabase RLS handles security)
- All pages are in the same flat directory (no subdirectory routing)
