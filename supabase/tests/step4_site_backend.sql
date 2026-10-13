-- REVAMP Step 4 — verification of supabase/migrations/20261012140000_site_backend_v2.sql.
--
-- Run against production:   supabase db query --linked -f supabase/tests/step4_site_backend.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: splice it (minus BEGIN/COMMIT) in at the marker line "-- ── A." (python:
-- split this file on the marker, insert the migration body between the halves, write to /tmp, run that).
-- Needs at least one project with an owner (any prod project) and a second project.
BEGIN;

CREATE TEMP TABLE _t (n serial, name text, passed boolean, got text);

CREATE FUNCTION pg_temp.expect(p_name text, p_got text, p_want_like text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _t(name, passed, got) VALUES (p_name, p_got LIKE p_want_like, p_got)
$$;

-- Runs one statement as an API role; its effects are always undone (same helper as step3_hosting_v2.sql).
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
    WHEN unique_violation THEN r := 'unique_violation';
    WHEN OTHERS THEN r := 'error ' || SQLSTATE || ': ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

-- Same, but for statements run as the current (postgres) user: returns 'ok' or 'error <sqlstate>'.
CREATE FUNCTION pg_temp.try_sql(p_stmt text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_stmt;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'RB000';
  EXCEPTION
    WHEN SQLSTATE 'RB000' THEN RETURN 'ok';
    WHEN OTHERS THEN RETURN 'error ' || SQLSTATE;
  END;
END $$;

CREATE TEMP TABLE _c AS
  SELECT p.id AS p1, p.user_id AS owner,
         (SELECT id FROM public.projects WHERE id <> p.id ORDER BY created_at LIMIT 1) AS p2
  FROM public.projects p ORDER BY p.created_at LIMIT 1;

-- ── A. shape / privileges ────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('site_sessions exists with RLS on',
  (SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.site_sessions'::regclass), 'true');
SELECT pg_temp.expect('rate_limits exists with RLS on',
  (SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.rate_limits'::regclass), 'true');
SELECT pg_temp.expect('site_sessions has no policies at all',
  (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('site_sessions', 'rate_limits')), '0');
SELECT pg_temp.expect('anon/authenticated have NO privilege on site_sessions',
  (has_table_privilege('anon', 'public.site_sessions', 'SELECT') OR has_table_privilege('authenticated', 'public.site_sessions', 'SELECT')
   OR has_table_privilege('anon', 'public.site_sessions', 'INSERT') OR has_table_privilege('authenticated', 'public.site_sessions', 'INSERT')
   OR has_table_privilege('authenticated', 'public.site_sessions', 'UPDATE') OR has_table_privilege('authenticated', 'public.site_sessions', 'DELETE'))::text, 'false');
SELECT pg_temp.expect('anon/authenticated have NO privilege on rate_limits',
  (has_table_privilege('anon', 'public.rate_limits', 'SELECT') OR has_table_privilege('authenticated', 'public.rate_limits', 'SELECT')
   OR has_table_privilege('anon', 'public.rate_limits', 'INSERT') OR has_table_privilege('authenticated', 'public.rate_limits', 'INSERT')
   OR has_table_privilege('authenticated', 'public.rate_limits', 'UPDATE') OR has_table_privilege('authenticated', 'public.rate_limits', 'DELETE'))::text, 'false');
SELECT pg_temp.expect('service_role can use both tables',
  (has_table_privilege('service_role', 'public.site_sessions', 'INSERT') AND has_table_privilege('service_role', 'public.rate_limits', 'UPDATE'))::text, 'true');
SELECT pg_temp.expect('vx_rate_hit is NOT executable by anon',
  has_function_privilege('anon', 'public.vx_rate_hit(text,integer,integer,integer)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('vx_rate_hit is NOT executable by authenticated',
  has_function_privilege('authenticated', 'public.vx_rate_hit(text,integer,integer,integer)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('vx_rate_hit is executable by service_role',
  has_function_privilege('service_role', 'public.vx_rate_hit(text,integer,integer,integer)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('anon can NOT call vx_rate_hit over the API',
  pg_temp.try_as('anon', NULL, $q$SELECT * FROM public.vx_rate_hit('x', 60, 5, 1)$q$), 'denied');
SELECT pg_temp.expect('a signed-in user can NOT call vx_rate_hit over the API',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$SELECT * FROM public.vx_rate_hit('x', 60, 5, 1)$q$), 'denied');
SELECT pg_temp.expect('service role CAN call vx_rate_hit',
  pg_temp.try_as('service_role', NULL, $q$SELECT * FROM public.vx_rate_hit('x', 60, 5, 1)$q$), 'ok rows=1');
SELECT pg_temp.expect('anon can NOT read site_sessions',
  pg_temp.try_as('anon', NULL, 'SELECT * FROM public.site_sessions'), 'denied');
SELECT pg_temp.expect('a signed-in user can NOT read site_sessions',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), 'SELECT * FROM public.site_sessions'), 'denied');
SELECT pg_temp.expect('a signed-in user can NOT forge a rate_limits row',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$INSERT INTO public.rate_limits(key, window_start, hits) VALUES ('k', now(), 1)$q$), 'denied');
SELECT pg_temp.expect('password_hash is still hidden from clients',
  (has_column_privilege('anon', 'public.site_users', 'password_hash', 'SELECT') OR has_column_privilege('authenticated', 'public.site_users', 'password_hash', 'SELECT'))::text, 'false');

-- ── B. rate limiter semantics ────────────────────────────────────────────────────────────────────────
-- limit 3 per 60 s: hits 1,2,3 allowed, hit 4 blocked.
CREATE TEMP TABLE _r AS
  SELECT 1 AS i, (x).allowed, (x).hits, (x).retry_after FROM (SELECT public.vx_rate_hit('t-count', 60, 3, 1) AS x) s
  UNION ALL SELECT 2, (x).allowed, (x).hits, (x).retry_after FROM (SELECT public.vx_rate_hit('t-count', 60, 3, 1) AS x) s
  UNION ALL SELECT 3, (x).allowed, (x).hits, (x).retry_after FROM (SELECT public.vx_rate_hit('t-count', 60, 3, 1) AS x) s
  UNION ALL SELECT 4, (x).allowed, (x).hits, (x).retry_after FROM (SELECT public.vx_rate_hit('t-count', 60, 3, 1) AS x) s;
SELECT pg_temp.expect('counting: first 3 hits allowed',
  (SELECT bool_and(allowed)::text FROM _r WHERE i <= 3), 'true');
SELECT pg_temp.expect('counting: 4th hit blocked',
  (SELECT allowed::text FROM _r WHERE i = 4), 'false');
SELECT pg_temp.expect('counting: hits counter reaches 4',
  (SELECT hits::text FROM _r WHERE i = 4), '4');
SELECT pg_temp.expect('retry_after is within the window (1..60)',
  (SELECT (retry_after BETWEEN 1 AND 60)::text FROM _r WHERE i = 4), 'true');
SELECT pg_temp.expect('keys are independent',
  (SELECT allowed::text FROM public.vx_rate_hit('t-other', 60, 3, 1)), 'true');
-- failures-only pattern: peek (cost 0) does not consume, only cost 1 does.
SELECT pg_temp.expect('peek on a fresh key is allowed and does not count',
  (SELECT allowed::text || ':' || hits FROM public.vx_rate_hit('t-peek', 900, 2, 0)), 'true:0');
SELECT public.vx_rate_hit('t-peek', 900, 2, 1);
SELECT pg_temp.expect('peek after 1 of 2 failures is still allowed',
  (SELECT allowed::text FROM public.vx_rate_hit('t-peek', 900, 2, 0)), 'true');
SELECT public.vx_rate_hit('t-peek', 900, 2, 1);
SELECT pg_temp.expect('peek after 2 of 2 failures is blocked',
  (SELECT allowed::text FROM public.vx_rate_hit('t-peek', 900, 2, 0)), 'false');
SELECT pg_temp.expect('bad arguments are rejected (limit 0)',
  pg_temp.try_sql($q$SELECT * FROM public.vx_rate_hit('t-bad', 60, 0, 1)$q$), 'error P0001');
SELECT pg_temp.expect('over-long keys are truncated, not rejected',
  (SELECT allowed::text FROM public.vx_rate_hit(repeat('k', 1000), 60, 3, 1)), 'true');

-- ── C. site_data / site_users backstop CHECKs ────────────────────────────────────────────────────────
SELECT pg_temp.expect('site_data: a normal row is accepted',
  pg_temp.try_sql(format($q$INSERT INTO public.site_data(project_id, collection, data) VALUES (%L, 'waitlist', '{"email":"a@b.co"}')$q$, (SELECT p1 FROM _c))), 'ok');
SELECT pg_temp.expect('site_data: upper-case/odd collection names are rejected',
  pg_temp.try_sql(format($q$INSERT INTO public.site_data(project_id, collection, data) VALUES (%L, 'Bad Name', '{}')$q$, (SELECT p1 FROM _c))), 'error 23514');
SELECT pg_temp.expect('site_data: reserved-looking names with other characters are rejected',
  pg_temp.try_sql(format($q$INSERT INTO public.site_data(project_id, collection, data) VALUES (%L, '../x', '{}')$q$, (SELECT p1 FROM _c))), 'error 23514');
SELECT pg_temp.expect('site_data: > 16 KB rows are rejected',
  pg_temp.try_sql(format($q$INSERT INTO public.site_data(project_id, collection, data) VALUES (%L, 'waitlist', jsonb_build_object('x', repeat('a', 17000)))$q$, (SELECT p1 FROM _c))), 'error 23514');
SELECT pg_temp.expect('site_data: existing rows still satisfy the constraints (validated)',
  (SELECT bool_and(convalidated)::text FROM pg_constraint WHERE conrelid = 'public.site_data'::regclass AND conname IN ('site_data_collection_chk', 'site_data_size_chk')), 'true');
SELECT pg_temp.expect('site_users: lower-case email accepted',
  pg_temp.try_sql(format($q$INSERT INTO public.site_users(project_id, email, password_hash) VALUES (%L, 'a@b.co', 'x')$q$, (SELECT p1 FROM _c))), 'ok');
SELECT pg_temp.expect('site_users: upper-case email rejected (emails are normalised)',
  pg_temp.try_sql(format($q$INSERT INTO public.site_users(project_id, email, password_hash) VALUES (%L, 'A@B.co', 'x')$q$, (SELECT p1 FROM _c))), 'error 23514');
SELECT pg_temp.expect('site_users: > 4 KB metadata rejected',
  pg_temp.try_sql(format($q$INSERT INTO public.site_users(project_id, email, password_hash, metadata) VALUES (%L, 'm@b.co', 'x', jsonb_build_object('x', repeat('a', 5000)))$q$, (SELECT p1 FROM _c))), 'error 23514');

-- ── D. cascades ──────────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.site_users(id, project_id, email, password_hash)
  VALUES ('00000000-0000-0000-0000-0000000000a1', (SELECT p1 FROM _c), 'cascade@b.co', 'x'),
         ('00000000-0000-0000-0000-0000000000a2', (SELECT p2 FROM _c), 'other@b.co', 'x');
INSERT INTO public.site_sessions(token_hash, project_id, site_user_id, expires_at)
  VALUES ('h1', (SELECT p1 FROM _c), '00000000-0000-0000-0000-0000000000a1', now() + interval '1 day'),
         ('h2', (SELECT p2 FROM _c), '00000000-0000-0000-0000-0000000000a2', now() + interval '1 day');
SELECT pg_temp.expect('a session row must belong to an existing site user',
  pg_temp.try_sql(format($q$INSERT INTO public.site_sessions(token_hash, project_id, site_user_id, expires_at) VALUES ('h3', %L, gen_random_uuid(), now())$q$, (SELECT p1 FROM _c))), 'error 23503');
DELETE FROM public.site_users WHERE id = '00000000-0000-0000-0000-0000000000a1';
SELECT pg_temp.expect('deleting a site user (owner, dashboard) deletes their sessions',
  (SELECT count(*)::text FROM public.site_sessions WHERE token_hash = 'h1'), '0');
SELECT pg_temp.expect('...but not other users'' sessions',
  (SELECT count(*)::text FROM public.site_sessions WHERE token_hash = 'h2'), '1');
INSERT INTO public.site_users(id, project_id, email, password_hash)
  VALUES ('00000000-0000-0000-0000-0000000000a3', (SELECT p1 FROM _c), 'owner-delete@b.co', 'x');
SELECT pg_temp.expect('owner can delete a site user over the API (existing RLS policy still works)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format($q$DELETE FROM public.site_users WHERE project_id = %L$q$, (SELECT p1 FROM _c))), 'ok rows=1');
INSERT INTO public.site_users(id, project_id, email, password_hash)
  VALUES ('00000000-0000-0000-0000-0000000000a4', (SELECT p1 FROM _c), 'stranger-target@b.co', 'x');
SELECT pg_temp.expect('a stranger can NOT delete another project''s site users',
  pg_temp.try_as('authenticated', (SELECT id FROM auth.users WHERE id <> (SELECT owner FROM _c) ORDER BY created_at LIMIT 1),
    format($q$DELETE FROM public.site_users WHERE project_id = %L$q$, (SELECT p1 FROM _c))), 'ok rows=0');

-- ── report (RAISE aborts + rolls back everything above) ──────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
