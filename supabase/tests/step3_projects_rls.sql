-- REVAMP Step 3 — verification of supabase/migrations/20261012130000_projects_rls.sql (SECURITY_FINDINGS #16).
--
-- Run against production:   supabase db query --linked -f supabase/tests/step3_projects_rls.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: paste the migration (minus its BEGIN/COMMIT) between the helper functions
-- and section A, i.e. `sed '/^BEGIN;$/d;/^COMMIT;$/d' migration` — the "BEFORE" run is expected to FAIL.
BEGIN;

CREATE TEMP TABLE _t (n serial, name text, passed boolean, got text);

CREATE FUNCTION pg_temp.expect(p_name text, p_got text, p_want_like text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _t(name, passed, got) VALUES (p_name, p_got LIKE p_want_like, p_got)
$$;

-- Runs one statement as an API role and reports what happened. The statement's effects are always undone
-- (the inner block ends in a deliberate exception), so tests cannot affect each other.
CREATE FUNCTION pg_temp.try_as(p_role text, p_uid uuid, p_stmt text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE n bigint; r text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_stmt;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'RB000';
  EXCEPTION
    WHEN SQLSTATE 'RB000' THEN r := 'ok rows=' || n;
    WHEN insufficient_privilege THEN r := 'denied';
    WHEN OTHERS THEN r := 'error ' || SQLSTATE || ': ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

-- cast: a PUBLISHED project p1 (the realistic target: anon can see it) and its owner, a stranger, an accepted collaborator and a pending collaborator.
CREATE TEMP TABLE _c AS
  SELECT p.id AS p1, p.user_id AS owner,
         (SELECT id FROM auth.users WHERE id <> p.user_id ORDER BY created_at LIMIT 1 OFFSET 0) AS stranger,
         (SELECT id FROM auth.users WHERE id <> p.user_id ORDER BY created_at LIMIT 1 OFFSET 1) AS member,
         (SELECT id FROM auth.users WHERE id <> p.user_id ORDER BY created_at LIMIT 1 OFFSET 2) AS pending
  FROM public.projects p WHERE p.user_id IS NOT NULL ORDER BY (p.published_slug IS NOT NULL) DESC, p.created_at LIMIT 1;

INSERT INTO public.project_members (project_id, user_id, status)
  SELECT p1, member,  'accepted' FROM _c UNION ALL
  SELECT p1, pending, 'pending'  FROM _c;

-- ── A. policy catalog ──────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('no USING(true) UPDATE/DELETE policy left on projects',
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='projects' AND cmd IN ('UPDATE','DELETE','ALL') AND qual = 'true')::text, '0');
SELECT pg_temp.expect('anon has no write privilege on projects',
  (has_table_privilege('anon','public.projects','INSERT') OR has_table_privilege('anon','public.projects','UPDATE')
   OR has_table_privilege('anon','public.projects','DELETE') OR has_table_privilege('anon','public.projects','TRUNCATE'))::text, 'false');
SELECT pg_temp.expect('anon can still SELECT projects (publisher Worker / public profiles)',
  has_table_privilege('anon','public.projects','SELECT')::text, 'true');

-- ── B. anon ────────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('anon UPDATE denied',
  pg_temp.try_as('anon', NULL, format('UPDATE public.projects SET name = name WHERE id = %L', (SELECT p1 FROM _c))), 'denied');
SELECT pg_temp.expect('anon DELETE denied',
  pg_temp.try_as('anon', NULL, format('DELETE FROM public.projects WHERE id = %L', (SELECT p1 FROM _c))), 'denied');
SELECT pg_temp.expect('anon can still read published projects',
  pg_temp.try_as('anon', NULL, 'SELECT 1 FROM public.projects WHERE published_slug IS NOT NULL'), 'ok rows=%');

-- ── C. a signed-in stranger (not owner, not member) ────────────────────────────────────────────────
SELECT pg_temp.expect('stranger UPDATE affects 0 rows',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), format('UPDATE public.projects SET name = ''pwned'' WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=0');
SELECT pg_temp.expect('stranger UPDATE of published_files affects 0 rows',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), format('UPDATE public.projects SET published_files = ''{}''::jsonb WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=0');
SELECT pg_temp.expect('stranger DELETE affects 0 rows',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), format('DELETE FROM public.projects WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=0');
SELECT pg_temp.expect('stranger cannot steal ownership',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), format('UPDATE public.projects SET user_id = %L WHERE id = %L', (SELECT stranger FROM _c), (SELECT p1 FROM _c))), 'ok rows=0');

-- ── D. collaborators ───────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('accepted member can save (UPDATE)',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), format('UPDATE public.projects SET main_file = main_file WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=1');
SELECT pg_temp.expect('accepted member can NOT delete the project',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), format('DELETE FROM public.projects WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=0');
SELECT pg_temp.expect('accepted member can NOT take ownership',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), format('UPDATE public.projects SET user_id = %L WHERE id = %L', (SELECT member FROM _c), (SELECT p1 FROM _c))), 'denied');
SELECT pg_temp.expect('pending invitee can NOT update',
  pg_temp.try_as('authenticated', (SELECT pending FROM _c), format('UPDATE public.projects SET name = ''x'' WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=0');

-- ── E. owner ───────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('owner can UPDATE own project (editor save / publish)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('UPDATE public.projects SET main_file = main_file WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=1');
SELECT pg_temp.expect('owner can NOT give the project away via the API',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('UPDATE public.projects SET user_id = %L WHERE id = %L', (SELECT stranger FROM _c), (SELECT p1 FROM _c))), 'denied');
SELECT pg_temp.expect('service role can still UPDATE (build Worker, edge functions)',
  pg_temp.try_as('service_role', NULL, format('UPDATE public.projects SET main_file = main_file WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=1');
SELECT pg_temp.expect('owner can DELETE own project',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('DELETE FROM public.projects WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=1');

-- ── report (RAISE aborts + rolls back everything above) ────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
