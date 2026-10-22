-- REVAMP Step 11 — TWEAKS: the site's undo history (checkpoints) and the platform-only way to move along it.
--
-- site_snapshots: one row per checkpoint = the site's text files (pages, styles.css, site.js, manifest.json, _backend) at a moment.
-- A checkpoint is taken automatically at the end of each stage (the example page, the full build) and after every tweak, so the owner
-- can undo, redo or jump back without a developer. It is a LINE with one "you are here" row (`is_current`, at most one per project —
-- a partial unique index), like any editor's undo stack:
--   • undo / redo / restore move the "you are here" mark and put that checkpoint's files back into projects.files;
--   • a NEW checkpoint taken while you are not at the end drops the checkpoints after "you are here" (the usual redo rule) and
--     is appended right after it. Nothing is ever dropped by moving, only by making a new change from an earlier point.
--   • at most 40 checkpoints per project (the oldest go first); each is the whole site text, so this bounds the storage.
-- Images and anything that is not a site text file (the `_` memory files other than `_backend`) are not part of a checkpoint and a
-- move leaves them as they are: a move replaces exactly the site text files, so a page that did not exist at the checkpoint goes away.
--
-- Both functions are platform only (service_role): ai-chat calls them so that every move is followed by a fresh launch check, which a
-- client calling the function directly could skip. Clients READ the list (RLS: owner + accepted collaborators, like project_artifacts)
-- but not the `files` column — the text of every old version stays on the server; the studio only needs labels and the position.
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261023100000_site_history.sql
-- Verify:  supabase db query --linked -f supabase/tests/step11_site_history.sql        (always rolls back)

BEGIN;

CREATE TABLE IF NOT EXISTS public.site_snapshots (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  project_id  text        NOT NULL,
  seq         integer     NOT NULL,
  kind        text        NOT NULL,
  label       text        NOT NULL,
  files       jsonb       NOT NULL,
  is_current  boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT site_snapshots_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects (id) ON DELETE CASCADE,
  CONSTRAINT site_snapshots_project_seq_key UNIQUE (project_id, seq),
  CONSTRAINT site_snapshots_kind_check CHECK (kind IN ('stage', 'tweak', 'baseline')),
  CONSTRAINT site_snapshots_label_check CHECK (char_length(label) BETWEEN 1 AND 200),
  CONSTRAINT site_snapshots_seq_check CHECK (seq > 0),
  CONSTRAINT site_snapshots_files_check CHECK (jsonb_typeof(files) = 'object')
);

-- At most one "you are here" per project.
CREATE UNIQUE INDEX IF NOT EXISTS site_snapshots_current_idx ON public.site_snapshots (project_id) WHERE is_current;

ALTER TABLE public.site_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_snapshots_select ON public.site_snapshots;
CREATE POLICY site_snapshots_select ON public.site_snapshots AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.projects p
     WHERE p.id = site_snapshots.project_id
       AND (p.user_id = (SELECT auth.uid()) OR EXISTS (
             SELECT 1 FROM public.project_members m
              WHERE m.project_id = p.id AND m.user_id = (SELECT auth.uid()) AND m.status = 'accepted'))
  ));

-- Everything is taken back, then the readable columns are granted (not `files`: the old versions' text stays on the server).
REVOKE ALL ON public.site_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, project_id, seq, kind, label, is_current, created_at) ON public.site_snapshots TO authenticated;
GRANT ALL ON public.site_snapshots TO service_role;

