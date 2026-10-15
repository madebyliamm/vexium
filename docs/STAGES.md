# The stage engine (REVAMP Step 7)

The backbone of the guided flow **PLAN → EXAMPLE → FULL BUILD → TWEAKS → LAUNCH → BUSINESS**. Stages are **explicit state the user controls** (never inferred from a message). Each stage saves an **artifact** the next stage reads, instead of replaying chat history.

Steps 8–13 build the screens and the real prompts on top of this. What exists today: the database, the rules, the AI endpoint *skeletons*, the resume mechanism and a thin studio project page. The per-stage prompts in `ai-chat/stages.ts` are deliberately short placeholders.

## Rules (one source of truth)

`projects.stage` ∈ `plan, example, build, tweaks, launch, business` (default `plan`; existing projects start at `plan`, no data migration).

| artifact kind | made by | client (member) may write | may "keep" while stale | marked stale when upstream changes |
|---|---|---|---|---|
| `plan` | PLAN stage (AI proposes, user edits) | yes | yes | — |
| `style_spec` | EXAMPLE stage (user locks it: `locked: true`) | yes | yes | plan |
| `manifest` | FULL BUILD / TWEAKS (what was built) | **no — platform** | yes | plan, style_spec |
| `launch_checks` | the launch verifier | **no — platform** | **no — re-run** | plan, style_spec, manifest |
| `business_state` | BUSINESS (server-computed) | **no — platform** | no | never (computed from live data) |

* **Going back or staying is always allowed.** Going forward to stage S needs every artifact in `requires[S]` to exist, be **fresh** (not stale) and carry its required flag (`style_spec.locked` must be true wherever the style is required). `business` needs no artifacts, only a live site (`projects.published_version` set).
  `requires`: example←plan · build←plan,style_spec · tweaks←plan,style_spec,manifest · launch←…+launch_checks · business←(live site).
* Saving a new version of an artifact marks the **latest version of every downstream kind stale** (`downstream` = transitive closure of "built from"). The stage the user is in is **never yanked away**; the way forward just closes until they "keep" or redo.
* "Platform" = service role (edge functions / Worker). Reason: a client must not be able to forge a "verifier passed" record or a built-site manifest.
* Versions: each save is a new row `(project_id, kind, version)`; the newest 20 are kept (`max_versions`), each ≤ 256 KB (`max_bytes`).

**The rules live in the jsonb literal in `vx_stage_rules()`** (migration `20261014100000_stage_engine.sql`). `supabase/functions/_shared/stages.ts` mirrors it and `supabase/tests/stages.test.ts` **fails if the two differ**. To change a rule: edit the SQL literal (new migration with `CREATE OR REPLACE FUNCTION vx_stage_rules`), edit `STAGE_RULES` in `_shared/stages.ts`, run both test suites.

## Database

