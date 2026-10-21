-- REVAMP Step 9 — verification of supabase/migrations/20261021110000_set_project_files.sql (atomic merge of site files).
--
-- Run against production:   supabase db query --linked -f supabase/tests/step9_set_project_files.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: splice the migration (minus its BEGIN/COMMIT/NOTIFY) in front of the "-- ── A." marker.
--
-- Test data: throwaway projects (vxt_files_*) owned by the oldest auth user, with member rows for two other users — all inside the
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

-- One statement as a real API role (SET LOCAL ROLE); its effects are always undone. p_after runs after the statement (as the
-- session user, before the undo) so a test can see what the statement changed.
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

-- cast
CREATE TEMP TABLE _c AS
  SELECT (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 0) AS owner,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 1) AS stranger,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 2) AS member,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 3) AS pending;

INSERT INTO public.projects (id, user_id, name, files) SELECT 'vxt_files_a', owner, 'Files test A',
  '{"index.html":"<p>old</p>","about.html":"<p>about</p>","_longterm":"{}"}'::jsonb FROM _c;
INSERT INTO public.projects (id, user_id, name) SELECT 'vxt_files_b', owner, 'Files test B (no files yet)' FROM _c;
INSERT INTO public.project_members (project_id, user_id, status)
  SELECT 'vxt_files_a', member, 'accepted' FROM _c UNION ALL SELECT 'vxt_files_a', pending, 'pending' FROM _c;

-- ── A. catalog ─────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('anon cannot execute set_project_files',
  has_function_privilege('anon', 'public.set_project_files(text, jsonb)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('authenticated and service_role can',
  (has_function_privilege('authenticated', 'public.set_project_files(text, jsonb)', 'EXECUTE')
   AND has_function_privilege('service_role', 'public.set_project_files(text, jsonb)', 'EXECUTE'))::text, 'true');

-- ── B. who can write ───────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('owner writes (and the files are there)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.set_project_files('vxt_files_a', '{"styles.css":"a{}","index.html":"<p>new</p>"}'::jsonb) $q$,
    $q$ SELECT (files ->> 'index.html') || '|' || (files ->> 'styles.css') FROM public.projects WHERE id = 'vxt_files_a' $q$), 'ok rows=1 | <p>new</p>|a{}');
SELECT pg_temp.expect('an accepted collaborator writes',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), $q$ SELECT public.set_project_files('vxt_files_a', '{"styles.css":"b{}"}'::jsonb) $q$), 'ok rows=1');
SELECT pg_temp.expect('a pending invitee cannot',
  pg_temp.try_as('authenticated', (SELECT pending FROM _c), $q$ SELECT public.set_project_files('vxt_files_a', '{"styles.css":"x"}'::jsonb) $q$), 'denied');
SELECT pg_temp.expect('a stranger cannot (same answer as for a missing project)',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), $q$ SELECT public.set_project_files('vxt_files_a', '{"styles.css":"x"}'::jsonb) $q$), 'denied');
SELECT pg_temp.expect('a stranger probing a missing project gets the same answer',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), $q$ SELECT public.set_project_files('vxt_files_nope', '{"styles.css":"x"}'::jsonb) $q$), 'denied');
SELECT pg_temp.expect('anon cannot',
  pg_temp.try_as('anon', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"styles.css":"x"}'::jsonb) $q$), 'denied');
SELECT pg_temp.expect('the platform (service_role) can',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"styles.css":"s{}"}'::jsonb) $q$), 'ok rows=1');
SELECT pg_temp.expect('the platform gets a clear error for a missing project',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_nope', '{"styles.css":"x"}'::jsonb) $q$), 'error P0002%');

-- ── C. merge semantics ─────────────────────────────────────────────────────────────────────────────
SELECT public.set_project_files('vxt_files_a', '{"styles.css":"body{}","index.html":"<p>fresh</p>"}'::jsonb);
SELECT pg_temp.expect('given files are replaced / added',
  (SELECT files ->> 'index.html' || '|' || (files ->> 'styles.css') FROM public.projects WHERE id = 'vxt_files_a'), '<p>fresh</p>|body{}');
SELECT pg_temp.expect('files that were not given are kept (including the _ memory files)',
  (SELECT (files ->> 'about.html') || '|' || (files ->> '_longterm') FROM public.projects WHERE id = 'vxt_files_a'), '<p>about</p>|{}');
SELECT public.set_project_files('vxt_files_b', '{"index.html":"<p>first</p>"}'::jsonb);
SELECT pg_temp.expect('a project with no files yet gets them',
  (SELECT files ->> 'index.html' FROM public.projects WHERE id = 'vxt_files_b'), '<p>first</p>');
SELECT pg_temp.expect('an empty object changes nothing',
  (SELECT public.set_project_files('vxt_files_a', '{}'::jsonb))::text, '{"saved": []}');
SELECT pg_temp.expect('the result lists the saved names, sorted',
  (SELECT public.set_project_files('vxt_files_a', '{"site.js":"x","manifest.json":"{}"}'::jsonb))::text, '{"saved": ["manifest.json", "site.js"]}');
SELECT pg_temp.expect('other projects are untouched',
  (SELECT files ->> 'about.html' FROM public.projects WHERE id = 'vxt_files_b'), NULL);

-- ── D. validation ──────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('not an object',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '["a"]'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('null',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', NULL) $q$), 'error 22023%');
SELECT pg_temp.expect('a path in the name',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"a/b.html":"x"}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('a parent-directory name',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"../x.html":"x"}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('the _ memory files are not writable here',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"_longterm":"{}"}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('images are not writable here',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"logo.png":"x"}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('an unknown extension',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"x.php":"x"}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('a value that is not text',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"a.html":{"x":1}}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('a file over 600000 characters',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', jsonb_build_object('a.html', repeat('x', 600001))) $q$), 'error 54000%');
SELECT pg_temp.expect('exactly 600000 characters is fine',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', jsonb_build_object('a.html', repeat('x', 600000))) $q$), 'ok rows=1');
SELECT pg_temp.expect('over 1500000 characters in one call',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', jsonb_build_object('a.html', repeat('x', 500000), 'b.html', repeat('x', 500000), 'c.html', repeat('x', 500000), 'd.html', 'x')) $q$), 'error 54000%');
SELECT pg_temp.expect('more than 20 files in one call',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', (SELECT jsonb_object_agg('p' || g || '.html', 'x') FROM generate_series(1, 21) g)) $q$), 'error 54000%');
SELECT pg_temp.expect('a rejected call changes nothing (all or nothing)',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.set_project_files('vxt_files_a', '{"ok.html":"fine","bad/name.html":"x"}'::jsonb) $q$,
    $q$ SELECT (files ? 'ok.html')::text FROM public.projects WHERE id = 'vxt_files_a' $q$), 'error 22023%');
SELECT pg_temp.expect('…and ok.html really is absent',
  (SELECT (files ? 'ok.html')::text FROM public.projects WHERE id = 'vxt_files_a'), 'false');

-- ── report (RAISE aborts + rolls back everything above) ────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
