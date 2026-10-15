-- REVAMP Step 7 — verification of supabase/migrations/20261014100000_stage_engine.sql (stage engine).
--
-- Run against production:   supabase db query --linked -f supabase/tests/step7_stage_engine.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: splice the migration (minus its BEGIN/COMMIT/NOTIFY) in front of the "-- ── A." marker
-- (python: split this file on that marker; the "BEFORE" run is expected to fail at the first missing object).
--
-- Test data: two throwaway projects (vxt_stage_a/b) owned by the oldest auth user plus project_members rows for two other
-- users — all inside the transaction, all rolled back. No real project is read or changed.
BEGIN;

CREATE TEMP TABLE _t (n serial, name text, passed boolean, got text);

-- LIKE match; but when the expectation looks like JSON ('{…' or '[…') the two sides are compared as jsonb, so key order and
-- spacing don't matter. A NULL expectation means "the value is NULL".
CREATE FUNCTION pg_temp.expect(p_name text, p_got text, p_want_like text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF p_want_like LIKE '{%' OR p_want_like LIKE '[%' THEN
    BEGIN ok := p_got::jsonb = p_want_like::jsonb; EXCEPTION WHEN OTHERS THEN ok := false; END;
  ELSE
    ok := coalesce(p_got LIKE p_want_like, p_got IS NULL AND p_want_like IS NULL);
  END IF;
  INSERT INTO _t(name, passed, got) VALUES (p_name, coalesce(ok, false), p_got);
END $$;

-- One statement as a real API role (SET LOCAL ROLE); its effects are always undone. Optionally evaluates p_after AFTER the
-- statement (as the session user, before the undo) so a test can see what the statement actually changed.
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

-- Persistent calls (their effects stay for the next statement). They run as the session user (postgres) with the JWT claims of
-- the caller being simulated — that exercises the RPC's own access checks; EXECUTE grants are covered by catalog checks + try_as.
CREATE FUNCTION pg_temp.as_(p_role text, p_uid uuid DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', CASE WHEN p_role IS NULL THEN '' ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true)
$$;

CREATE FUNCTION pg_temp.run(p_stmt text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  EXECUTE p_stmt INTO r;
  RETURN coalesce(r, 'null');
EXCEPTION
  WHEN insufficient_privilege THEN RETURN 'denied: ' || SQLERRM;
  WHEN OTHERS THEN RETURN 'error ' || SQLSTATE || ': ' || SQLERRM;
END $$;

-- "kind:vN" per artifact kind (latest version), "!" = stale. plpgsql so it can be created before the migration is spliced in.
CREATE FUNCTION pg_temp.state(p text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  SELECT coalesce(string_agg(kind || ':v' || version || CASE WHEN stale THEN '!' ELSE '' END, ',' ORDER BY kind), '')
    INTO r FROM public.project_artifacts_latest WHERE project_id = p;
  RETURN r;
END $$;

-- cast
CREATE TEMP TABLE _c AS
  SELECT (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 0) AS owner,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 1) AS stranger,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 2) AS member,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 3) AS pending;

-- ── A. catalog ─────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('project_artifacts has RLS enabled',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.project_artifacts'::regclass)::text, 'true');
SELECT pg_temp.expect('project_artifacts has a SELECT policy and NO write policy',
  (SELECT count(*) FILTER (WHERE cmd = 'SELECT') || '/' || count(*) FILTER (WHERE cmd <> 'SELECT') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'project_artifacts'), '1/0');
SELECT pg_temp.expect('anon has no privilege on project_artifacts',
  (has_table_privilege('anon', 'public.project_artifacts', 'SELECT') OR has_table_privilege('anon', 'public.project_artifacts', 'INSERT')
   OR has_table_privilege('anon', 'public.project_artifacts', 'UPDATE') OR has_table_privilege('anon', 'public.project_artifacts', 'DELETE'))::text, 'false');
SELECT pg_temp.expect('authenticated: SELECT only on project_artifacts',
  (has_table_privilege('authenticated', 'public.project_artifacts', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.project_artifacts', 'INSERT')
   AND NOT has_table_privilege('authenticated', 'public.project_artifacts', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.project_artifacts', 'DELETE')
   AND NOT has_table_privilege('authenticated', 'public.project_artifacts', 'TRUNCATE'))::text, 'true');
SELECT pg_temp.expect('latest view is security_invoker',
  (SELECT coalesce(reloptions::text, '') FROM pg_class WHERE oid = 'public.project_artifacts_latest'::regclass), '%security_invoker=true%');
SELECT pg_temp.expect('anon has no access to the latest view',
  has_table_privilege('anon', 'public.project_artifacts_latest', 'SELECT')::text, 'false');
SELECT pg_temp.expect('RPC EXECUTE: anon=no, authenticated=yes, service_role=yes (all three)',
  (SELECT string_agg(f || ':' || has_function_privilege('anon', f, 'EXECUTE') || '/' || has_function_privilege('authenticated', f, 'EXECUTE') || '/' || has_function_privilege('service_role', f, 'EXECUTE'), ' ' ORDER BY f)
     FROM unnest(ARRAY['public.put_project_artifact(text,text,jsonb,integer)', 'public.keep_project_artifact(text,text)', 'public.set_project_stage(text,text)']) f),
  'public.keep_project_artifact(text,text):false/true/true public.put_project_artifact(text,text,jsonb,integer):false/true/true public.set_project_stage(text,text):false/true/true');
SELECT pg_temp.expect('internal helpers are not callable by API roles',
  (SELECT bool_or(has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE'))::text
     FROM unnest(ARRAY['public.vx_stage_rules()', 'public.vx_stage_rank(text)', 'public.vx_stage_access(text)', 'public.vx_stage_blockers(text,text)', 'public.projects_guard_stage()']) f), 'false');
SELECT pg_temp.expect('projects.stage defaults to plan',
  (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'stage'), '''plan''::text');
SELECT pg_temp.expect('build_jobs: client may write project_id/user_id/status/prompt but NOT the stage columns',
  (has_column_privilege('authenticated', 'public.build_jobs', 'project_id', 'INSERT') AND has_column_privilege('authenticated', 'public.build_jobs', 'prompt', 'INSERT')
   AND has_column_privilege('authenticated', 'public.build_jobs', 'status', 'UPDATE')
   AND NOT has_column_privilege('authenticated', 'public.build_jobs', 'stage', 'INSERT') AND NOT has_column_privilege('authenticated', 'public.build_jobs', 'stage', 'UPDATE')
   AND NOT has_column_privilege('authenticated', 'public.build_jobs', 'artifact_kind', 'UPDATE') AND NOT has_column_privilege('authenticated', 'public.build_jobs', 'finished_at', 'UPDATE')
   AND NOT has_column_privilege('authenticated', 'public.build_jobs', 'error', 'UPDATE')
   AND NOT has_column_privilege('authenticated', 'public.build_jobs', 'heartbeat_at', 'UPDATE')
   AND NOT has_column_privilege('authenticated', 'public.build_jobs', 'heartbeat_at', 'INSERT'))::text, 'true');
SELECT pg_temp.expect('rules: 6 stages, 5 kinds, every requirement is a known kind',
  (SELECT (jsonb_array_length(r -> 'stages') || '/' || jsonb_array_length(r -> 'kinds') || '/' ||
           (SELECT bool_and((r -> 'kinds') ? k)::text FROM jsonb_each(r -> 'requires') e, jsonb_array_elements_text(e.value) k)) FROM (SELECT public.vx_stage_rules() r) x), '6/5/true');

-- test data
INSERT INTO public.projects (id, user_id, name) SELECT 'vxt_stage_a', owner, 'Stage test A' FROM _c;
INSERT INTO public.projects (id, user_id, name) SELECT 'vxt_stage_b', owner, 'Stage test B' FROM _c;
INSERT INTO public.project_members (project_id, user_id, status)
  SELECT 'vxt_stage_a', member, 'accepted' FROM _c UNION ALL SELECT 'vxt_stage_a', pending, 'pending' FROM _c;

-- ── B. rules (platform view: no claims) ────────────────────────────────────────────────────────────
SELECT pg_temp.as_(NULL);
SELECT pg_temp.expect('rank: plan=0 … business=5, unknown=NULL',
  (SELECT string_agg(coalesce(public.vx_stage_rank(s)::text, 'null'), ',' ORDER BY ord) FROM unnest(ARRAY['plan','example','build','tweaks','launch','business','bogus']) WITH ORDINALITY u(s, ord)), '0,1,2,3,4,5,null');
SELECT pg_temp.expect('blockers(plan) = none', public.vx_stage_blockers('vxt_stage_b', 'plan')::text, '[]');
SELECT pg_temp.expect('blockers(example) needs a plan',
  public.vx_stage_blockers('vxt_stage_b', 'example')::text, '[{"kind": "plan", "reason": "missing"}]');
SELECT pg_temp.expect('blockers(launch) lists every missing artifact in order',
  (SELECT string_agg(e ->> 'kind', ',') FROM jsonb_array_elements(public.vx_stage_blockers('vxt_stage_b', 'launch')) e), 'plan,style_spec,manifest,launch_checks');
SELECT pg_temp.expect('blockers(business) needs a live site',
  public.vx_stage_blockers('vxt_stage_b', 'business')::text, '[{"kind": "published", "reason": "missing"}]');
SELECT pg_temp.expect('unknown project: platform gets "not found", not a silent success',
  pg_temp.run($q$ SELECT public.put_project_artifact('nope_nope', 'plan', '{}') $q$), 'error P0002%');

-- ── C. artifacts + stale-marking (same scenario as studio test stages.test.ts — keep them in step) ──
SELECT pg_temp.as_('authenticated', (SELECT owner FROM _c));
SELECT pg_temp.expect('owner saves plan → v1',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{"schema":1,"name":"A"}')::text $q$), '{"kind": "plan", "version": 1, "staled": []}');
SELECT pg_temp.expect('state 1', pg_temp.state('vxt_stage_a'), 'plan:v1');
SELECT pg_temp.expect('owner saves style_spec → v1',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'style_spec', '{"schema":1,"locked":false}')::text $q$), '{"kind": "style_spec", "version": 1, "staled": []}');

SELECT pg_temp.as_('service_role');
SELECT pg_temp.expect('platform saves manifest → v1',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'manifest', '{"schema":1}')::text $q$), '{"kind": "manifest", "version": 1, "staled": []}');
SELECT pg_temp.expect('platform saves launch_checks → v1',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'launch_checks', '{"schema":1}')::text $q$), '{"kind": "launch_checks", "version": 1, "staled": []}');
SELECT pg_temp.expect('state 4', pg_temp.state('vxt_stage_a'), 'launch_checks:v1,manifest:v1,plan:v1,style_spec:v1');

SELECT pg_temp.as_('authenticated', (SELECT owner FROM _c));
SELECT pg_temp.expect('editing the plan reports what it made stale',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{"schema":1,"name":"A2"}')::text $q$), '{"kind": "plan", "version": 2, "staled": ["launch_checks", "manifest", "style_spec"]}');
SELECT pg_temp.expect('state 5: plan v2, everything downstream stale', pg_temp.state('vxt_stage_a'), 'launch_checks:v1!,manifest:v1!,plan:v2,style_spec:v1!');
SELECT pg_temp.expect('keep style_spec → cleared',
  pg_temp.run($q$ SELECT public.keep_project_artifact('vxt_stage_a', 'style_spec')::text $q$), '{"kind": "style_spec", "version": 1, "cleared": true}');
SELECT pg_temp.expect('state 6', pg_temp.state('vxt_stage_a'), 'launch_checks:v1!,manifest:v1!,plan:v2,style_spec:v1');
SELECT pg_temp.expect('keeping an already-fresh artifact is a no-op',
  pg_temp.run($q$ SELECT public.keep_project_artifact('vxt_stage_a', 'style_spec')::text $q$), '{"kind": "style_spec", "version": 1, "cleared": false}');
SELECT pg_temp.expect('new style_spec version (already-stale downstream stays stale, nothing else flips)',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'style_spec', '{"schema":1,"locked":true}')::text $q$), '{"kind": "style_spec", "version": 2, "staled": []}');
SELECT pg_temp.expect('state 7', pg_temp.state('vxt_stage_a'), 'launch_checks:v1!,manifest:v1!,plan:v2,style_spec:v2');
SELECT pg_temp.expect('keep manifest (the owner vouches for the built site)',
  pg_temp.run($q$ SELECT public.keep_project_artifact('vxt_stage_a', 'manifest')::text $q$), '{"kind": "manifest", "version": 1, "cleared": true}');
SELECT pg_temp.expect('state 8', pg_temp.state('vxt_stage_a'), 'launch_checks:v1!,manifest:v1,plan:v2,style_spec:v2');

SELECT pg_temp.as_('service_role');
SELECT pg_temp.expect('platform re-verifies → launch_checks v2',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'launch_checks', '{"schema":1}')::text $q$), '{"kind": "launch_checks", "version": 2, "staled": []}');
SELECT pg_temp.expect('state 9', pg_temp.state('vxt_stage_a'), 'launch_checks:v2,manifest:v1,plan:v2,style_spec:v2');
SELECT pg_temp.expect('a new manifest makes launch_checks stale',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'manifest', '{"schema":1}')::text $q$), '{"kind": "manifest", "version": 2, "staled": ["launch_checks"]}');
SELECT pg_temp.expect('state 10', pg_temp.state('vxt_stage_a'), 'launch_checks:v2!,manifest:v2,plan:v2,style_spec:v2');
SELECT pg_temp.expect('business_state is never made stale by upstream edits',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'business_state', '{"schema":1}')::text $q$), '{"kind": "business_state", "version": 1, "staled": []}');
SELECT pg_temp.as_('authenticated', (SELECT owner FROM _c));
SELECT pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{"schema":1,"name":"A3"}')::text $q$);
SELECT pg_temp.expect('state 12: plan v3 — business_state untouched, the rest stale',
  pg_temp.state('vxt_stage_a'), 'business_state:v1,launch_checks:v2!,manifest:v2!,plan:v3,style_spec:v2!');

-- ── D. RPC rules and errors ────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('owner can NOT write a platform-only kind (manifest)',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'manifest', '{"schema":1,"forged":true}') $q$), 'denied%');
SELECT pg_temp.expect('owner can NOT write launch_checks (a forged "verifier passed")',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'launch_checks', '{"schema":1,"ok":true}') $q$), 'denied%');
SELECT pg_temp.expect('owner can NOT write business_state',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'business_state', '{}') $q$), 'denied%');
SELECT pg_temp.expect('owner can NOT keep launch_checks (must be re-verified)',
  pg_temp.run($q$ SELECT public.keep_project_artifact('vxt_stage_a', 'launch_checks') $q$), 'denied%');
SELECT pg_temp.expect('nothing was written by the denied calls', pg_temp.state('vxt_stage_a'), 'business_state:v1,launch_checks:v2!,manifest:v2!,plan:v3,style_spec:v2!');
SELECT pg_temp.expect('unknown kind rejected',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'bogus', '{}') $q$), 'error 22023%');
SELECT pg_temp.expect('NULL kind rejected',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', NULL, '{}') $q$), 'error 22023%');
SELECT pg_temp.expect('non-object data rejected (array)',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '[1,2]') $q$), 'error 22023%');
SELECT pg_temp.expect('non-object data rejected (string)',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '"x"') $q$), 'error 22023%');
SELECT pg_temp.expect('NULL data rejected',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', NULL) $q$), 'error 22023%');
SELECT pg_temp.expect('oversized artifact rejected (>256 KB)',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', jsonb_build_object('blob', repeat('x', 270000))) $q$), 'error 54000%');
SELECT pg_temp.expect('optimistic concurrency: stale expected_version → PT409 (HTTP 409)',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{"schema":1}', 2) $q$), 'error PT409%');
SELECT pg_temp.expect('optimistic concurrency: matching expected_version succeeds (→ v4)',
  pg_temp.run($q$ SELECT (public.put_project_artifact('vxt_stage_a', 'plan', '{"schema":1,"name":"A4"}', 3) ->> 'version') $q$), '4');
SELECT pg_temp.expect('expected_version=0 means "no artifact yet"',
  pg_temp.run($q$ SELECT (public.put_project_artifact('vxt_stage_b', 'plan', '{"schema":1}', 0) ->> 'version') $q$), '1');
SELECT pg_temp.expect('expected_version=0 conflicts when one exists',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_b', 'plan', '{"schema":1}', 0) $q$), 'error PT409%');
SELECT pg_temp.expect('keep on a kind that has no artifact yet → version null, nothing cleared',
  pg_temp.run($q$ SELECT public.keep_project_artifact('vxt_stage_b', 'style_spec')::text $q$), '{"kind": "style_spec", "version": null, "cleared": false}');
SELECT pg_temp.expect('unknown stage rejected',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_a', 'bogus') $q$), 'error 22023%');

-- access: stranger / pending / anon / unknown project (and the error must not reveal which)
SELECT pg_temp.as_('authenticated', (SELECT stranger FROM _c));
SELECT pg_temp.expect('stranger can NOT put',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{}') $q$), 'denied: project not found or not allowed');
SELECT pg_temp.expect('stranger can NOT keep',
  pg_temp.run($q$ SELECT public.keep_project_artifact('vxt_stage_a', 'plan') $q$), 'denied: project not found or not allowed');
SELECT pg_temp.expect('stranger can NOT move the stage',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_a', 'example') $q$), 'denied: project not found or not allowed');
SELECT pg_temp.expect('unknown project looks identical to a stranger (no id probing)',
  pg_temp.run($q$ SELECT public.put_project_artifact('nope_nope', 'plan', '{}') $q$), 'denied: project not found or not allowed');
SELECT pg_temp.as_('authenticated', (SELECT pending FROM _c));
SELECT pg_temp.expect('pending invitee can NOT put',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{}') $q$), 'denied%');
SELECT pg_temp.as_('anon');
SELECT pg_temp.expect('anon claims can NOT put',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{}') $q$), 'denied%');
SELECT pg_temp.as_('authenticated', NULL);
SELECT pg_temp.expect('authenticated claims without a user id can NOT put',
  pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{}') $q$), 'denied%');
SELECT pg_temp.as_('authenticated', (SELECT member FROM _c));
SELECT pg_temp.expect('ACCEPTED collaborator can put a plan (→ v5)',
  pg_temp.run($q$ SELECT (public.put_project_artifact('vxt_stage_a', 'plan', '{"schema":1,"name":"by member"}') ->> 'version') $q$), '5');
SELECT pg_temp.expect('…and is recorded as the author',
  (SELECT (created_by = (SELECT member FROM _c))::text FROM public.project_artifacts WHERE project_id = 'vxt_stage_a' AND kind = 'plan' AND version = 5), 'true');
SELECT pg_temp.expect('platform-written artifacts have no author',
  (SELECT created_by::text FROM public.project_artifacts WHERE project_id = 'vxt_stage_a' AND kind = 'manifest' AND version = 2), NULL);
SELECT pg_temp.as_(NULL);

-- real roles (not just claims): EXECUTE grants + definer context
SELECT pg_temp.expect('anon role can NOT call put_project_artifact (EXECUTE revoked)',
  pg_temp.try_as('anon', NULL, $q$ SELECT public.put_project_artifact('vxt_stage_a', 'plan', '{}') $q$), 'denied');
SELECT pg_temp.expect('anon role can NOT call set_project_stage',
  pg_temp.try_as('anon', NULL, $q$ SELECT public.set_project_stage('vxt_stage_a', 'plan') $q$), 'denied');
SELECT pg_temp.expect('authenticated role can NOT call the internal rules helper',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.vx_stage_rules() $q$), 'denied');
SELECT pg_temp.expect('authenticated role can NOT call vx_stage_blockers',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.vx_stage_blockers('vxt_stage_a', 'launch') $q$), 'denied');
SELECT pg_temp.expect('owner as the real authenticated role: put works through the definer RPC',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.put_project_artifact('vxt_stage_b', 'style_spec', '{"schema":1}') $q$,
    $q$ SELECT pg_temp.state('vxt_stage_b') $q$), 'ok rows=1 | plan:v1,style_spec:v1');
SELECT pg_temp.expect('owner as the real authenticated role: set_project_stage works (the guard trigger lets the definer through)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.set_project_stage('vxt_stage_b', 'example') $q$,
    $q$ SELECT stage FROM public.projects WHERE id = 'vxt_stage_b' $q$), 'ok rows=1 | example');
SELECT pg_temp.expect('platform-only kind through the real authenticated role is still refused',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT public.put_project_artifact('vxt_stage_b', 'manifest', '{}') $q$), 'denied');
SELECT pg_temp.expect('service_role can write a platform-only kind',
  pg_temp.try_as('service_role', NULL, $q$ SELECT public.put_project_artifact('vxt_stage_b', 'manifest', '{}') $q$,
    $q$ SELECT pg_temp.state('vxt_stage_b') $q$), 'ok rows=1 | manifest:v1,plan:v1');

-- ── E. stage moves ─────────────────────────────────────────────────────────────────────────────────
-- vxt_stage_b already holds a few artifacts from section D; start this section from a clean slate.
SELECT pg_temp.as_(NULL);
DELETE FROM public.project_artifacts WHERE project_id = 'vxt_stage_b';
UPDATE public.projects SET stage = 'plan' WHERE id = 'vxt_stage_b';
SELECT pg_temp.as_('authenticated', (SELECT owner FROM _c));
SELECT pg_temp.expect('example is blocked without a plan',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'example')::text $q$), '{"ok": false, "stage": "plan", "blocked_by": [{"kind": "plan", "reason": "missing"}]}');
SELECT pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_b', 'plan', '{"schema":1,"name":"B"}') $q$);
SELECT pg_temp.expect('with a plan, example opens',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'example')::text $q$), '{"ok": true, "stage": "example", "blocked_by": []}');
SELECT pg_temp.expect('…and the project row follows', (SELECT stage FROM public.projects WHERE id = 'vxt_stage_b'), 'example');
SELECT pg_temp.expect('build is blocked until a style exists',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'build')::text $q$), '{"ok": false, "stage": "example", "blocked_by": [{"kind": "style_spec", "reason": "missing"}]}');
SELECT pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_b', 'style_spec', '{"schema":1,"locked":false}') $q$);
SELECT pg_temp.expect('build is blocked until the style is LOCKED',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'build')::text $q$), '{"ok": false, "stage": "example", "blocked_by": [{"kind": "style_spec", "reason": "flag:locked"}]}');
SELECT pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_b', 'style_spec', '{"schema":1,"locked":true}') $q$);
SELECT pg_temp.expect('locked style → build opens',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'build')::text $q$), '{"ok": true, "stage": "build", "blocked_by": []}');
SELECT pg_temp.expect('launch is blocked: no manifest and no verifier result yet',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'launch')::text $q$),
  '{"ok": false, "stage": "build", "blocked_by": [{"kind": "manifest", "reason": "missing"}, {"kind": "launch_checks", "reason": "missing"}]}');
SELECT pg_temp.expect('tweaks is blocked without a manifest',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'tweaks')::text $q$), '{"ok": false, "stage": "build", "blocked_by": [{"kind": "manifest", "reason": "missing"}]}');
SELECT pg_temp.as_('service_role');
SELECT pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_b', 'manifest', '{"schema":1}') $q$);
SELECT pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_b', 'launch_checks', '{"schema":1}') $q$);
SELECT pg_temp.as_('authenticated', (SELECT owner FROM _c));
SELECT pg_temp.expect('with everything fresh, launch opens (a forward jump of two stages is fine)',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'launch')::text $q$), '{"ok": true, "stage": "launch", "blocked_by": []}');
SELECT pg_temp.expect('going back is always allowed',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'tweaks')::text $q$), '{"ok": true, "stage": "tweaks", "blocked_by": []}');
SELECT pg_temp.expect('staying put is allowed',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'tweaks')::text $q$), '{"ok": true, "stage": "tweaks", "blocked_by": []}');
SELECT pg_temp.run($q$ SELECT public.put_project_artifact('vxt_stage_b', 'plan', '{"schema":1,"name":"B edited"}') $q$);
SELECT pg_temp.expect('after a plan edit the downstream artifacts are stale',
  pg_temp.state('vxt_stage_b'), 'launch_checks:v1!,manifest:v1!,plan:v2,style_spec:v2!');
SELECT pg_temp.expect('a stale chain blocks going forward (reasons are "stale")',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'launch')::text $q$),
  '{"ok": false, "stage": "tweaks", "blocked_by": [{"kind": "style_spec", "reason": "stale"}, {"kind": "manifest", "reason": "stale"}, {"kind": "launch_checks", "reason": "stale"}]}');
SELECT pg_temp.expect('…but the current stage is NOT yanked away from the user', (SELECT stage FROM public.projects WHERE id = 'vxt_stage_b'), 'tweaks');
SELECT pg_temp.expect('a stale artifact does not stop going back to plan',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'plan')::text $q$), '{"ok": true, "stage": "plan", "blocked_by": []}');
SELECT pg_temp.expect('business is blocked while nothing is published',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'business')::text $q$), '{"ok": false, "stage": "plan", "blocked_by": [{"kind": "published", "reason": "missing"}]}');
SELECT pg_temp.as_(NULL);
UPDATE public.projects SET published_version = 1 WHERE id = 'vxt_stage_b';
SELECT pg_temp.as_('authenticated', (SELECT owner FROM _c));
SELECT pg_temp.expect('once published, business opens without any artifact',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_b', 'business')::text $q$), '{"ok": true, "stage": "business", "blocked_by": []}');
UPDATE public.projects SET stage = 'tweaks' WHERE id = 'vxt_stage_a';
SELECT pg_temp.as_('authenticated', (SELECT member FROM _c));
SELECT pg_temp.expect('an accepted collaborator can move the stage back',
  pg_temp.run($q$ SELECT public.set_project_stage('vxt_stage_a', 'plan')::text $q$), '{"ok": true, "stage": "plan", "blocked_by": []}');
SELECT pg_temp.expect('…and the project row follows', (SELECT stage FROM public.projects WHERE id = 'vxt_stage_a'), 'plan');
SELECT pg_temp.as_(NULL);

-- ── F. direct writes to projects.stage ─────────────────────────────────────────────────────────────
SELECT pg_temp.expect('owner can NOT set the stage directly',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.projects SET stage = 'launch' WHERE id = 'vxt_stage_a' $q$), 'denied');
SELECT pg_temp.expect('accepted collaborator can NOT set the stage directly',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), $q$ UPDATE public.projects SET stage = 'launch' WHERE id = 'vxt_stage_a' $q$), 'denied');
SELECT pg_temp.expect('owner can still save other columns (the guard does not get in the editor''s way)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.projects SET name = 'renamed', stage = stage WHERE id = 'vxt_stage_a' $q$), 'ok rows=1');
SELECT pg_temp.expect('service_role can set the stage',
  pg_temp.try_as('service_role', NULL, $q$ UPDATE public.projects SET stage = 'tweaks' WHERE id = 'vxt_stage_a' $q$), 'ok rows=1');
SELECT pg_temp.expect('a client-made project starts at plan (default)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('INSERT INTO public.projects (id, user_id, name) VALUES (%L, %L, ''x'')', 'vxt_stage_c', (SELECT owner FROM _c)),
    $q$ SELECT stage FROM public.projects WHERE id = 'vxt_stage_c' $q$), 'ok rows=1 | plan');
SELECT pg_temp.expect('a client can NOT create a project already at launch',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('INSERT INTO public.projects (id, user_id, name, stage) VALUES (%L, %L, ''x'', ''launch'')', 'vxt_stage_c', (SELECT owner FROM _c))), 'denied');
SELECT pg_temp.expect('invalid stage value hits the CHECK',
  pg_temp.try_as('service_role', NULL, $q$ UPDATE public.projects SET stage = 'bogus' WHERE id = 'vxt_stage_a' $q$), 'error 23514%');

-- ── G. RLS reads ───────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('owner reads the artifacts',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT * FROM public.project_artifacts WHERE project_id = 'vxt_stage_a' $q$), 'ok rows=12');
SELECT pg_temp.expect('accepted collaborator reads them too',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), $q$ SELECT * FROM public.project_artifacts WHERE project_id = 'vxt_stage_a' $q$), 'ok rows=12');
SELECT pg_temp.expect('a pending invitee sees nothing',
  pg_temp.try_as('authenticated', (SELECT pending FROM _c), $q$ SELECT * FROM public.project_artifacts WHERE project_id = 'vxt_stage_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('a stranger sees nothing',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), $q$ SELECT * FROM public.project_artifacts WHERE project_id = 'vxt_stage_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('anon is denied outright',
  pg_temp.try_as('anon', NULL, $q$ SELECT * FROM public.project_artifacts $q$), 'denied');
SELECT pg_temp.expect('latest view: owner sees one row per kind (5)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT * FROM public.project_artifacts_latest WHERE project_id = 'vxt_stage_a' $q$), 'ok rows=5');
SELECT pg_temp.expect('latest view: stranger sees nothing (RLS applies through the view)',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), $q$ SELECT * FROM public.project_artifacts_latest WHERE project_id = 'vxt_stage_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('latest view: anon denied',
  pg_temp.try_as('anon', NULL, $q$ SELECT * FROM public.project_artifacts_latest $q$), 'denied');
SELECT pg_temp.expect('owner can NOT insert an artifact directly',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ INSERT INTO public.project_artifacts (project_id, kind, version, data) VALUES ('vxt_stage_a', 'plan', 99, '{}') $q$), 'denied');
SELECT pg_temp.expect('owner can NOT update an artifact directly (e.g. clear a stale flag)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.project_artifacts SET stale = false WHERE project_id = 'vxt_stage_a' $q$), 'denied');
SELECT pg_temp.expect('owner can NOT delete artifacts directly',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ DELETE FROM public.project_artifacts WHERE project_id = 'vxt_stage_a' $q$), 'denied');
SELECT pg_temp.expect('the table CHECK still rejects a non-object, even from the platform',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.project_artifacts (project_id, kind, version, data) VALUES ('vxt_stage_a', 'plan', 99, '[]') $q$), 'error 23514%');

-- ── H. build_jobs (old editor path must keep working; stage columns are platform-only) ─────────────
INSERT INTO public.build_jobs (id, project_id, user_id, status, prompt)
  SELECT '00000000-0000-4000-8000-0000000000a1', 'vxt_stage_a', owner, 'running', 'legacy job' FROM _c;
SELECT pg_temp.expect('old editor: INSERT {project_id,user_id,status,prompt} + RETURNING id',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('INSERT INTO public.build_jobs (project_id, user_id, status, prompt) VALUES (%L, %L, ''running'', ''p'') RETURNING id', 'vxt_stage_a', (SELECT owner FROM _c))), 'ok rows=1');
SELECT pg_temp.expect('old editor: UPDATE status = complete on its own job',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.build_jobs SET status = 'complete' WHERE project_id = 'vxt_stage_a' AND status = 'running' $q$), 'ok rows=1');
SELECT pg_temp.expect('old editor: SELECT own running job',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT id, prompt FROM public.build_jobs WHERE project_id = 'vxt_stage_a' AND status = 'running' $q$), 'ok rows=1');
SELECT pg_temp.expect('a client can NOT mint a stage job',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), format('INSERT INTO public.build_jobs (project_id, user_id, status, prompt, stage) VALUES (%L, %L, ''running'', ''p'', ''launch'')', 'vxt_stage_a', (SELECT owner FROM _c))), 'denied');
SELECT pg_temp.expect('a client can NOT turn a job into a stage job',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.build_jobs SET stage = 'launch' WHERE project_id = 'vxt_stage_a' $q$), 'denied');
SELECT pg_temp.expect('a client can NOT write finished_at/error/artifact_kind',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.build_jobs SET error = 'x' WHERE project_id = 'vxt_stage_a' $q$), 'denied');
SELECT pg_temp.expect('a client can NOT forge a heartbeat',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.build_jobs SET heartbeat_at = now() WHERE project_id = 'vxt_stage_a' $q$), 'denied');
SELECT pg_temp.expect('service_role can stamp a heartbeat',
  pg_temp.try_as('service_role', NULL, $q$ UPDATE public.build_jobs SET heartbeat_at = now() WHERE id = '00000000-0000-4000-8000-0000000000a1' $q$), 'ok rows=1');
SELECT pg_temp.expect('a stranger can not touch the owner''s job',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), $q$ UPDATE public.build_jobs SET status = 'complete' WHERE project_id = 'vxt_stage_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('status CHECK rejects junk',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.build_jobs SET status = 'bogus' WHERE project_id = 'vxt_stage_a' $q$), 'error 23514%');
SELECT pg_temp.expect('anon has no access to build_jobs',
  pg_temp.try_as('anon', NULL, $q$ SELECT * FROM public.build_jobs $q$), 'denied');
SELECT pg_temp.expect('service_role can create a stage job and finish it',
  pg_temp.try_as('service_role', NULL, format('INSERT INTO public.build_jobs (project_id, user_id, status, prompt, stage, artifact_kind) VALUES (%L, %L, ''running'', ''p'', ''plan'', ''plan'')', 'vxt_stage_a', (SELECT owner FROM _c)),
    $q$ SELECT count(*) FROM public.build_jobs WHERE stage = 'plan' $q$), 'ok rows=1 | 1');
SELECT pg_temp.expect('service_role can mark a job failed with an error',
  pg_temp.try_as('service_role', NULL, $q$ UPDATE public.build_jobs SET status = 'failed', error = 'boom', finished_at = now() WHERE id = '00000000-0000-4000-8000-0000000000a1' $q$), 'ok rows=1');

-- ── I. pruning, cascade ────────────────────────────────────────────────────────────────────────────
INSERT INTO public.projects (id, user_id, name) SELECT 'vxt_stage_d', owner, 'prune' FROM _c;
SELECT pg_temp.as_(NULL);
SELECT public.put_project_artifact('vxt_stage_d', 'plan', jsonb_build_object('schema', 1, 'i', g)) FROM generate_series(1, 25) g;
SELECT pg_temp.expect('only the newest 20 versions are kept (6..25)',
  (SELECT count(*) || ' ' || min(version) || '-' || max(version) FROM public.project_artifacts WHERE project_id = 'vxt_stage_d' AND kind = 'plan'), '20 6-25');
SELECT pg_temp.expect('the latest view returns version 25',
  (SELECT version::text FROM public.project_artifacts_latest WHERE project_id = 'vxt_stage_d' AND kind = 'plan'), '25');
DELETE FROM public.projects WHERE id = 'vxt_stage_d';
SELECT pg_temp.expect('deleting a project removes its artifacts',
  (SELECT count(*)::text FROM public.project_artifacts WHERE project_id = 'vxt_stage_d'), '0');

-- ── report (RAISE aborts + rolls back everything above) ────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
