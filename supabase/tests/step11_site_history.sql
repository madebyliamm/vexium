-- REVAMP Step 11 — verification of supabase/migrations/20261023100000_site_history.sql (site checkpoints + undo/redo/restore).
--
-- Run against production:   supabase db query --linked -f supabase/tests/step11_site_history.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: splice the migration (minus its BEGIN/COMMIT/NOTIFY) in front of the "-- the line of project A" marker.
--
-- Test data: throwaway projects (vxt_hist_*) owned by the oldest auth user, with member rows for two other users — all inside the
-- transaction, all rolled back. No real project is read or changed.
BEGIN;

CREATE TEMP TABLE _t (n serial, name text, passed boolean, got text);

CREATE FUNCTION pg_temp.expect(p_name text, p_got text, p_want_like text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  ok := coalesce(p_got LIKE p_want_like, p_got IS NULL AND p_want_like IS NULL);
  INSERT INTO _t(name, passed, got) VALUES (p_name, coalesce(ok, false), p_got);
END $$;

CREATE FUNCTION pg_temp.try_as(p_role text, p_uid uuid, p_stmt text, p_after text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE n bigint; r text; a text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_stmt;
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    IF p_after IS NOT NULL THEN EXECUTE p_after INTO a; END IF;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'RB000';
  EXCEPTION
    WHEN SQLSTATE 'RB000' THEN r := 'ok rows=' || n || coalesce(' | ' || a, '');
    WHEN insufficient_privilege THEN r := 'denied';
    WHEN OTHERS THEN r := 'error ' || SQLSTATE || ': ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

CREATE TEMP TABLE _c AS
  SELECT (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 0) AS owner,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 1) AS stranger,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 2) AS member,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 3) AS pending;

INSERT INTO public.projects (id, user_id, name, files) SELECT 'vxt_hist_a', owner, 'History test A',
  '{"index.html":"<p>v1</p>","styles.css":"a{}","_longterm":"{\"keep\":1}","logo.png":"PNGDATA"}'::jsonb FROM _c;
INSERT INTO public.projects (id, user_id, name, files) SELECT 'vxt_hist_b', owner, 'History test B', '{"index.html":"<p>b</p>"}'::jsonb FROM _c;
INSERT INTO public.projects (id, user_id, name, files) SELECT 'vxt_hist_c', owner, 'History test C', '{}'::jsonb FROM _c;
INSERT INTO public.project_members (project_id, user_id, status)
  SELECT 'vxt_hist_a', member, 'accepted' FROM _c UNION ALL SELECT 'vxt_hist_a', pending, 'pending' FROM _c;

-- the line of project A as "seq:label*" (the * marks "you are here")
CREATE FUNCTION pg_temp.line(p text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(seq || ':' || label || CASE WHEN is_current THEN '*' ELSE '' END, ' ' ORDER BY seq), '(none)') FROM public.site_snapshots WHERE project_id = p $$;
CREATE FUNCTION pg_temp.page(p text, f text) RETURNS text LANGUAGE sql AS $$ SELECT files ->> f FROM public.projects WHERE id = p $$;
CREATE FUNCTION pg_temp.edit(p text, f text, t text) RETURNS void LANGUAGE sql AS $$
  UPDATE public.projects SET files = files || jsonb_build_object(f, t) WHERE id = p $$;

