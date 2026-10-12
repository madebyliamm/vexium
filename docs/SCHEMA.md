# Database overview (snapshot 2026-10-12)

Full DDL, policies and functions: `supabase/schema.sql` (reference snapshot, not a migration — regenerate with `python3 scripts/export-schema.py`). All tables have RLS ON. Row counts are approximate and tiny: the DB is effectively pre-launch (5 profiles, 9 projects).

| table | rows | purpose |
|---|---|---|
| profiles | 5 | one per account: username, display name, bio, avatar/banner, **plan + credits + Stripe ids** (billing state lives here), follower counts |
| projects | 9 | a user's site: `files` jsonb (working copy), `published_files` jsonb + `published_slug`/`published_at` (live copy), `main_file`, `custom_domain*`, `ai_context`, AI edit lock (`ai_lock_*`), legacy per-project Stripe Connect cols. `id` is TEXT (`proj_<ts>_<rand>`) |
| project_members | 0 | collaborators (role, status) |
| project_backups | 2 | named restore slots (`files` jsonb) |
| ai_messages | 213 | chat history per project (+ sender name for collab) |
| plan_messages | 0 | **unused** (looks like an earlier planning-chat attempt) |
| build_jobs | 118 | persisted AI build requests so a refresh can resume |
| site_data | 1 | generated sites' data: rows of `(project_id, collection, data jsonb, site_user_id)` — forms, orders, `transactions` (Stripe sales) |
| site_users | 0 | end-customers of generated sites (email + password_hash + metadata) |
| page_views | 904 | analytics events from `track` |
| follows / notifications | 3 / 4 | social graph + notifications |
| billing_history | 18 | billing events shown in settings |
| feedback | 1 | in-app feedback |

Storage: 1 bucket (see schema.sql). Extensions listed at top of schema.sql.

## Things to know
- `profiles` is both the PUBLIC profile and the PRIVATE billing record — see SECURITY_FINDINGS #3.
- `log_usage()` references columns/tables that don't exist (`tokens_monthly_limit`, `overage_tokens`, `usage_log`) → dead; real usage tracking is `increment_usage()` writing `credits_used_cents`.
- The generated-site backend (`site_data`/`site_users`) is a generic JSON store keyed by `project_id`; the `_backend` file in a project's `files` declares collections/products but the server does NOT currently enforce it.
