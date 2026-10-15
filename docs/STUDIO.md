# Vertly Studio (`studio/`) — the new app

Vite + TypeScript + Preact. Built in CI and served at **`https://vexium.ai/studio/`** next to the legacy static pages (which are untouched and keep their URLs). Generated *user* sites are NOT built with this — they stay build-free HTML/CSS/JS (see `docs/PROJECT_FORMAT.md`).

## Commands (run in `studio/`)
| | |
|---|---|
| `npm install` | first time. **iCloud:** afterwards run `rm -rf node_modules.nosync && mv node_modules node_modules.nosync && ln -s node_modules.nosync node_modules` — npm replaces the symlink with a real dir, and iCloud evicts files in real `node_modules` ("Resource deadlock avoided"). `*.nosync` is skipped by iCloud and gitignored. |
| `npm run dev` | http://localhost:5173/studio/ . A dev-only Vite plugin also serves the legacy root files (`/auth.html`, `/config.js`, logos) so you can sign in through the real `auth.html` on the same origin and share its session. |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 7, strict + `noUncheckedIndexedAccess` + `erasableSyntaxOnly`). |
| `npm test` | `node --test test/*.test.ts` — Node strips the TS itself, no test framework. |
| `npm run build` | → `studio/dist/` (base `/studio/`). |
| `node scripts/assemble-site.mjs` | (repo root) builds `_site/` = what Pages publishes. |
| `node studio/test/browser_e2e.mjs` | real-Chrome e2e of the assembled site (local server) or the live site (`E2E_BASE=https://vexium.ai`). Needs Chrome + `supabase` CLI + `dangerouslyDisableSandbox`; creates/deletes a throwaway user. Screenshots in `/tmp/studio-e2e/`. |

## Layout
```
studio/
  index.html            Vite entry (fonts, favicon, #app)
  vite.config.ts        base '/studio/' (must equal STUDIO_PATH — a test checks), preact preset, dev legacy-static plugin
  src/
    main.tsx            imports tokens.css + base.css, starts the session, renders <App/>
    app.tsx             THE AUTH GUARD + route table (hash routes). Add a route = one line in ROUTES.
    styles/tokens.css   THE token source (canonical light theme). Components use var(--…) only — never raw colors.
    styles/base.css     reset + topbar/page/card/button/grid/stage/diagnostics styles
    lib/config.ts       every URL/key the app needs (Supabase URL + anon key, AI_EDGE_URL, AI_BUILD_URL, PUBLISH_API, LEGACY links)
    lib/supabase.ts     the ONE supabase-js client (default storage key ⇒ session shared with legacy pages)
    lib/session.ts      session store, toUserInfo, signInUrl/redirectToSignIn, signOut
    lib/store.ts        createStore() — tiny observable store (pure);  lib/use-store.ts = the Preact hook
    lib/router.ts       parseHash / matchPattern / resolveRoute / link (pure);  lib/use-route.ts = hook + navigate()
    lib/use-async.ts    loader hook {loading|error|ready, reload}
    api/http.ts         authedFetch (apikey + bearer, ONE refresh+retry on 401), postJson, ApiError, errorMessage
    api/sse.ts          SseParser — chunking-independent (tested at every split point, CRLF included)
    api/ai.ts           BuildRequest, BuildEvent union, streamBuild() async generator, collectBuild()/applyBuildEvent() → BuildResult
    api/deps.ts         wires AuthDeps to the live Supabase session (the only api file that imports supabase)
    api/data.ts         typed reads: listMyProjects, getProject, getMyBilling (explicit columns only)
    api/stages.ts       stage engine I/O (Step 7): getStageState, saveArtifact, keepArtifact, moveToStage, cancelStageRun — see docs/STAGES.md
    lib/stages.ts, types/artifacts.ts   re-exports of supabase/functions/_shared/{stages,artifacts}.ts (ONE shared source with the edge functions)
    lib/stage-view.ts   pure view logic for the project page (stepper steps, artifact cards, job liveness) — tested
    api/system.ts       zero-cost connectivity checks used by /system
    components/, routes/  Topbar, Splash, StageStepper, StagePanel; Home (#/), Project (#/p/:id — stepper + stage panel), System (#/system), NotFound
  test/                 *.test.ts (unit, `npm test`), browser_e2e.mjs (manual/CI-optional)
```

## Conventions
- **Relative imports end in `.ts`/`.tsx`** (`allowImportingTsExtensions`): that is what lets Node run the same modules in tests. No enums/namespaces/parameter properties (`erasableSyntaxOnly`).
- Pure logic lives in framework-free modules (`store`, `router`, `sse`, `http`, `ai`, `format`) so it is unit-tested under Node; hooks/components are thin wrappers. Modules that import `supabase.ts` (via `deps.ts`, `session.ts`, `data.ts`) are not imported by tests.
- **Routes are in the URL hash** (`/studio/#/p/abc`): GitHub Pages has no SPA fallback, so there are no real sub-paths. `supabase-js` is created with `detectSessionInUrl:false` so a hash route is never mistaken for an auth callback.
- **Auth:** sign-in/up stays on the legacy `/auth.html`. The guard (app.tsx) sends signed-out visitors to `/auth.html?next=<studio URL>`; `auth.html` honours `next` only for `/studio/…` paths (open-redirect safe, tested in `test/auth-next.test.ts` against the real function). Billing is read from `account_billing` (own row), never `profiles`; never `select('*')` on `profiles`.
- **Drift guards** (`test/config.test.ts`): the anon key must equal `config.js` + both `wrangler.toml`; `AI_BUILD_URL`/`PUBLISH_API` must equal editor.html's; vite `base` must equal `STUDIO_PATH`.
- The studio imports pure modules from OUTSIDE `studio/` (`../../../supabase/functions/_shared/…`); `vite.config.ts` has `server.fs.allow` for the dev server and the Pages workflow checks out the whole repo, so builds just work. Never put a Node/Deno-only API in `_shared`.
- Build/AI protocol: the SSE event names and request fields in `api/ai.ts` mirror `cf-worker/core.ts` / `worker.ts` and what editor.html sends — change the server first, then the types.

## Deploy pipeline
`.github/workflows/static.yml` (push to `main`): checkout → Node 24 → `npm ci` → typecheck → test → build → `scripts/assemble-site.mjs` → upload `_site/` → deploy Pages. A type error or failing test blocks the deploy. `.github/workflows/ci.yml` runs the same checks (plus the platform unit suites) on PRs and non-main branches.

**What Pages publishes is an allowlist** (`scripts/assemble-site.mjs`): root files with extensions `.html .js .css .png .jpg .jpeg .gif .webp .svg .ico .webmanifest .txt`, `sdk/v1.js`, and `studio/dist` → `/studio/`. Everything else (docs/, supabase/, publisher/, cf-worker/, scripts/, REVAMP.md, `studio/src`…) is NOT served. (Before Step 6 the whole repo was published, so `vexium.ai/REVAMP.md` and `vexium.ai/docs/SECURITY_FINDINGS.md` were reachable — `browser_e2e.mjs` now asserts they 404.) A new root file with another extension is listed under "not shipped" by the script; add the extension to `PUBLIC_ROOT_EXT` if it should be public. **Note: the GitHub repo itself is public** (`madebyliamm/vexium`), so anything committed is readable there regardless.

## Rollback
Revert the commit on `main` (the workflow redeploys the previous site), or re-run an older successful "Deploy static content to Pages" run from the Actions tab. The legacy pages are byte-identical in `_site/` to the repo root, so they are unaffected by studio changes.
