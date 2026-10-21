-- REVAMP Step 8 — verification of supabase/migrations/20261021100000_stage_messages.sql (per-stage chat history).
--
-- Run against production:   supabase db query --linked -f supabase/tests/step8_stage_messages.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: splice the migration (minus its BEGIN/COMMIT/NOTIFY) in front of the "-- ── A." marker.
--
-- Test data: throwaway projects (vxt_msg_*) owned by the oldest auth user, with member rows for two other users — all inside the
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

-- ── A. catalog ─────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('stage_messages has RLS enabled',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stage_messages'::regclass)::text, 'true');
SELECT pg_temp.expect('stage_messages has a SELECT policy and NO write policy',
  (SELECT count(*) FILTER (WHERE cmd = 'SELECT') || '/' || count(*) FILTER (WHERE cmd <> 'SELECT') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stage_messages'), '1/0');
SELECT pg_temp.expect('anon has no privilege on stage_messages',
  (has_table_privilege('anon', 'public.stage_messages', 'SELECT') OR has_table_privilege('anon', 'public.stage_messages', 'INSERT')
   OR has_table_privilege('anon', 'public.stage_messages', 'UPDATE') OR has_table_privilege('anon', 'public.stage_messages', 'DELETE'))::text, 'false');
SELECT pg_temp.expect('authenticated: SELECT only',
  (has_table_privilege('authenticated', 'public.stage_messages', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.stage_messages', 'INSERT')
   AND NOT has_table_privilege('authenticated', 'public.stage_messages', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.stage_messages', 'DELETE')
   AND NOT has_table_privilege('authenticated', 'public.stage_messages', 'TRUNCATE'))::text, 'true');
SELECT pg_temp.expect('service_role can write',
  (has_table_privilege('service_role', 'public.stage_messages', 'INSERT') AND has_table_privilege('service_role', 'public.stage_messages', 'SELECT'))::text, 'true');

-- test data
INSERT INTO public.projects (id, user_id, name) SELECT 'vxt_msg_a', owner, 'Msg test A' FROM _c;
INSERT INTO public.projects (id, user_id, name) SELECT 'vxt_msg_b', owner, 'Msg test B' FROM _c;
INSERT INTO public.project_members (project_id, user_id, status)
  SELECT 'vxt_msg_a', member, 'accepted' FROM _c UNION ALL SELECT 'vxt_msg_a', pending, 'pending' FROM _c;
INSERT INTO public.build_jobs (id, project_id, user_id, status, prompt, stage, artifact_kind)
  SELECT '00000000-0000-4000-8000-0000000000b1', 'vxt_msg_a', owner, 'running', 'hi', 'plan', 'plan' FROM _c;
INSERT INTO public.build_jobs (id, project_id, user_id, status, prompt, stage, artifact_kind)
  SELECT '00000000-0000-4000-8000-0000000000b2', 'vxt_msg_a', owner, 'running', 'again', 'plan', 'plan' FROM _c;
-- the platform (postgres here = service role in effect) writes a conversation
INSERT INTO public.stage_messages (project_id, stage, role, content, user_id, job_id, created_at)
  SELECT 'vxt_msg_a', 'plan', 'user', 'I want to sell candles', owner, '00000000-0000-4000-8000-0000000000b1', now() - interval '2 minutes' FROM _c;
INSERT INTO public.stage_messages (project_id, stage, role, content, user_id, job_id, created_at)
  SELECT 'vxt_msg_a', 'plan', 'assistant', 'Great — here is a first plan.', NULL, '00000000-0000-4000-8000-0000000000b1', now() - interval '1 minute' FROM _c;
INSERT INTO public.stage_messages (project_id, stage, role, content, user_id, created_at)
  SELECT 'vxt_msg_b', 'plan', 'user', 'secret idea of project B', owner, now() FROM _c;

-- ── B. who can read ────────────────────────────────────────────────────────────────────────────────
-- (the SELECT must run AS the role, so it is the statement itself; try_as reports its row count)
SELECT pg_temp.expect('owner reads their own project chat',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT * FROM public.stage_messages WHERE project_id = 'vxt_msg_a' $q$), 'ok rows=2');
SELECT pg_temp.expect('the project filter returns only that project''s chat',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ SELECT * FROM public.stage_messages WHERE project_id = 'vxt_msg_b' $q$), 'ok rows=1');
SELECT pg_temp.expect('an accepted collaborator reads the chat',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), $q$ SELECT * FROM public.stage_messages WHERE project_id = 'vxt_msg_a' $q$), 'ok rows=2');
SELECT pg_temp.expect('an accepted collaborator does NOT see a project they are not on',
  pg_temp.try_as('authenticated', (SELECT member FROM _c), $q$ SELECT * FROM public.stage_messages WHERE project_id = 'vxt_msg_b' $q$), 'ok rows=0');
SELECT pg_temp.expect('a pending invitee sees nothing',
  pg_temp.try_as('authenticated', (SELECT pending FROM _c), $q$ SELECT * FROM public.stage_messages WHERE project_id = 'vxt_msg_a' $q$), 'ok rows=0');
SELECT pg_temp.expect('a stranger sees nothing',
  pg_temp.try_as('authenticated', (SELECT stranger FROM _c), $q$ SELECT * FROM public.stage_messages $q$), 'ok rows=0');
SELECT pg_temp.expect('anon cannot read',
  pg_temp.try_as('anon', NULL, $q$ SELECT count(*) FROM public.stage_messages $q$), 'denied');

-- ── C. who can write (nobody but the platform) ─────────────────────────────────────────────────────
SELECT pg_temp.expect('the owner cannot insert a message (no forged "assistant" lines)',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c),
    $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'plan', 'assistant', 'I promise a free site') $q$), 'denied');
