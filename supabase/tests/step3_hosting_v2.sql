-- REVAMP Step 3 — verification of supabase/migrations/20261012131000_hosting_v2.sql.
--
-- Run against production:   supabase db query --linked -f supabase/tests/step3_hosting_v2.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: splice it (minus BEGIN/COMMIT) in at the marker line "-- ── A." — see the
-- one-liner in REVAMP.md Step 3 handoff notes. Needs at least one project with a custom domain and a profile username.
BEGIN;

CREATE TEMP TABLE _t (n serial, name text, passed boolean, got text);

CREATE FUNCTION pg_temp.expect(p_name text, p_got text, p_want_like text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _t(name, passed, got) VALUES (p_name, p_got LIKE p_want_like, p_got)
$$;

-- Runs one statement as an API role; its effects are always undone (see step3_projects_rls.sql).
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

-- cast: a project that has a custom domain AND a slug (the live "webre" site), its owner and username, a stranger,
-- and a second project to collide with.
CREATE TEMP TABLE _c AS
  SELECT p.id AS p1, p.user_id AS owner, p.published_slug AS slug, p.custom_domain AS host, pr.username AS uname,
         (SELECT id FROM auth.users WHERE id <> p.user_id ORDER BY created_at LIMIT 1) AS stranger,
         (SELECT id FROM public.projects WHERE id <> p.id ORDER BY created_at LIMIT 1) AS p2
  FROM public.projects p JOIN public.profiles pr ON pr.id = p.user_id
  WHERE p.custom_domain <> '' AND p.published_slug IS NOT NULL ORDER BY p.created_at LIMIT 1;

-- ── A. shape / privileges ────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('project_deploys exists with RLS on',
  (SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.project_deploys'::regclass), 'true');
SELECT pg_temp.expect('projects.published_version exists',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='projects' AND column_name='published_version'), '1');
SELECT pg_temp.expect('anon can NOT read project_deploys',
  has_table_privilege('anon', 'public.project_deploys', 'SELECT')::text, 'false');
SELECT pg_temp.expect('authenticated can NOT write project_deploys',
  (has_table_privilege('authenticated', 'public.project_deploys', 'INSERT') OR has_table_privilege('authenticated', 'public.project_deploys', 'UPDATE')
   OR has_table_privilege('authenticated', 'public.project_deploys', 'DELETE'))::text, 'false');
SELECT pg_temp.expect('service_role can write project_deploys',
  has_table_privilege('service_role', 'public.project_deploys', 'INSERT')::text, 'true');
SELECT pg_temp.expect('anon CAN execute resolve_published_site (Worker uses the anon key)',
  has_function_privilege('anon', 'public.resolve_published_site(text,text,text)', 'EXECUTE')::text, 'true');

-- ── B. legacy site (no version yet) resolves from host and from username+slug ────────────────────────
SELECT pg_temp.expect('legacy: resolve by host -> legacy=true, no version',
  (SELECT string_agg(coalesce(version::text,'null') || ':' || legacy::text, ',') FROM public.resolve_published_site(p_host => (SELECT host FROM _c))), 'null:true');
SELECT pg_temp.expect('legacy: host match is case-insensitive',
  (SELECT count(*)::text FROM public.resolve_published_site(p_host => upper((SELECT host FROM _c)))), '1');
SELECT pg_temp.expect('legacy: resolve by username+slug',
  (SELECT count(*)::text FROM public.resolve_published_site(p_username => (SELECT uname FROM _c), p_slug => (SELECT slug FROM _c))), '1');
SELECT pg_temp.expect('resolve: unknown slug -> nothing',
  (SELECT count(*)::text FROM public.resolve_published_site(p_username => (SELECT uname FROM _c), p_slug => 'no-such-slug')), '0');
SELECT pg_temp.expect('resolve: unknown host -> nothing',
  (SELECT count(*)::text FROM public.resolve_published_site(p_host => 'nope.example.invalid')), '0');
SELECT pg_temp.expect('resolve: right slug under the WRONG username -> nothing',
  (SELECT count(*)::text FROM public.resolve_published_site(p_username => 'definitely-not-a-user', p_slug => (SELECT slug FROM _c))), '0');
SELECT pg_temp.expect('resolve works as anon',
  pg_temp.try_as('anon', NULL, format('SELECT * FROM public.resolve_published_site(p_host => %L)', (SELECT host FROM _c))), 'ok rows=1');

-- ── C. versioned site ────────────────────────────────────────────────────────────────────────────────
-- (try_as leaves the fake JWT claims set for the rest of the transaction; setup below runs as the DB owner)
SELECT set_config('request.jwt.claims', '', true);
INSERT INTO public.project_deploys (project_id, version, status, main_file, created_by) SELECT p1, 1, 'uploading', 'home.html', owner FROM _c;
UPDATE public.projects SET published_version = 1 WHERE id = (SELECT p1 FROM _c);
SELECT pg_temp.expect('versioned: a deploy still uploading is NOT served (pointer ignored, no half-published site)',
  (SELECT count(*)::text FROM public.resolve_published_site(p_host => (SELECT host FROM _c))), '0');
UPDATE public.project_deploys SET status = 'ready' WHERE project_id = (SELECT p1 FROM _c) AND version = 1;
SELECT pg_temp.expect('versioned: ready deploy -> version 1, legacy=false, main_file from the deploy',
  (SELECT string_agg(version::text || ':' || legacy::text || ':' || main_file, ',') FROM public.resolve_published_site(p_host => (SELECT host FROM _c))), '1:false:home.html');
INSERT INTO public.project_deploys (project_id, version, status, main_file) SELECT p1, 2, 'ready', 'index.html' FROM _c;
UPDATE public.projects SET published_version = 2 WHERE id = (SELECT p1 FROM _c);
SELECT pg_temp.expect('versioned: pointer move -> version 2 (publish)',
  (SELECT string_agg(version::text, ',') FROM public.resolve_published_site(p_host => (SELECT host FROM _c))), '2');
UPDATE public.projects SET published_version = 1 WHERE id = (SELECT p1 FROM _c);
SELECT pg_temp.expect('versioned: pointer move back -> version 1 (rollback)',
  (SELECT string_agg(version::text, ',') FROM public.resolve_published_site(p_host => (SELECT host FROM _c))), '1');
SELECT pg_temp.expect('versions are unique per project',
  pg_temp.try_as('service_role', NULL, format('INSERT INTO public.project_deploys (project_id, version) VALUES (%L, 2)', (SELECT p1 FROM _c))), 'unique_violation');

-- ── D. deploy history visibility ─────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('owner can read own deploy history',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('SELECT * FROM public.project_deploys WHERE project_id = %L', (SELECT p1 FROM _c))), 'ok rows=2');
SELECT pg_temp.expect('stranger sees no deploys',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), format('SELECT * FROM public.project_deploys WHERE project_id = %L', (SELECT p1 FROM _c))), 'ok rows=0');
SELECT pg_temp.expect('owner can NOT insert a deploy through the API',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('INSERT INTO public.project_deploys (project_id, version) VALUES (%L, 99)', (SELECT p1 FROM _c))), 'denied');
SELECT pg_temp.expect('anon can NOT read deploys',
  pg_temp.try_as('anon', NULL, 'SELECT * FROM public.project_deploys'), 'denied');

