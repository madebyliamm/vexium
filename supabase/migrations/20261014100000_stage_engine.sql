-- Vertly REVAMP Step 7 — the stage engine.
--
--   projects.stage          where the user is in PLAN → EXAMPLE → BUILD → TWEAKS → LAUNCH → BUSINESS (explicit, user-controlled)
--   project_artifacts       versioned artifacts each stage saves for the next one (plan, style_spec, manifest, launch_checks,
--                           business_state) with a `stale` flag: editing an upstream artifact marks everything downstream stale
--   put_project_artifact()  the ONLY write path for artifacts (new version + stale-marking + pruning, atomic)
--   keep_project_artifact() "this stale artifact is still fine" — clears the flag without making a new version
--   set_project_stage()     moves the stage: going back is always allowed; going forward needs the earlier artifacts fresh
--   build_jobs              + stage/artifact columns so a refreshed studio can resume a stage run that is still going
--
-- The rules live in ONE place: the jsonb literal in vx_stage_rules() below. supabase/functions/_shared/stages.ts mirrors it and
-- supabase/tests/stages.test.ts fails if the two ever differ (it extracts the literal from the function body below).
--
-- Security shape (Step 2/3 lessons): clients get SELECT on artifacts through RLS (owner or ACCEPTED collaborator) and nothing
-- else — every write goes through the SECURITY DEFINER RPCs, which re-check access from the JWT. Some kinds can only be written
-- by the platform (service role): manifest / launch_checks / business_state are outputs of server-side work, so a client can't
-- forge a "verifier passed" record. `projects.stage` can't be written directly by API roles (trigger), only via the RPC.
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261014100000_stage_engine.sql
-- Verify:  supabase db query --linked -f supabase/tests/step7_stage_engine.sql        (always rolls back)

BEGIN;

-- ── 1. the rules (single source of truth) ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.vx_stage_rules() RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$ SELECT $json$
{
  "stages": ["plan", "example", "build", "tweaks", "launch", "business"],
  "kinds": ["plan", "style_spec", "manifest", "launch_checks", "business_state"],
  "requires": {
    "plan": [],
    "example": ["plan"],
    "build": ["plan", "style_spec"],
    "tweaks": ["plan", "style_spec", "manifest"],
    "launch": ["plan", "style_spec", "manifest", "launch_checks"],
    "business": []
  },
  "requires_published": ["business"],
  "required_flags": { "style_spec": "locked" },
  "downstream": {
    "plan": ["style_spec", "manifest", "launch_checks"],
    "style_spec": ["manifest", "launch_checks"],
    "manifest": ["launch_checks"],
    "launch_checks": [],
    "business_state": []
  },
  "client_writable": ["plan", "style_spec"],
  "client_keepable": ["plan", "style_spec", "manifest"],
  "max_versions": 20,
  "max_bytes": 262144
}
$json$::jsonb $fn$;

-- Lookup helpers. Internal: only the SECURITY DEFINER RPCs below (and tests running as postgres) call them.
CREATE OR REPLACE FUNCTION public.vx_stage_rank(p_stage text) RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (t.ord - 1)::integer FROM jsonb_array_elements_text(public.vx_stage_rules() -> 'stages') WITH ORDINALITY AS t(v, ord) WHERE t.v = p_stage
$$;

-- Who is calling? Raises unless the caller may work on this project. Returns true for the platform itself (service role / a
-- direct postgres session) and false for a signed-in owner or ACCEPTED collaborator. Strangers and "not found" get the SAME
-- error so a project id can't be probed.
CREATE OR REPLACE FUNCTION public.vx_stage_access(p_project text) RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  r   text := coalesce(auth.role(), 'postgres');
  uid uuid := auth.uid();
BEGIN
  IF r IN ('anon', 'authenticated') THEN
    IF uid IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.projects p
       WHERE p.id = p_project
         AND (p.user_id = uid OR EXISTS (
               SELECT 1 FROM public.project_members m
                WHERE m.project_id = p.id AND m.user_id = uid AND m.status = 'accepted'))
    ) THEN
      RAISE EXCEPTION 'project not found or not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project) THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN true;
END $$;