-- ── A. catalog ─────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('anon cannot execute take_site_snapshot',
  has_function_privilege('anon', 'public.take_site_snapshot(text, text, text)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('authenticated cannot execute take_site_snapshot',
  has_function_privilege('authenticated', 'public.take_site_snapshot(text, text, text)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('service_role can execute take_site_snapshot',
  has_function_privilege('service_role', 'public.take_site_snapshot(text, text, text)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('authenticated cannot execute move_site_history',
  has_function_privilege('authenticated', 'public.move_site_history(text, text, integer)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('service_role can execute move_site_history',
  has_function_privilege('service_role', 'public.move_site_history(text, text, integer)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('clients cannot read the files column',
  has_column_privilege('authenticated', 'public.site_snapshots', 'files', 'SELECT')::text, 'false');
SELECT pg_temp.expect('clients can read the label column',
  has_column_privilege('authenticated', 'public.site_snapshots', 'label', 'SELECT')::text, 'true');
SELECT pg_temp.expect('clients cannot write the table',
  (has_table_privilege('authenticated', 'public.site_snapshots', 'INSERT') OR has_table_privilege('authenticated', 'public.site_snapshots', 'UPDATE') OR has_table_privilege('authenticated', 'public.site_snapshots', 'DELETE'))::text, 'false');
SELECT pg_temp.expect('anon cannot read the table at all',
  has_table_privilege('anon', 'public.site_snapshots', 'SELECT')::text, 'false');

-- ── B. who may call ────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('an owner cannot take a checkpoint through the API directly',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.take_site_snapshot('vxt_hist_a', 'tweak', 'x') $q$), 'denied');
SELECT pg_temp.expect('an owner cannot move the history through the API directly',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.move_site_history('vxt_hist_a', 'undo') $q$), 'denied');
SELECT pg_temp.expect('anon cannot',
  pg_temp.try_as('anon', NULL, $q$ SELECT public.take_site_snapshot('vxt_hist_a', 'tweak', 'x') $q$), 'denied');
SELECT pg_temp.expect('the platform gets a clear error for a missing project',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.take_site_snapshot('vxt_hist_nope', 'tweak', 'x') $q$), 'error P0002%');

-- ── C. taking checkpoints ──────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('no history yet', pg_temp.line('vxt_hist_a'), '(none)');
SELECT pg_temp.expect('the first checkpoint is seq 1 and created',
  (SELECT public.take_site_snapshot('vxt_hist_a', 'baseline', 'Site as built'))::text, '{"seq": 1, "created": true}');
SELECT pg_temp.expect('the same site again makes no new row',
  (SELECT public.take_site_snapshot('vxt_hist_a', 'tweak', 'Nothing changed'))::text, '{"seq": 1, "created": false}');
SELECT pg_temp.expect('it holds only the site text files (not the image, not the memory file)',
  (SELECT string_agg(k, ',' ORDER BY k) FROM public.site_snapshots, jsonb_object_keys(files) k WHERE project_id = 'vxt_hist_a'), 'index.html,styles.css');
SELECT pg_temp.edit('vxt_hist_a', 'index.html', '<p>v2</p>');
SELECT public.take_site_snapshot('vxt_hist_a', 'tweak', 'Change 2');
SELECT pg_temp.edit('vxt_hist_a', 'index.html', '<p>v3</p>');
SELECT public.take_site_snapshot('vxt_hist_a', 'tweak', 'Change 3');
SELECT pg_temp.expect('a line of three, the last one current', pg_temp.line('vxt_hist_a'), '1:Site as built 2:Change 2 3:Change 3*');
SELECT pg_temp.expect('a bad kind is refused',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.take_site_snapshot('vxt_hist_a', 'bogus', 'x') $q$), 'error 22023%');
SELECT pg_temp.expect('an empty label is refused',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.take_site_snapshot('vxt_hist_a', 'tweak', '   ') $q$), 'error 22023%');
SELECT public.take_site_snapshot('vxt_hist_b', 'baseline', repeat('x', 500));
SELECT pg_temp.expect('a very long label is cut to 200 characters',
  (SELECT length(label)::text FROM public.site_snapshots WHERE project_id = 'vxt_hist_b'), '200');

-- ── D. undo / redo ─────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('undo goes one back and puts that site back',
  (SELECT public.move_site_history('vxt_hist_a', 'undo'))::text, '{"seq": 2, "kind": "tweak", "label": "Change 2", "moved": true}');
SELECT pg_temp.expect('…the page is v2', pg_temp.page('vxt_hist_a', 'index.html'), '<p>v2</p>');
SELECT pg_temp.expect('…the mark moved', pg_temp.line('vxt_hist_a'), '1:Site as built 2:Change 2* 3:Change 3');
SELECT pg_temp.expect('…images and memory files are untouched',
  (SELECT (files ->> 'logo.png') || '|' || (files ->> '_longterm') FROM public.projects WHERE id = 'vxt_hist_a'), 'PNGDATA|{"keep":1}');
