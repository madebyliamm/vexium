-- REVAMP Step 10 — verification of supabase/migrations/20261022100000_full_build.sql (build_steps + commit_site_build).
--
-- Run against production:   supabase db query --linked -f supabase/tests/step10_full_build.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: splice the migration (minus its BEGIN/COMMIT/NOTIFY) in front of the "-- ── A." marker.
--
-- Test data: throwaway projects (vxt_build_*) owned by the oldest auth user, with member rows for two other users — all inside the
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

INSERT INTO public.projects (id, user_id, name, files) SELECT 'vxt_build_a', owner, 'Build test A',
  '{"index.html":"<p>old</p>","old-page.html":"<p>stale</p>","keep.html":"<p>keep</p>","logo.png":"img","_longterm":"{}"}'::jsonb FROM _c;
INSERT INTO public.projects (id, user_id, name) SELECT 'vxt_build_b', owner, 'Build test B (no files yet)' FROM _c;
INSERT INTO public.project_members (project_id, user_id, status)
  SELECT 'vxt_build_a', member, 'accepted' FROM _c UNION ALL SELECT 'vxt_build_a', pending, 'pending' FROM _c;
INSERT INTO public.build_jobs (id, project_id, user_id, status, prompt, stage)
  SELECT '11111111-1111-4111-8111-111111111111', 'vxt_build_a', owner, 'running', 'x', 'build' FROM _c;
INSERT INTO public.build_steps (job_id, project_id, seq, kind, file, label, output)
  VALUES ('11111111-1111-4111-8111-111111111111', 'vxt_build_a', 1, 'page', 'index.html', 'Home page', '<p>secret model output</p>'),
         ('11111111-1111-4111-8111-111111111111', 'vxt_build_a', 2, 'verify', NULL, 'Check everything', NULL);

-- ── A. catalog ─────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('only service_role can execute commit_site_build',
  (NOT has_function_privilege('anon', 'public.commit_site_build(text, jsonb, jsonb)', 'EXECUTE')
   AND NOT has_function_privilege('authenticated', 'public.commit_site_build(text, jsonb, jsonb)', 'EXECUTE')
   AND has_function_privilege('service_role', 'public.commit_site_build(text, jsonb, jsonb)', 'EXECUTE'))::text, 'true');
SELECT pg_temp.expect('clients have no write privilege on build_steps',
  (SELECT count(*)::text FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'build_steps' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')), '0');
SELECT pg_temp.expect('anon has no access to build_steps at all',
  pg_temp.try_as('anon', NULL, $q$ SELECT count(*) FROM public.build_steps $q$), 'denied');
SELECT pg_temp.expect('row level security is on',
  (SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.build_steps'::regclass), 'true');

-- ── B. who can read the checklist (and never the page text) ────────────────────────────────────────
SELECT pg_temp.expect('the owner reads the steps',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT id, job_id, project_id, seq, kind, file, label, status, attempt, detail, cost_cents, started_at, finished_at, created_at FROM public.build_steps $q$,
    $q$ SELECT count(*)::text FROM public.build_steps WHERE project_id = 'vxt_build_a' $q$), 'ok rows=2 | 2');
SELECT pg_temp.expect('an accepted collaborator reads them',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), $q$ SELECT id, label FROM public.build_steps WHERE project_id = 'vxt_build_a' $q$), 'ok rows=2');
SELECT pg_temp.expect('a pending invitee sees none',
  pg_temp.try_as('authenticated', (SELECT pending FROM _c), $q$ SELECT id, label FROM public.build_steps WHERE project_id = 'vxt_build_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('a stranger sees none',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), $q$ SELECT id, label FROM public.build_steps WHERE project_id = 'vxt_build_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('the model output column is NOT readable by the owner',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT output FROM public.build_steps $q$), 'denied');
SELECT pg_temp.expect('…nor through select *',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT * FROM public.build_steps $q$), 'denied');
SELECT pg_temp.expect('the owner cannot write a step',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.build_steps SET status = 'done' $q$), 'denied');
SELECT pg_temp.expect('…nor insert one',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ INSERT INTO public.build_steps (job_id, project_id, seq, kind, label) VALUES ('11111111-1111-4111-8111-111111111111', 'vxt_build_a', 9, 'page', 'x') $q$), 'denied');
SELECT pg_temp.expect('…nor delete one',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ DELETE FROM public.build_steps $q$), 'denied');
SELECT pg_temp.expect('the platform reads the output',
  pg_temp.try_as('service_role', NULL, $q$ SELECT output FROM public.build_steps WHERE seq = 1 AND project_id = 'vxt_build_a' $q$), 'ok rows=1');

-- ── C. table rules ─────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('a step number is unique within its job',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.build_steps (job_id, project_id, seq, kind, label) VALUES ('11111111-1111-4111-8111-111111111111', 'vxt_build_a', 1, 'page', 'again') $q$), 'error 23505%');
SELECT pg_temp.expect('an unknown kind is refused',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.build_steps (job_id, project_id, seq, kind, label) VALUES ('11111111-1111-4111-8111-111111111111', 'vxt_build_a', 7, 'magic', 'x') $q$), 'error 23514%');
SELECT pg_temp.expect('an unknown status is refused',
  pg_temp.try_as('service_role', NULL, $q$ UPDATE public.build_steps SET status = 'maybe' WHERE seq = 1 $q$), 'error 23514%');