-- What stops `p_project` from entering `p_stage` right now? '[]' = nothing. Each entry: {kind, reason} with reason
-- missing | stale | flag:<name> (e.g. flag:locked), kind = an artifact kind or 'published'.
CREATE OR REPLACE FUNCTION public.vx_stage_blockers(p_project text, p_stage text) RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  rules   jsonb := public.vx_stage_rules();
  result  jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', t.k, 'reason', t.reason) ORDER BY t.ord), '[]'::jsonb)
    INTO result
    FROM (
      SELECT r.k, r.ord,
             CASE
               WHEN a.version IS NULL THEN 'missing'
               WHEN a.stale THEN 'stale'
               WHEN (rules -> 'required_flags' ->> r.k) IS NOT NULL
                    AND coalesce(a.data ->> (rules -> 'required_flags' ->> r.k), '') <> 'true'
                 THEN 'flag:' || (rules -> 'required_flags' ->> r.k)
             END AS reason
        FROM jsonb_array_elements_text(rules -> 'requires' -> p_stage) WITH ORDINALITY AS r(k, ord)
        LEFT JOIN LATERAL (
          SELECT x.version, x.stale, x.data FROM public.project_artifacts x
           WHERE x.project_id = p_project AND x.kind = r.k ORDER BY x.version DESC LIMIT 1
        ) a ON true
    ) t
   WHERE t.reason IS NOT NULL;

  IF (rules -> 'requires_published') ? p_stage
     AND NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project AND published_version IS NOT NULL) THEN
    result := result || jsonb_build_array(jsonb_build_object('kind', 'published', 'reason', 'missing'));
  END IF;
  RETURN result;
END $$;

-- ── 2. projects.stage ────────────────────────────────────────────────────────────────────────────────────────
-- Existing projects start at 'plan' (no data migration: they were built in the old editor and have no artifacts).
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'plan';
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_stage_check;
ALTER TABLE public.projects ADD CONSTRAINT projects_stage_check
  CHECK (stage IN ('plan', 'example', 'build', 'tweaks', 'launch', 'business'));

-- API roles (anon/authenticated) can't set the stage directly — a client could otherwise jump straight to LAUNCH. They go
-- through set_project_stage(), a SECURITY DEFINER function, inside which current_user is the function owner. The service role
-- (edge functions / Worker) and direct postgres sessions are not restricted. New rows made by API roles always start at 'plan'.
CREATE OR REPLACE FUNCTION public.projects_guard_stage() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' AND NEW.stage IS DISTINCT FROM 'plan' THEN
      RAISE EXCEPTION 'a new project starts at the plan stage' USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE' AND NEW.stage IS DISTINCT FROM OLD.stage THEN
      RAISE EXCEPTION 'the project stage is changed with set_project_stage()' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.projects_guard_stage() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS projects_guard_stage ON public.projects;
CREATE TRIGGER projects_guard_stage BEFORE INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.projects_guard_stage();

-- ── 3. project_artifacts ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_artifacts (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  project_id  text        NOT NULL,
  kind        text        NOT NULL,
  version     integer     NOT NULL,
  data        jsonb       NOT NULL,
  stale       boolean     NOT NULL DEFAULT false,
  created_by  uuid,                       -- NULL = written by the platform (AI run / verifier)
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_artifacts_pkey PRIMARY KEY (id),
  CONSTRAINT project_artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects (id) ON DELETE CASCADE,
  CONSTRAINT project_artifacts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT project_artifacts_version_key UNIQUE (project_id, kind, version),
  CONSTRAINT project_artifacts_kind_check CHECK (kind IN ('plan', 'style_spec', 'manifest', 'launch_checks', 'business_state')),
  CONSTRAINT project_artifacts_version_check CHECK (version > 0),
  CONSTRAINT project_artifacts_data_check CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 262144)
);

ALTER TABLE public.project_artifacts ENABLE ROW LEVEL SECURITY;

-- Read: the owner and ACCEPTED collaborators (a pending invite sees nothing). No INSERT/UPDATE/DELETE policy exists on purpose.
DROP POLICY IF EXISTS project_artifacts_select ON public.project_artifacts;
CREATE POLICY project_artifacts_select ON public.project_artifacts AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.projects p
     WHERE p.id = project_artifacts.project_id
       AND (p.user_id = (SELECT auth.uid()) OR EXISTS (
             SELECT 1 FROM public.project_members m
              WHERE m.project_id = p.id AND m.user_id = (SELECT auth.uid()) AND m.status = 'accepted'))
  ));

-- Supabase's default privileges hand new tables to anon/authenticated in full; take everything back, then grant the one thing.
REVOKE ALL ON public.project_artifacts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.project_artifacts TO authenticated;
GRANT ALL ON public.project_artifacts TO service_role;

