-- REVAMP Step 10 — FULL BUILD storage: the build's progress checklist (build_steps) and the one atomic, platform-only way to
-- commit a finished site (commit_site_build).
--
-- build_steps: one row per unit of work in a build (prepare shared files · one per page · repair rounds · verify · save). The build
-- runs as a Cloudflare Workflow (cf-worker/workflow.ts) that calls ai-chat once per step; ai-chat writes the row. Why a table and not
-- a field on build_jobs: the pages are built in PARALLEL, so one jsonb "progress" column would be a read-modify-write that loses
-- updates; one row per step means every writer touches only its own row. The studio reads the rows (RLS: owner + accepted
-- collaborators, like project_artifacts) and polls them to draw the checklist.
--   `output` holds what the model wrote for a page until the build is committed. It is NOT readable by clients (column grant), and
--   nothing else is ever written by a client: the table has no INSERT/UPDATE/DELETE policy, and the privileges are revoked.
--
-- commit_site_build(project, files, remove): writes ALL files of a finished build in one statement — pages, shared files, and the
-- `_backend` rules (set_project_files refuses `_backend` and caps a call at 20 files). Platform only (service_role): a client must
-- not be able to write `_backend` through here (it decides who may read and write a site's data). `remove` deletes stale pages
-- (pages an earlier build made that the plan no longer has) in the same statement, so a project is never half-built.
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261022100000_full_build.sql
-- Verify:  supabase db query --linked -f supabase/tests/step10_full_build.sql        (always rolls back)

BEGIN;

CREATE TABLE IF NOT EXISTS public.build_steps (
  id          uuid          NOT NULL DEFAULT gen_random_uuid(),
  job_id      uuid          NOT NULL,
  project_id  text          NOT NULL,
  seq         integer       NOT NULL,
  kind        text          NOT NULL,
  file        text,
  label       text          NOT NULL,
  status      text          NOT NULL DEFAULT 'pending',
  attempt     integer       NOT NULL DEFAULT 0,
  detail      text,
  cost_cents  numeric(10,2) NOT NULL DEFAULT 0,
  output      text,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT build_steps_pkey PRIMARY KEY (id),
  CONSTRAINT build_steps_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.build_jobs (id) ON DELETE CASCADE,
  CONSTRAINT build_steps_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects (id) ON DELETE CASCADE,
  CONSTRAINT build_steps_job_seq_key UNIQUE (job_id, seq),
  CONSTRAINT build_steps_kind_check CHECK (kind IN ('prepare', 'page', 'fix', 'verify', 'save')),
  CONSTRAINT build_steps_status_check CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  CONSTRAINT build_steps_label_check CHECK (char_length(label) BETWEEN 1 AND 200),
  CONSTRAINT build_steps_output_check CHECK (output IS NULL OR char_length(output) <= 600000)
);

-- "Show me the newest build's checklist" (the studio asks for the steps of the latest job of a project).
CREATE INDEX IF NOT EXISTS build_steps_project_idx ON public.build_steps (project_id, created_at DESC);

ALTER TABLE public.build_steps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS build_steps_select ON public.build_steps;
CREATE POLICY build_steps_select ON public.build_steps AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.projects p
     WHERE p.id = build_steps.project_id
       AND (p.user_id = (SELECT auth.uid()) OR EXISTS (
             SELECT 1 FROM public.project_members m
              WHERE m.project_id = p.id AND m.user_id = (SELECT auth.uid()) AND m.status = 'accepted'))
  ));

-- Supabase's default privileges hand new tables to anon/authenticated in full; take everything back, then grant the readable columns
-- (every column except `output`: the model's page text stays on the server until the build is committed).
REVOKE ALL ON public.build_steps FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, job_id, project_id, seq, kind, file, label, status, attempt, detail, cost_cents, started_at, finished_at, created_at)
  ON public.build_steps TO authenticated;
GRANT ALL ON public.build_steps TO service_role;

CREATE OR REPLACE FUNCTION public.commit_site_build(p_project text, p_files jsonb, p_remove jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k       text;
  v       jsonb;
  n       integer := 0;
  total   bigint  := 0;
  gone    text[]  := '{}';
BEGIN
  -- true = platform (service role / postgres). A signed-in user gets false (or an error for a stranger) and is refused below.
  IF NOT public.vx_stage_access(p_project) THEN
    RAISE EXCEPTION 'commit_site_build is for the platform only' USING ERRCODE = '42501';
  END IF;
  IF p_files IS NULL OR jsonb_typeof(p_files) <> 'object' THEN
    RAISE EXCEPTION 'files must be a JSON object of name -> text' USING ERRCODE = '22023';
  END IF;
  IF p_remove IS NULL OR jsonb_typeof(p_remove) <> 'array' THEN
    RAISE EXCEPTION 'remove must be a JSON array of file names' USING ERRCODE = '22023';
  END IF;

  FOR k, v IN SELECT key, value FROM jsonb_each(p_files) LOOP
    n := n + 1;
    IF k !~ '^([A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|css|js|json)|_backend)$' THEN
      RAISE EXCEPTION 'file name not allowed: %', left(k, 80) USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v) <> 'string' THEN
      RAISE EXCEPTION 'file % must be text', k USING ERRCODE = '22023';
    END IF;
    IF length(v #>> '{}') > 600000 THEN
      RAISE EXCEPTION 'file % is too large', k USING ERRCODE = '54000';
    END IF;
    total := total + length(v #>> '{}');
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'nothing to commit' USING ERRCODE = '22023'; END IF;
  IF n > 80 OR total > 6000000 THEN
    RAISE EXCEPTION 'too many or too large files in one build' USING ERRCODE = '54000';
  END IF;

  -- Only plain pages can be removed, and never one this same build writes.
  FOR k IN SELECT jsonb_array_elements_text(p_remove) LOOP
    IF k !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html$' THEN
      RAISE EXCEPTION 'only pages can be removed: %', left(k, 80) USING ERRCODE = '22023';
    END IF;
    IF NOT (p_files ? k) THEN gone := gone || k; END IF;
  END LOOP;
  IF coalesce(array_length(gone, 1), 0) > 80 THEN
    RAISE EXCEPTION 'too many files to remove' USING ERRCODE = '54000';
  END IF;

  -- One UPDATE = one atomic step: the stale pages go and the new files arrive together; everything else (images, memory files) stays.
  UPDATE public.projects SET files = (coalesce(files, '{}'::jsonb) - gone) || p_files WHERE id = p_project;
  RETURN jsonb_build_object(
    'saved',   (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb) FROM jsonb_object_keys(p_files) AS key),
    'removed', to_jsonb(gone)
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.commit_site_build(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_site_build(text, jsonb, jsonb) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