SELECT public.move_site_history('vxt_hist_a', 'undo');
SELECT pg_temp.expect('undo again reaches the first', pg_temp.page('vxt_hist_a', 'index.html'), '<p>v1</p>');
SELECT pg_temp.expect('undo at the start does nothing',
  (SELECT public.move_site_history('vxt_hist_a', 'undo'))::text, '{"moved": false, "reason": "nothing_to_undo"}');
SELECT public.move_site_history('vxt_hist_a', 'redo');
SELECT pg_temp.expect('redo goes forward', pg_temp.page('vxt_hist_a', 'index.html'), '<p>v2</p>');
SELECT public.move_site_history('vxt_hist_a', 'redo');
SELECT pg_temp.expect('redo at the end does nothing',
  (SELECT public.move_site_history('vxt_hist_a', 'redo'))::text, '{"moved": false, "reason": "nothing_to_redo"}');
SELECT pg_temp.expect('…and we are at v3 again', pg_temp.page('vxt_hist_a', 'index.html') || ' ' || pg_temp.line('vxt_hist_a'), '<p>v3</p> 1:Site as built 2:Change 2 3:Change 3*');

-- ── E. restore ─────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('restore jumps to a chosen checkpoint',
  (SELECT public.move_site_history('vxt_hist_a', 'restore', 1))::text, '{"seq": 1, "kind": "baseline", "label": "Site as built", "moved": true}');
SELECT pg_temp.expect('…and the site is that checkpoint', pg_temp.page('vxt_hist_a', 'index.html') || ' ' || pg_temp.line('vxt_hist_a'), '<p>v1</p> 1:Site as built* 2:Change 2 3:Change 3');
SELECT pg_temp.expect('restoring where you already are changes nothing',
  (SELECT public.move_site_history('vxt_hist_a', 'restore', 1))::text, '{"seq": 1, "moved": false, "reason": "already_here"}');
SELECT pg_temp.expect('restoring a checkpoint that does not exist',
  (SELECT public.move_site_history('vxt_hist_a', 'restore', 99))::text, '{"moved": false, "reason": "not_found"}');
SELECT pg_temp.expect('restore without a checkpoint is refused',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.move_site_history('vxt_hist_a', 'restore') $q$), 'error 22023%');
SELECT pg_temp.expect('an unknown action is refused',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.move_site_history('vxt_hist_a', 'rewind') $q$), 'error 22023%');
SELECT pg_temp.expect('a project with no history says so',
  (SELECT public.move_site_history('vxt_hist_c', 'undo') ->> 'reason'), 'no_history');
SELECT pg_temp.expect('a project with one checkpoint has nothing to undo',
  (SELECT public.move_site_history('vxt_hist_b', 'undo') ->> 'reason'), 'nothing_to_undo');

-- a page that did not exist at the checkpoint goes away on a move; one that did comes back
SELECT public.move_site_history('vxt_hist_a', 'restore', 3);
SELECT pg_temp.edit('vxt_hist_a', 'about.html', '<p>about</p>');
SELECT public.take_site_snapshot('vxt_hist_a', 'tweak', 'Added about');
SELECT public.move_site_history('vxt_hist_a', 'undo');
SELECT pg_temp.expect('undo removes a page that the earlier site did not have',
  (SELECT (files ? 'about.html')::text FROM public.projects WHERE id = 'vxt_hist_a'), 'false');
SELECT public.move_site_history('vxt_hist_a', 'redo');
SELECT pg_temp.expect('redo brings it back', pg_temp.page('vxt_hist_a', 'about.html'), '<p>about</p>');