SELECT pg_temp.expect('a step needs a real job',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.build_steps (job_id, project_id, seq, kind, label) VALUES ('22222222-2222-4222-8222-222222222222', 'vxt_build_a', 3, 'page', 'x') $q$), 'error 23503%');
SELECT pg_temp.expect('deleting the job deletes its steps',
  pg_temp.try_as('service_role', NULL, $q$ DELETE FROM public.build_jobs WHERE id = '11111111-1111-4111-8111-111111111111' $q$,
    $q$ SELECT count(*)::text FROM public.build_steps WHERE project_id = 'vxt_build_a' $q$), 'ok rows=1 | 0');

-- ── D. commit_site_build: who can call it ──────────────────────────────────────────────────────────
SELECT pg_temp.expect('the owner cannot (it can write _backend)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.commit_site_build('vxt_build_a', '{"index.html":"x"}'::jsonb) $q$), 'denied');
SELECT pg_temp.expect('a collaborator cannot',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), $q$ SELECT public.commit_site_build('vxt_build_a', '{"index.html":"x"}'::jsonb) $q$), 'denied');
SELECT pg_temp.expect('anon cannot',
  pg_temp.try_as('anon', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"index.html":"x"}'::jsonb) $q$), 'denied');
SELECT pg_temp.expect('the platform can',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"index.html":"<p>built</p>","_backend":"{}"}'::jsonb) $q$), 'ok rows=1');
SELECT pg_temp.expect('the platform gets a clear error for a missing project',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_nope', '{"index.html":"x"}'::jsonb) $q$), 'error P0002%');

-- ── E. commit semantics ────────────────────────────────────────────────────────────────────────────
SELECT public.commit_site_build('vxt_build_a',
  '{"index.html":"<p>new home</p>","pricing.html":"<p>prices</p>","styles.css":"a{}","site.js":"s","manifest.json":"{}","_backend":"{\"auth\":{\"enabled\":true}}"}'::jsonb,
  '["old-page.html","index.html"]'::jsonb);
SELECT pg_temp.expect('written files are replaced / added, _backend included',
  (SELECT (files ->> 'index.html') || '|' || (files ->> 'pricing.html') || '|' || (files ->> '_backend') FROM public.projects WHERE id = 'vxt_build_a'),
  '<p>new home</p>|<p>prices</p>|{"auth":{"enabled":true}}');
SELECT pg_temp.expect('a listed stale page is removed',
  (SELECT (files ? 'old-page.html')::text FROM public.projects WHERE id = 'vxt_build_a'), 'false');
SELECT pg_temp.expect('a page the same build writes is never removed, even if listed',
  (SELECT (files ? 'index.html')::text FROM public.projects WHERE id = 'vxt_build_a'), 'true');
SELECT pg_temp.expect('pages and images that were not mentioned stay (and the memory files)',
  (SELECT (files ->> 'keep.html') || '|' || (files ->> 'logo.png') || '|' || (files ->> '_longterm') FROM public.projects WHERE id = 'vxt_build_a'), '<p>keep</p>|img|{}');
SELECT pg_temp.expect('the result lists what was saved and removed',
  (SELECT public.commit_site_build('vxt_build_b', '{"b.html":"x","a.html":"y"}'::jsonb, '["gone.html"]'::jsonb))::text, '{"saved": ["a.html", "b.html"], "removed": ["gone.html"]}');
SELECT pg_temp.expect('a project with no files yet gets them',
  (SELECT files ->> 'a.html' FROM public.projects WHERE id = 'vxt_build_b'), 'y');
SELECT pg_temp.expect('other projects are untouched',
  (SELECT files ->> 'pricing.html' FROM public.projects WHERE id = 'vxt_build_b'), NULL);

-- ── F. validation ──────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('nothing to commit',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('not an object',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '["a"]'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('remove must be an array',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"a.html":"x"}'::jsonb, '{"a":1}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('a path in a name',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"a/b.html":"x"}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('_longterm is not writable here, only _backend',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"_longterm":"{}"}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('images are not writable here',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"logo.png":"x"}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('a value that is not text',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"a.html":{"x":1}}'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('only pages can be removed (not styles.css)',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"a.html":"x"}'::jsonb, '["styles.css"]'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('…nor _backend',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"a.html":"x"}'::jsonb, '["_backend"]'::jsonb) $q$), 'error 22023%');
SELECT pg_temp.expect('a file over 600000 characters',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', jsonb_build_object('a.html', repeat('x', 600001))) $q$), 'error 54000%');
SELECT pg_temp.expect('40 pages are fine (more than set_project_files allows)',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', (SELECT jsonb_object_agg('p' || g || '.html', 'x') FROM generate_series(1, 40) g)) $q$), 'ok rows=1');
SELECT pg_temp.expect('81 files are not',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', (SELECT jsonb_object_agg('p' || g || '.html', 'x') FROM generate_series(1, 81) g)) $q$), 'error 54000%');
SELECT pg_temp.expect('over 6000000 characters in one build',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', (SELECT jsonb_object_agg('p' || g || '.html', repeat('x', 500000)) FROM generate_series(1, 13) g)) $q$), 'error 54000%');
SELECT pg_temp.expect('a rejected call changes nothing (all or nothing)',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.commit_site_build('vxt_build_a', '{"ok.html":"fine","bad/name.html":"x"}'::jsonb, '["keep.html"]'::jsonb) $q$,
    $q$ SELECT (files ? 'ok.html')::text || '|' || (files ? 'keep.html')::text FROM public.projects WHERE id = 'vxt_build_a' $q$), 'error 22023%');
SELECT pg_temp.expect('…ok.html is absent and keep.html is still there',
  (SELECT (files ? 'ok.html')::text || '|' || (files ? 'keep.html')::text FROM public.projects WHERE id = 'vxt_build_a'), 'false|true');

-- ── report (RAISE aborts + rolls back everything above) ────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