-- ── E. column guard ──────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('owner can NOT move the live pointer from the client',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('UPDATE public.projects SET published_version = 2 WHERE id = %L', (SELECT p1 FROM _c))), 'denied');
SELECT pg_temp.expect('owner can NOT write custom_domain from the client',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('UPDATE public.projects SET custom_domain = ''victim.example'' WHERE id = %L', (SELECT p1 FROM _c))), 'denied');
SELECT pg_temp.expect('owner can NOT flip custom_domain_verified from the client',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('UPDATE public.projects SET custom_domain_verified = NOT custom_domain_verified WHERE id = %L', (SELECT p1 FROM _c))), 'denied');
SELECT pg_temp.expect('owner CAN still save normal columns (name/files/main_file/published_files/slug)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('UPDATE public.projects SET name = name, files = files, main_file = main_file, published_slug = published_slug, published_files = published_files WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=1');
SELECT pg_temp.expect('service role CAN move the pointer',
  pg_temp.try_as('service_role', NULL, format('UPDATE public.projects SET published_version = 2 WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=1');
SELECT pg_temp.expect('service role CAN set custom_domain (custom-domain edge fn)',
  pg_temp.try_as('service_role', NULL, format('UPDATE public.projects SET custom_domain = ''new.example.com'' WHERE id = %L', (SELECT p1 FROM _c))), 'ok rows=1');
SELECT pg_temp.expect('two projects can NOT claim the same hostname',
  pg_temp.try_as('service_role', NULL, format('UPDATE public.projects SET custom_domain = %L WHERE id = %L', (SELECT upper(host) FROM _c), (SELECT p2 FROM _c))), 'unique_violation');
SELECT pg_temp.expect('many projects may have NO domain (empty string / NULL are exempt)',
  pg_temp.try_as('service_role', NULL, format('UPDATE public.projects SET custom_domain = '''' WHERE id = %L', (SELECT p2 FROM _c))), 'ok rows=1');

-- ── report (RAISE aborts + rolls back everything above) ──────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