-- The site text files of a project: what a checkpoint holds and what a move replaces.
CREATE OR REPLACE FUNCTION public.vx_site_text_files(p_files jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(coalesce(p_files, '{}'::jsonb))
   WHERE key ~ '^([A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|css|js|json)|_backend)$' AND jsonb_typeof(value) = 'string';
$$;
REVOKE EXECUTE ON FUNCTION public.vx_site_text_files(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vx_site_text_files(jsonb) TO service_role;

-- A checkpoint of the site as it is now. No new row when the site is exactly what "you are here" already holds.
CREATE OR REPLACE FUNCTION public.take_site_snapshot(p_project text, p_kind text, p_label text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur     public.site_snapshots%ROWTYPE;
  now_f   jsonb;
  next_n  integer;
  have    boolean;
BEGIN
  IF NOT public.vx_stage_access(p_project) THEN
    RAISE EXCEPTION 'take_site_snapshot is for the platform only' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('stage', 'tweak', 'baseline') THEN
    RAISE EXCEPTION 'unknown checkpoint kind' USING ERRCODE = '22023';
  END IF;
  IF p_label IS NULL OR char_length(btrim(p_label)) = 0 THEN
    RAISE EXCEPTION 'a checkpoint needs a label' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vx_site_history:' || p_project, 0));

  SELECT public.vx_site_text_files(files) INTO now_f FROM public.projects WHERE id = p_project;
  SELECT * INTO cur FROM public.site_snapshots WHERE project_id = p_project AND is_current;
  have := FOUND;
  IF have AND cur.files = now_f THEN
    RETURN jsonb_build_object('seq', cur.seq, 'created', false);
  END IF;

  -- A new change made from an earlier point: the checkpoints after "you are here" are the redo branch, and they go.
  IF have THEN
    DELETE FROM public.site_snapshots WHERE project_id = p_project AND seq > cur.seq;
    UPDATE public.site_snapshots SET is_current = false WHERE id = cur.id;
    next_n := cur.seq + 1;
  ELSE
    SELECT coalesce(max(seq), 0) + 1 INTO next_n FROM public.site_snapshots WHERE project_id = p_project;
  END IF;

  INSERT INTO public.site_snapshots (project_id, seq, kind, label, files, is_current)
  VALUES (p_project, next_n, p_kind, left(btrim(p_label), 200), now_f, true);

  DELETE FROM public.site_snapshots WHERE project_id = p_project AND seq <= next_n - 40;
  RETURN jsonb_build_object('seq', next_n, 'created', true);
END $$;

-- Move along the line: 'undo' (one back), 'redo' (one forward) or 'restore' (to checkpoint p_seq). The site files of that checkpoint
-- replace the site's text files in one statement.
CREATE OR REPLACE FUNCTION public.move_site_history(p_project text, p_action text, p_seq integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur     public.site_snapshots%ROWTYPE;
  target  public.site_snapshots%ROWTYPE;
  keys    text[];
BEGIN
  IF NOT public.vx_stage_access(p_project) THEN
    RAISE EXCEPTION 'move_site_history is for the platform only' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('undo', 'redo', 'restore') THEN
    RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vx_site_history:' || p_project, 0));

  SELECT * INTO cur FROM public.site_snapshots WHERE project_id = p_project AND is_current;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('moved', false, 'reason', 'no_history');
  END IF;

  IF p_action = 'undo' THEN
    SELECT * INTO target FROM public.site_snapshots WHERE project_id = p_project AND seq < cur.seq ORDER BY seq DESC LIMIT 1;
  ELSIF p_action = 'redo' THEN
    SELECT * INTO target FROM public.site_snapshots WHERE project_id = p_project AND seq > cur.seq ORDER BY seq ASC LIMIT 1;
  ELSE
    IF p_seq IS NULL THEN RAISE EXCEPTION 'restore needs a checkpoint' USING ERRCODE = '22023'; END IF;
    SELECT * INTO target FROM public.site_snapshots WHERE project_id = p_project AND seq = p_seq;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('moved', false, 'reason', CASE p_action WHEN 'restore' THEN 'not_found' ELSE 'nothing_to_' || p_action END);
  END IF;
  IF target.id = cur.id THEN
    RETURN jsonb_build_object('moved', false, 'reason', 'already_here', 'seq', cur.seq);
  END IF;

  SELECT coalesce(array_agg(k), '{}') INTO keys
    FROM jsonb_object_keys(public.vx_site_text_files((SELECT files FROM public.projects WHERE id = p_project))) AS k;
  UPDATE public.projects SET files = (coalesce(files, '{}'::jsonb) - keys) || target.files WHERE id = p_project;

  UPDATE public.site_snapshots SET is_current = false WHERE id = cur.id;
  UPDATE public.site_snapshots SET is_current = true WHERE id = target.id;
  RETURN jsonb_build_object('moved', true, 'seq', target.seq, 'label', target.label, 'kind', target.kind);
END $$;

REVOKE EXECUTE ON FUNCTION public.take_site_snapshot(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.take_site_snapshot(text, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.move_site_history(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_site_history(text, text, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
