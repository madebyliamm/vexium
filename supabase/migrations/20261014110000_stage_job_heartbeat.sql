-- REVAMP Step 7 (addendum) — build_jobs.heartbeat_at.
-- A stage run keeps going in the build Worker after the browser disconnects (a refresh), so the studio resumes by looking at the
-- job row. A Worker that was killed leaves its row 'running' forever; the Worker therefore stamps heartbeat_at every ~8 s and the
-- studio treats a 'running' job with no recent heartbeat as dead instead of showing a phantom "still working". Platform-only
-- column: clients have no INSERT/UPDATE grant on it (see 20261014100000_stage_engine.sql, section 5), only the table-level SELECT.
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261014110000_stage_job_heartbeat.sql
-- Verify:  supabase db query --linked -f supabase/tests/step7_stage_engine.sql        (always rolls back)

BEGIN;
ALTER TABLE public.build_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
COMMIT;

NOTIFY pgrst, 'reload schema';
