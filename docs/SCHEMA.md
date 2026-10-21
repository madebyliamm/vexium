# Database overview (snapshot 2026-10-12; Step 7 additions 2026-10-14; Step 8 `stage_messages` 2026-10-21)

Full DDL, policies and functions: `supabase/schema.sql` (reference snapshot, not a migration — regenerate with `python3 scripts/export-schema.py`). All tables have RLS ON. Row counts are approximate and tiny: the DB is effectively pre-launch (5 profiles, 9 projects).

| table | rows | purpose |
|---|---|---|
| profiles | 5 | one per account, PUBLIC data only: username, display name, bio, avatar/banner, follower counts, prefs. `email` is private (column-revoked); `public_email` mirrors it only while `show_email` is on |
| account_billing | 5 | **private** per-account billing/usage state: plan, trial_ends_at, credits, extra credits, billing period, Stripe customer/subscription/Connect ids. Own-row SELECT only; every write is service-role (webhook, ai-chat usage, `handle_new_user`) |
| projects | 9 | a user's site (Step 7: `stage` = where the user is in plan→example→build→tweaks→launch→business; changed only via `set_project_stage()`): `files` jsonb (working copy), `published_files` jsonb + `published_slug`/`published_at` (live copy), `main_file`, `custom_domain*`, `ai_context`, AI edit lock (`ai_lock_*`), legacy per-project Stripe Connect cols. `id` is TEXT (`proj_<ts>_<rand>`) |
| project_members | 0 | collaborators (role, status) |
| project_deploys | – | **(Hosting v2, migration `20261012131000`)** one row per publish: `version` (unique per project), `status` (`uploading`/`ready`/`failed`), `main_file`, `file_count`, `total_bytes`, and the parsed `_backend` (never served; read by `stripe-site-checkout`, later `site-api`). The files themselves are in R2 at `p/<project_id>/v<version>/…`. Clients may only SELECT (owner / accepted collaborator); all writes are the publisher Worker (service role) |
| project_backups | 2 | named restore slots (`files` jsonb) |
| ai_messages | 213 | chat history per project (+ sender name for collab) |
| plan_messages | 0 | **unused** (looks like an earlier planning-chat attempt) |
| build_jobs | 118 | persisted AI build requests so a refresh can resume. **Step 7** adds the stage-run columns `stage`, `artifact_kind`, `finished_at`, `error`, `heartbeat_at` (platform-only: clients may INSERT only `project_id,user_id,status,prompt` and UPDATE only `status`, which is all the old editor does) and `status` ∈ running/complete/failed |
| project_artifacts | – | **Step 7.** Versioned stage artifacts `(project_id, kind, version, data jsonb, stale, created_by)`; kinds plan / style_spec / manifest / launch_checks / business_state. Clients SELECT only (owner / accepted collaborator); every write is `put_project_artifact()` / `keep_project_artifact()`. View `project_artifacts_latest` = newest per kind. See `docs/STAGES.md` |
| stage_messages | – | **Step 8.** Chat history of the guided stages `(project_id, stage, role, content, user_id, job_id, created_at)`. Written only by the platform (service role) — the user's line when a stage run is prepared, the assistant's when it succeeds; unique `(job_id, role)`. Clients: SELECT only (owner + accepted collaborators). Separate from the legacy `ai_messages` on purpose (the old editor replays those to the model) |
| site_data | 1 | generated sites' data: rows of `(project_id, collection, data jsonb, site_user_id)` — forms, orders, `transactions` (Stripe sales) |
| site_users | 0 | end-customers of generated sites (lower-cased email + `pbkdf2$sha256$<iters>$<salt>$<hash>` + metadata ≤ 4 KB); `password_hash` is hidden from clients |
| site_sessions | 0 | **Step 4.** Site-user login sessions: `token_hash` (sha256 of an opaque `vxs_…` token), project, user, `expires_at` (30 days). Service role only (RLS on, no policies); cascades with the site user / project |
| rate_limits | – | **Step 4.** Fixed-window counters `(key, window_start, hits)` behind `vx_rate_hit(key, window_s, limit, cost)` (service role only). Pruned opportunistically |
| page_views | 904 | analytics events from `track` |
| follows / notifications | 3 / 4 | social graph + notifications |
| billing_history | 18 | billing events shown in settings |
| feedback | 1 | in-app feedback |

Storage: 1 bucket (see schema.sql). Extensions listed at top of schema.sql.

## Things to know
- Public vs private split (since REVAMP Step 2, migration `20261012120000_security_lockdown.sql`): `profiles` = public, `account_billing` = private. Clients may only UPDATE `username, display_name, bio, avatar_url, banner, show_email, show_usage_warning, advanced_mode` on their own profile and SELECT the columns granted in the migration — **there is no `SELECT *` on `profiles`, and a NEW profile column is invisible to clients until it is added to the GRANT lists.**
- Signup: the auth.users trigger `handle_new_user` creates the `profiles` row AND the `account_billing` row (7-day trial set server-side; `selected_plan` taken from signup metadata only if it is one of trial/starter/pro/max).
- `vexium_site_query` (SQL tab) is service-role only and runs the owner's SELECT in `vx_sandbox.run()`, owned by the no-privilege role `vexium_sql_ro`, against TEMP copies of that project's `site_data` / `site_users` (no password_hash). Step 4 deliberately kept it (verified secure, 85/85); the scalable replacement is a structured query endpoint in Step 13.
- Migrations live in `supabase/migrations/` (applied by hand with `supabase db query --linked -f`); verification scripts in `supabase/tests/`. `schema.sql` only covers the `public` schema + storage, so it does not show the `vx_sandbox` schema or the `vexium_sql_ro` role.
- `log_usage()` references columns/tables that don't exist (`tokens_monthly_limit`, `overage_tokens`, `usage_log`) → dead; real usage tracking is `increment_usage()` writing `credits_used_cents`.
- **Publishing (Hosting v2):** `projects.published_version` is the live pointer into `project_deploys` (NULL = legacy site still served from `published_files`). Rollback = move the pointer; unpublish = clear `published_slug`/`published_version`. Only the publisher Worker (service role) writes `published_version`; a trigger blocks API roles from writing it and from writing `custom_domain*` (the `custom-domain` edge function owns those). `custom_domain` is unique case-insensitively. `resolve_published_site(p_username, p_slug, p_host)` (anon-callable) is how the Worker maps a request to a project/version; it ignores a pointer whose deploy is not `ready`.
- **projects write access (migration `20261012130000`):** UPDATE = owner or accepted collaborator, DELETE = owner only, `anon` has no write privilege, and API roles cannot change `user_id`.
- The generated-site backend (`site_data`/`site_users`) is a generic JSON store keyed by `project_id`. Since Step 4 `site-api` ENFORCES the project's `_backend` (collections, `read`/`write` access, `fields` allowlist, `max_rows`, `notify_owner`, `auth.enabled`) — see `docs/STEP4_DESIGN.md`. `site_data` has CHECKs (collection `^[a-z0-9_-]{1,40}$`, row ≤ 16 KB) as a backstop.