SELECT pg_temp.expect('the owner cannot edit a message',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ UPDATE public.stage_messages SET content = 'x' WHERE project_id = 'vxt_msg_a' $q$), 'denied');
SELECT pg_temp.expect('the owner cannot delete a message',
  pg_temp.try_as('authenticated', (SELECT owner FROM _c), $q$ DELETE FROM public.stage_messages WHERE project_id = 'vxt_msg_a' $q$), 'denied');
SELECT pg_temp.expect('anon cannot insert',
  pg_temp.try_as('anon', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'plan', 'user', 'x') $q$), 'denied');
SELECT pg_temp.expect('service_role can insert',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'plan', 'user', 'more') $q$), 'ok rows=1');

-- ── D. constraints ─────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('a run writes at most one line per role (unique job+role)',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content, job_id) VALUES ('vxt_msg_a', 'plan', 'assistant', 'second reply', '00000000-0000-4000-8000-0000000000b1') $q$), 'error 23505%');
SELECT pg_temp.expect('a different run may write its own lines',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content, job_id) VALUES ('vxt_msg_a', 'plan', 'user', 'again', '00000000-0000-4000-8000-0000000000b2') $q$), 'ok rows=1');
SELECT pg_temp.expect('lines without a job are not subject to the uniqueness rule',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'plan', 'user', 'a'), ('vxt_msg_a', 'plan', 'user', 'b') $q$), 'ok rows=2');
SELECT pg_temp.expect('unknown role is refused',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'plan', 'system', 'x') $q$), 'error 23514%');
SELECT pg_temp.expect('unknown stage is refused',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'bogus', 'user', 'x') $q$), 'error 23514%');
SELECT pg_temp.expect('empty content is refused',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'plan', 'user', '') $q$), 'error 23514%');
SELECT pg_temp.expect('content over 20000 characters is refused',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'plan', 'user', repeat('x', 20001)) $q$), 'error 23514%');
SELECT pg_temp.expect('exactly 20000 characters is fine',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_a', 'plan', 'user', repeat('x', 20000)) $q$), 'ok rows=1');
SELECT pg_temp.expect('a message for an unknown project is refused (foreign key)',
  pg_temp.try_as('service_role', NULL, $q$ INSERT INTO public.stage_messages (project_id, stage, role, content) VALUES ('vxt_msg_nope', 'plan', 'user', 'x') $q$), 'error 23503%');

-- ── E. lifecycle ───────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.stage_messages (project_id, stage, role, content, job_id)
  VALUES ('vxt_msg_a', 'plan', 'user', 'again', '00000000-0000-4000-8000-0000000000b2');
DELETE FROM public.build_jobs WHERE id = '00000000-0000-4000-8000-0000000000b2';
SELECT pg_temp.expect('deleting a job keeps the chat line (job_id becomes NULL)',
  (SELECT count(*) FILTER (WHERE job_id IS NULL AND content = 'again') || '/' || count(*) FILTER (WHERE content = 'again') FROM public.stage_messages WHERE project_id = 'vxt_msg_a'), '1/1');
DELETE FROM public.projects WHERE id = 'vxt_msg_a';
SELECT pg_temp.expect('deleting a project removes its chat',
  (SELECT count(*)::text FROM public.stage_messages WHERE project_id = 'vxt_msg_a'), '0');
SELECT pg_temp.expect('…and only that project''s chat',
  (SELECT count(*)::text FROM public.stage_messages WHERE project_id = 'vxt_msg_b'), '1');

-- ── report (RAISE aborts + rolls back everything above) ────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