-- Latest version of each kind (what the studio shows). security_invoker: the caller's RLS applies to the underlying table.
CREATE OR REPLACE VIEW public.project_artifacts_latest WITH (security_invoker = true) AS
  SELECT DISTINCT ON (project_id, kind) id, project_id, kind, version, data, stale, created_by, created_at
    FROM public.project_artifacts
   ORDER BY project_id, kind, version DESC;
REVOKE ALL ON public.project_artifacts_latest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.project_artifacts_latest TO authenticated;
GRANT ALL ON public.project_artifacts_latest TO service_role;

-- ── 4. the RPCs ──────────────────────────────────────────────────────────────────────────────────────────────
-- Save a new version of an artifact. Marks the latest version of every downstream kind stale. p_expected_version (optional) is
-- optimistic concurrency: it must equal the current latest version (0 = "none yet") or the call fails with 40001 — SUPERSEDED by
-- 20261014120000_stage_conflict_errcode.sql, which raises PT409 instead (40001 hangs PostgREST).
CREATE OR REPLACE FUNCTION public.put_project_artifact(
  p_project text, p_kind text, p_data jsonb, p_expected_version integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rules   jsonb := public.vx_stage_rules();
  trusted boolean;
  cur     integer;
  v       integer;
  staled  text[];
BEGIN
  trusted := public.vx_stage_access(p_project);
  IF p_kind IS NULL OR NOT ((rules -> 'kinds') ? p_kind) THEN
    RAISE EXCEPTION 'unknown artifact kind: %', coalesce(p_kind, '(null)') USING ERRCODE = '22023';
  END IF;
  IF NOT trusted AND NOT ((rules -> 'client_writable') ? p_kind) THEN
    RAISE EXCEPTION 'artifact kind % is written by the platform', p_kind USING ERRCODE = '42501';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'artifact data must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_data::text) > (rules ->> 'max_bytes')::integer THEN
    RAISE EXCEPTION 'artifact is too large (max % bytes)', rules ->> 'max_bytes' USING ERRCODE = '54000';
  END IF;

  -- One writer per project at a time: version numbers and stale flags stay consistent.
  PERFORM pg_advisory_xact_lock(hashtextextended('vx_artifacts:' || p_project, 0));

  SELECT coalesce(max(version), 0) INTO cur FROM public.project_artifacts WHERE project_id = p_project AND kind = p_kind;
  IF p_expected_version IS NOT NULL AND p_expected_version <> cur THEN
    RAISE EXCEPTION 'version conflict: % is at version % (expected %)', p_kind, cur, p_expected_version USING ERRCODE = '40001';
  END IF;
  v := cur + 1;

  INSERT INTO public.project_artifacts (project_id, kind, version, data, created_by)
  VALUES (p_project, p_kind, v, p_data, CASE WHEN trusted THEN NULL ELSE auth.uid() END);

  WITH latest AS (
    SELECT DISTINCT ON (a.kind) a.id, a.kind, a.stale
      FROM public.project_artifacts a
     WHERE a.project_id = p_project
       AND a.kind IN (SELECT jsonb_array_elements_text(rules -> 'downstream' -> p_kind))
     ORDER BY a.kind, a.version DESC
  ), flagged AS (
    UPDATE public.project_artifacts a SET stale = true
      FROM latest l WHERE a.id = l.id AND NOT l.stale
    RETURNING a.kind
  )
  SELECT coalesce(array_agg(kind ORDER BY kind), '{}') INTO staled FROM flagged;

  DELETE FROM public.project_artifacts
   WHERE project_id = p_project AND kind = p_kind AND version <= v - (rules ->> 'max_versions')::integer;

  RETURN jsonb_build_object('kind', p_kind, 'version', v, 'staled', to_jsonb(staled));
END $$;

-- "Keep this as it is": clears the stale flag on the latest version (no new version, nothing downstream changes).
CREATE OR REPLACE FUNCTION public.keep_project_artifact(p_project text, p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rules   jsonb := public.vx_stage_rules();
  trusted boolean;
  latest  integer;
  cleared boolean := false;
BEGIN
  trusted := public.vx_stage_access(p_project);
  IF p_kind IS NULL OR NOT ((rules -> 'kinds') ? p_kind) THEN
    RAISE EXCEPTION 'unknown artifact kind: %', coalesce(p_kind, '(null)') USING ERRCODE = '22023';
  END IF;
  IF NOT trusted AND NOT ((rules -> 'client_keepable') ? p_kind) THEN
    RAISE EXCEPTION 'artifact kind % must be regenerated by the platform', p_kind USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vx_artifacts:' || p_project, 0));

  SELECT max(version) INTO latest FROM public.project_artifacts WHERE project_id = p_project AND kind = p_kind;
  IF latest IS NOT NULL THEN
    UPDATE public.project_artifacts SET stale = false
     WHERE project_id = p_project AND kind = p_kind AND version = latest AND stale;
    cleared := FOUND;
  END IF;
  RETURN jsonb_build_object('kind', p_kind, 'version', latest, 'cleared', cleared);
END $$;

-- Move the project to another stage. Going back (or staying) is always allowed. Going forward needs every artifact the target
-- stage requires to exist, be fresh (not stale) and carry its required flags (see vx_stage_rules); BUSINESS needs a live site.
-- Returns {ok, stage, blocked_by:[{kind,reason}]} — a refusal is a normal result, not an error.
CREATE OR REPLACE FUNCTION public.set_project_stage(p_project text, p_stage text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur     text;
  blocked jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.vx_stage_access(p_project);
  IF public.vx_stage_rank(p_stage) IS NULL THEN
    RAISE EXCEPTION 'unknown stage: %', coalesce(p_stage, '(null)') USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vx_artifacts:' || p_project, 0));

  SELECT stage INTO cur FROM public.projects WHERE id = p_project;
  IF public.vx_stage_rank(p_stage) > public.vx_stage_rank(cur) THEN
    blocked := public.vx_stage_blockers(p_project, p_stage);
  END IF;
  IF jsonb_array_length(blocked) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'stage', cur, 'blocked_by', blocked);
  END IF;

  IF cur IS DISTINCT FROM p_stage THEN
    UPDATE public.projects SET stage = p_stage WHERE id = p_project;
  END IF;
  RETURN jsonb_build_object('ok', true, 'stage', p_stage, 'blocked_by', '[]'::jsonb);
END $$;

-- Signed-in users and the platform may call the three RPCs; everyone else (anon) may not. The internal helpers are not exposed.
REVOKE EXECUTE ON FUNCTION public.put_project_artifact(text, text, jsonb, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.keep_project_artifact(text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_project_stage(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.put_project_artifact(text, text, jsonb, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.keep_project_artifact(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_project_stage(text, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.vx_stage_rules() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vx_stage_rank(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vx_stage_access(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vx_stage_blockers(text, text) FROM PUBLIC, anon, authenticated;

-- ── 5. build_jobs: resume a stage run after a refresh ────────────────────────────────────────────────────────
-- The old editor keeps inserting {project_id,user_id,status,prompt} and flipping status → complete. Stage runs add four
-- columns written ONLY by the platform (column-level grants below), so a client can't mint a "stage job" and use it to get an
-- artifact written (the stage_done path in ai-chat only trusts jobs that have `stage` set).
ALTER TABLE public.build_jobs ADD COLUMN IF NOT EXISTS stage text;
ALTER TABLE public.build_jobs ADD COLUMN IF NOT EXISTS artifact_kind text;
ALTER TABLE public.build_jobs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE public.build_jobs ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE public.build_jobs DROP CONSTRAINT IF EXISTS build_jobs_status_check;
ALTER TABLE public.build_jobs ADD CONSTRAINT build_jobs_status_check CHECK (status IN ('running', 'complete', 'failed'));
ALTER TABLE public.build_jobs DROP CONSTRAINT IF EXISTS build_jobs_stage_check;
ALTER TABLE public.build_jobs ADD CONSTRAINT build_jobs_stage_check
  CHECK (stage IS NULL OR stage IN ('plan', 'example', 'build', 'tweaks', 'launch', 'business'));
ALTER TABLE public.build_jobs DROP CONSTRAINT IF EXISTS build_jobs_artifact_kind_check;
ALTER TABLE public.build_jobs ADD CONSTRAINT build_jobs_artifact_kind_check
  CHECK (artifact_kind IS NULL OR artifact_kind IN ('plan', 'style_spec', 'manifest', 'launch_checks', 'business_state'));
CREATE INDEX IF NOT EXISTS build_jobs_project_idx ON public.build_jobs (project_id, created_at DESC);

REVOKE ALL ON public.build_jobs FROM PUBLIC, anon, authenticated;
GRANT INSERT (project_id, user_id, status, prompt) ON public.build_jobs TO authenticated;
GRANT UPDATE (status) ON public.build_jobs TO authenticated;
GRANT SELECT, DELETE ON public.build_jobs TO authenticated;
GRANT ALL ON public.build_jobs TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
