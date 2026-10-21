-- REVAMP Step 9 — set_project_files(): the one atomic way for the guided flow to write site files into projects.files.
--
-- Why an RPC and not "PATCH projects.files": the owner/collaborator CAN update `files` through PostgREST (projects_update_owner_or_member),
-- but that replaces the whole jsonb — a read-modify-write that loses edits when two writers overlap (the EXAMPLE run saving index.html
-- while the owner re-skins styles.css, or two collaborators). This merges ONLY the given files into the existing object, in one
-- statement. Same access rule as the artifact RPCs (vx_stage_access): the owner, an ACCEPTED collaborator, or the platform; a
-- stranger and "no such project" get the same error.
--
-- Deliberately narrow: plain site files only (.html .css .js .json, flat names). The `_` project-memory files, images and anything
-- with a path are NOT writable through here. Caps: 20 files per call, 600 000 characters per file, 1 500 000 per call.
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261021110000_set_project_files.sql
-- Verify:  supabase db query --linked -f supabase/tests/step9_set_project_files.sql        (always rolls back)

BEGIN;

CREATE OR REPLACE FUNCTION public.set_project_files(p_project text, p_files jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k     text;
  v     jsonb;
  n     integer := 0;
  total integer := 0;
BEGIN
  PERFORM public.vx_stage_access(p_project);
  IF p_files IS NULL OR jsonb_typeof(p_files) <> 'object' THEN
    RAISE EXCEPTION 'files must be a JSON object of name -> text' USING ERRCODE = '22023';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p_files) LOOP
    n := n + 1;
    IF k !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|css|js|json)$' THEN
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
  IF n = 0 THEN RETURN jsonb_build_object('saved', '[]'::jsonb); END IF;
  IF n > 20 OR total > 1500000 THEN
    RAISE EXCEPTION 'too many or too large files in one call' USING ERRCODE = '54000';
  END IF;

  -- `||` replaces the given keys and keeps every other file as it is; one UPDATE = atomic per row.
  UPDATE public.projects SET files = coalesce(files, '{}'::jsonb) || p_files WHERE id = p_project;
  RETURN jsonb_build_object('saved', (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb) FROM jsonb_object_keys(p_files) AS key));
END $$;

REVOKE EXECUTE ON FUNCTION public.set_project_files(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_project_files(text, jsonb) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