-- ── F. a new change from an earlier point drops the redo branch ────────────────────────────────────
SELECT pg_temp.expect('before: four checkpoints', pg_temp.line('vxt_hist_a'), '1:Site as built 2:Change 2 3:Change 3 4:Added about*');
SELECT public.move_site_history('vxt_hist_a', 'restore', 2);
SELECT pg_temp.edit('vxt_hist_a', 'index.html', '<p>v2b</p>');
SELECT pg_temp.expect('a change from checkpoint 2 becomes 3 and the old 3 and 4 are gone',
  (SELECT public.take_site_snapshot('vxt_hist_a', 'tweak', 'Different change'))::text, '{"seq": 3, "created": true}');
SELECT pg_temp.expect('the line is now 1, 2, 3',  pg_temp.line('vxt_hist_a'), '1:Site as built 2:Change 2 3:Different change*');
SELECT pg_temp.expect('redo has nothing to go to now',
  (SELECT public.move_site_history('vxt_hist_a', 'redo') ->> 'reason'), 'nothing_to_redo');

-- ── G. limits ──────────────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  FOR i IN 1..45 LOOP
    UPDATE public.projects SET files = files || jsonb_build_object('index.html', 'p' || i) WHERE id = 'vxt_hist_b';
    PERFORM public.take_site_snapshot('vxt_hist_b', 'tweak', 'c' || i);
  END LOOP;
END $$;
SELECT pg_temp.expect('at most 40 checkpoints are kept',
  (SELECT count(*)::text FROM public.site_snapshots WHERE project_id = 'vxt_hist_b'), '40');
SELECT pg_temp.expect('the oldest went first and the newest is current',
  (SELECT min(seq) || '-' || max(seq) || ' ' || (SELECT label FROM public.site_snapshots WHERE project_id = 'vxt_hist_b' AND is_current) FROM public.site_snapshots WHERE project_id = 'vxt_hist_b'), '7-46 c45');
SELECT pg_temp.expect('never two "you are here" in one project',
  (SELECT count(*)::text FROM public.site_snapshots WHERE project_id = 'vxt_hist_b' AND is_current), '1');
SELECT pg_temp.expect('a second current row is refused by the index',
  pg_temp.try_as('service_role', NULL, $q$ UPDATE public.site_snapshots SET is_current = true WHERE project_id = 'vxt_hist_b' AND NOT is_current $q$), 'error 23505%');

-- ── H. who can read the line ───────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('the owner reads the labels',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT count(*) FROM public.site_snapshots WHERE project_id = 'vxt_hist_a' $q$), 'ok rows=1');
SELECT pg_temp.expect('…all of them',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT label FROM public.site_snapshots WHERE project_id = 'vxt_hist_a' $q$), 'ok rows=3');
SELECT pg_temp.expect('an accepted collaborator reads them',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), $q$ SELECT label FROM public.site_snapshots WHERE project_id = 'vxt_hist_a' $q$), 'ok rows=3');
SELECT pg_temp.expect('a pending invitee sees nothing',
  pg_temp.try_as('authenticated', (SELECT pending FROM _c), $q$ SELECT label FROM public.site_snapshots WHERE project_id = 'vxt_hist_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('a stranger sees nothing',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), $q$ SELECT label FROM public.site_snapshots WHERE project_id = 'vxt_hist_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('nobody can read the files column',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT files FROM public.site_snapshots WHERE project_id = 'vxt_hist_a' $q$), 'denied');
SELECT pg_temp.expect('a client cannot delete a checkpoint',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ DELETE FROM public.site_snapshots WHERE project_id = 'vxt_hist_a' $q$), 'denied');
SELECT pg_temp.expect('a client cannot rewrite a checkpoint',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.site_snapshots SET label = 'x' WHERE project_id = 'vxt_hist_a' $q$), 'denied');
SELECT pg_temp.expect('anon sees nothing and cannot even ask',
  pg_temp.try_as('anon', NULL, $q$ SELECT label FROM public.site_snapshots $q$), 'denied');

-- ── I. cleanup ─────────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.projects WHERE id = 'vxt_hist_b';
SELECT pg_temp.expect('deleting a project deletes its checkpoints',
  (SELECT count(*)::text FROM public.site_snapshots WHERE project_id = 'vxt_hist_b'), '0');

-- ── report (RAISE aborts + rolls back everything above) ────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
