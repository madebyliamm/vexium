-- REVAMP Step 7 (addendum) — put_project_artifact: report an optimistic-concurrency conflict as SQLSTATE PT409.
--
-- The first version raised 40001 (serialization_failure). Through PostgREST that code made the request HANG until the gateway timed
-- out (504 after ~60 s; found by the live e2e, reproduced with a probe) — presumably PostgREST treats 40001 as retryable. A
-- 'PTnnn' SQLSTATE is PostgREST's own convention for "answer with HTTP nnn", so the conflict now arrives instantly as a clean 409.
-- Nothing else changes; the body below is the whole function.
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261014120000_stage_conflict_errcode.sql
-- Verify:  supabase db query --linked -f supabase/tests/step7_stage_engine.sql        (always rolls back)

BEGIN;

-- Save a new version of an artifact. Marks the latest version of every downstream kind stale. p_expected_version (optional) is
-- optimistic concurrency: it must equal the current latest version (0 = "none yet") or the call fails with SQLSTATE PT409 (PostgREST turns that into HTTP 409).
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
    RAISE EXCEPTION 'version conflict: % is at version % (expected %)', p_kind, cur, p_expected_version USING ERRCODE = 'PT409';
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

COMMIT;

NOTIFY pgrst, 'reload schema';