* `projects.stage` — a trigger stops API roles writing it directly (and from inserting a project that isn't at `plan`); only `set_project_stage()` (SECURITY DEFINER) or the service role can.
* `project_artifacts(id, project_id, kind, version, data jsonb, stale, created_by, created_at)` — RLS: SELECT for the owner and **accepted** collaborators; **no** client INSERT/UPDATE/DELETE (privileges revoked). View `project_artifacts_latest` (security_invoker) = newest version per kind.
* RPCs (all re-check access from the JWT; `anon` has no EXECUTE; strangers and "no such project" get the identical error so ids can't be probed):
  * `put_project_artifact(p_project, p_kind, p_data, p_expected_version?)` → `{kind, version, staled[]}`. `p_expected_version` = optimistic concurrency (0 = "none yet"); a mismatch raises SQLSTATE **`PT409`** → HTTP 409.
  * `keep_project_artifact(p_project, p_kind)` → `{kind, version, cleared}`.
  * `set_project_stage(p_project, p_stage)` → `{ok, stage, blocked_by:[{kind, reason}]}`. A refusal is a normal result (`ok:false`), not an error. `reason` = `missing` | `stale` | `flag:locked`; `kind` may be `published`.
* `build_jobs` gained `stage, artifact_kind, finished_at, error, heartbeat_at`. **Column-level grants**: clients may only INSERT `project_id,user_id,status,prompt` and UPDATE `status` (exactly what the old editor does), so only the platform can create a *stage* job. `status` ∈ running/complete/failed.
* Tests: `supabase/tests/step7_stage_engine.sql` (127 checks, always rolls back; the same scenario tables are replayed in `stages.test.ts`).

## AI endpoints (`ai-chat` stage mode — skeleton)

Additive: only requests with `stage`/`stage_done`/`stage_cancel` reach it; the old editor's paths (incl. the onboarding gate, which the old editor still needs until Step 14) are untouched. Logic is pure + unit-tested (`ai-chat/stages.ts`, `ai-chat/stage-handler.ts`, `supabase/tests/ai_stages.test.ts`); `index.ts` only wires it.

| request (as the signed-in user) | does |
|---|---|
| `{stage, project_id, messages, prepare:true}` — sent to the **build Worker**, which asks ai-chat to prepare | checks access (owner/accepted member) → **input artifacts exist, fresh, style locked** (else `409 stage_inputs` + `blocked_by`) → credit gate (`402 usage_limit`) → creates the `build_jobs` row → returns the Anthropic payload + `job` |
| `{stage_done:{job_id, ok, message, error}}` — sent by the **Worker** when the run ends, with header `x-vx-worker-key` = the service key it holds (**403 without it**: any signed-in user may `prepare` a run themselves, so without this a client could "report" any text and have it saved as an artifact) | job must be the caller's, a stage job, still running → parse the reply, **validate** the artifact, save it via `put_project_artifact` (as platform) → close the job. Unusable output saves nothing and fails the job with a reason |
| `{stage_cancel:{job_id}}` — the studio's Stop button | closes a running job as `Stopped` (idempotent). The Worker notices on its next heartbeat and aborts the generation |

Direct (non-prepare) stage calls get `400 use_worker`.

**Prompt-cache layout:** the cached system block = stage instructions + the stage's **input** artifacts (upstream, frozen, canonical JSON with sorted keys) → byte-identical across turns. The artifact the stage is *editing* (`worksOn`) changes every turn, so it goes in the non-cached suffix with the project name. Tests assert this.

**Output protocol:** the reply ends with `[[ARTIFACT]]` + one complete JSON object + `[[/ARTIFACT]]` (shape spelled out in the cached block); everything else is chat. `normalizeArtifact` drops the `null`s models like to write; `validateArtifact` (`_shared/artifacts.ts`) is the semantic gate; a model can **never** lock a style (`locked` is forced to `false` — locking is the owner's decision).

SSE events of a stage run (via the Worker): `stage_job {job_id, stage}` first → the usual `start/delta/message/done` → `stage_done {ok, artifact:{kind,version,staled}|null, error?}` **last**.

## Resume after refresh

A run keeps going in the Worker after the browser disconnects (stage runs are aborted only when their job row is closed, unlike legacy builds which stop on disconnect). The Worker saves the result server-side (`stage_done`) and stamps `build_jobs.heartbeat_at` every ~8 s. A reloaded studio reads the latest stage job: `running` with a heartbeat < 45 s old ⇒ "Still working…" (polls every 4 s, offers Stop); a `running` job whose heartbeat went silent is dead and is not shown as live; a recent `failed` job's error is shown once.

**Limit (decide in Steps 9/10):** Cloudflare's `ctx.waitUntil` only extends a disconnected request by **30 s**. That comfortably covers PLAN-sized runs (Haiku, ≤ 4k tokens, ~6 s — verified live), but a multi-minute FULL BUILD whose browser disconnects would be cut off after 30 s and its job left to go silent. The long stages need a Queue / Durable Object / Workflow to run server-side; the job + heartbeat + `stage_done` contract here stays the same.

## Studio

`studio/src/lib/stages.ts` and `studio/src/types/artifacts.ts` re-export the shared modules (`supabase/functions/_shared/stages.ts`, `artifacts.ts`) — the studio imports from outside `studio/` (Vite dev has `server.fs.allow` for it). View logic: `lib/stage-view.ts` (pure, tested). I/O: `api/stages.ts` (`getStageState`, `saveArtifact`, `keepArtifact`, `moveToStage`, `cancelStageRun`). UI: `components/StageStepper.tsx`, `components/StagePanel.tsx`, `routes/Project.tsx`. The guided screens of Steps 8–12 plug in at the top of `StagePanel`.

## Adding things
* **A new artifact kind:** add it to the rules literal (`kinds`, `downstream`, `client_writable`…) + the `CHECK` lists in a migration (`project_artifacts_kind_check`, `build_jobs_artifact_kind_check`), `ARTIFACT_KINDS`/`DEPENDS_ON`/types/validator in `_shared`, then tests.
* **A real stage prompt (Steps 8–11):** replace `STAGE_BRIEF[stage]` (+ `STAGE_RUN` model/budget, `ARTIFACT_SHAPES`) in `ai-chat/stages.ts`; keep inputs in the cached block and the working artifact in the suffix. A stage that produces files adds its own finisher next to `finishStage`.

## Gotchas
* **Never `RAISE … ERRCODE '40001'` in an RPC PostgREST serves** — the request hangs until the gateway answers 504 (found by the live e2e, ~60 s). Use `PT409` (PostgREST's "`PTnnn` → HTTP nnn" convention). Migration `20261014120000`.
* Inside a SECURITY DEFINER function `current_user` is the owner while `auth.role()` still reflects the caller's JWT — the stage guard trigger uses `current_user`, the RPC access checks use the JWT claims.
* `jsonb` objects print keys ordered by length then bytes — compare JSON, not strings, in tests (`expect()` in the SQL test does).

## Evidence (2026-10-14/15)
`supabase/tests/step7_stage_engine.sql` 127/127 on prod (and a mutation run: 3 deliberate bugs → 23 failures); `node --test supabase/tests/stages.test.ts supabase/tests/ai_stages.test.ts cf-worker/test/stage_report.test.ts` ; `node scripts/step7_stage_e2e.mjs` (live Worker + ai-chat + DB, real AI: guards, a real PLAN run saved as `plan v1`, a real EXAMPLE run saved as an unlocked style, stale-marking, 409 conflicts, **disconnect mid-run → still saved**, Stop saves nothing); `node studio/test/browser_e2e.mjs` (real Chrome: stepper, blocked/open/past states, Continue/Back, stale flags, Keep as is, running/stopped/dead job banners, no overflow at 390 px).
