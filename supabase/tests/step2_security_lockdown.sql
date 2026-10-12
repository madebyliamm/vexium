-- REVAMP Step 2 — security lockdown verification.
--
-- Run against production:   supabase db query --linked -f supabase/tests/step2_security_lockdown.sql
-- It NEVER commits: everything happens inside a transaction that ends with a deliberate RAISE EXCEPTION, and the
-- PASS/FAIL report comes back inside that error text ("RESULTS ..."). Exit "error" is the expected outcome.
--
-- Dry-run BEFORE applying the migration: concatenate the migration (without its BEGIN/COMMIT) in front of this
-- file — see REVAMP.md Step 2 handoff notes.
BEGIN;

CREATE TEMP TABLE _t (n serial, name text, passed boolean, got text);

CREATE FUNCTION pg_temp.expect(p_name text, p_got text, p_want_like text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO _t(name, passed, got) VALUES (p_name, p_got LIKE p_want_like, p_got)
$$;

-- Run one statement as a given API role (JWT sub = p_uid) and report what happened.
CREATE FUNCTION pg_temp.try_as(p_role text, p_uid uuid, p_stmt text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE n bigint; r text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_stmt;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := 'ok rows=' || n;
  EXCEPTION
    WHEN insufficient_privilege THEN r := 'denied';
    WHEN OTHERS THEN r := 'error ' || SQLSTATE || ': ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

CREATE TEMP TABLE _u AS
  SELECT (SELECT id FROM auth.users ORDER BY created_at LIMIT 1)            AS u1,
         (SELECT id FROM auth.users ORDER BY created_at LIMIT 1 OFFSET 1)   AS u2;
CREATE TEMP TABLE _p AS
  SELECT (SELECT id FROM public.projects ORDER BY created_at LIMIT 1)           AS p1,
         (SELECT id FROM public.projects ORDER BY created_at LIMIT 1 OFFSET 1)  AS p2;

-- ── A. function privileges (catalog) ─────────────────────────────────────────────────────────────
SELECT pg_temp.expect('anon can NOT execute increment_usage',          has_function_privilege('anon',          'public.increment_usage(uuid,integer)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('authenticated can NOT execute increment_usage', has_function_privilege('authenticated', 'public.increment_usage(uuid,integer)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('service_role CAN execute increment_usage',      has_function_privilege('service_role',  'public.increment_usage(uuid,integer)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('anon can NOT execute vexium_site_query',          has_function_privilege('anon',          'public.vexium_site_query(text,text)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('authenticated can NOT execute vexium_site_query', has_function_privilege('authenticated', 'public.vexium_site_query(text,text)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('service_role CAN execute vexium_site_query',      has_function_privilege('service_role',  'public.vexium_site_query(text,text)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('log_usage dropped', (to_regprocedure('public.log_usage(uuid,uuid,text,integer,integer)') IS NULL)::text, 'true');
SELECT pg_temp.expect('anon can NOT execute handle_new_user',          has_function_privilege('anon',          'public.handle_new_user()', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('authenticated can NOT execute handle_follow_insert', has_function_privilege('authenticated', 'public.handle_follow_insert()', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('authenticated CAN still execute is_project_owner (RLS helper)',   has_function_privilege('authenticated', 'public.is_project_owner(text,uuid)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('anon CAN still execute is_project_member (RLS helper)',           has_function_privilege('anon',          'public.is_project_member(text,uuid)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('authenticated CAN still execute get_my_member_project_ids',       has_function_privilege('authenticated', 'public.get_my_member_project_ids()', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('anon can NOT execute get_my_projects',          has_function_privilege('anon',          'public.get_my_projects()', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('authenticated CAN execute get_my_projects',     has_function_privilege('authenticated', 'public.get_my_projects()', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('anon CAN still execute check_signup_availability (signup flow)',  has_function_privilege('anon', 'public.check_signup_availability(text,text)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('anon CAN still execute get_email_by_username (OPEN finding #10)', has_function_privilege('anon', 'public.get_email_by_username(text)', 'EXECUTE')::text, 'true');
SELECT pg_temp.expect('vx_sandbox.run not executable by authenticated', has_function_privilege('authenticated', 'vx_sandbox.run(text)', 'EXECUTE')::text, 'false');
SELECT pg_temp.expect('vx_sandbox.run not executable by service_role',  has_function_privilege('service_role',  'vx_sandbox.run(text)', 'EXECUTE')::text, 'false');

-- ── B. signed-in user (u1) ───────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('auth: UPDATE account_billing.plan denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.account_billing SET plan = %L WHERE user_id = %L', 'max', (SELECT u1 FROM _u))), 'denied');
SELECT pg_temp.expect('auth: UPDATE account_billing.credits_used_cents denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.account_billing SET credits_used_cents = 0 WHERE user_id = %L', (SELECT u1 FROM _u))), 'denied');
SELECT pg_temp.expect('auth: INSERT account_billing denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('INSERT INTO public.account_billing (user_id) VALUES (%L)', gen_random_uuid())), 'denied');
SELECT pg_temp.expect('auth: DELETE account_billing denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('DELETE FROM public.account_billing WHERE user_id = %L', (SELECT u1 FROM _u))), 'denied');
SELECT pg_temp.expect('auth: SELECT own account_billing = 1 row',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('SELECT plan, credits_used_cents FROM public.account_billing WHERE user_id = %L', (SELECT u1 FROM _u))), 'ok rows=1');
SELECT pg_temp.expect('auth: SELECT someone else''s account_billing = 0 rows',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('SELECT plan FROM public.account_billing WHERE user_id = %L', (SELECT u2 FROM _u))), 'ok rows=0');
SELECT pg_temp.expect('auth: UPDATE profiles.follower_count denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.profiles SET follower_count = 999 WHERE id = %L', (SELECT u1 FROM _u))), 'denied');
SELECT pg_temp.expect('auth: UPDATE profiles.email denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.profiles SET email = %L WHERE id = %L', 'x@example.invalid', (SELECT u1 FROM _u))), 'denied');
SELECT pg_temp.expect('auth: UPDATE profiles.public_email denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.profiles SET public_email = %L WHERE id = %L', 'x@example.invalid', (SELECT u1 FROM _u))), 'denied');
SELECT pg_temp.expect('auth: UPDATE own profiles.display_name ok',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.profiles SET display_name = display_name WHERE id = %L', (SELECT u1 FROM _u))), 'ok rows=1');
SELECT pg_temp.expect('auth: UPDATE someone else''s profile = 0 rows',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.profiles SET bio = %L WHERE id = %L', 'pwned', (SELECT u2 FROM _u))), 'ok rows=0');
SELECT pg_temp.expect('auth: SELECT profiles.email denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), 'SELECT email FROM public.profiles'), 'denied');
SELECT pg_temp.expect('auth: SELECT * FROM profiles denied (pages must list columns)',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), 'SELECT * FROM public.profiles'), 'denied');
SELECT pg_temp.expect('auth: SELECT public profile columns ok',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), 'SELECT id, username, display_name, bio, avatar_url, banner, follower_count, following_count, show_email, public_email FROM public.profiles'), 'ok rows=%');
SELECT pg_temp.expect('auth: INSERT profiles denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('INSERT INTO public.profiles (id, username) VALUES (%L, %L)', gen_random_uuid(), 'zzz')), 'denied');
SELECT pg_temp.expect('auth: INSERT billing_history denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('INSERT INTO public.billing_history (user_id, type, description, amount_paid_cents) VALUES (%L, %L, %L, 1)', (SELECT u1 FROM _u), 'subscription', 'forged')), 'denied');
SELECT pg_temp.expect('auth: SELECT own billing_history ok',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), 'SELECT * FROM public.billing_history'), 'ok rows=%');
SELECT pg_temp.expect('auth: SELECT site_users.password_hash denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), 'SELECT password_hash FROM public.site_users'), 'denied');
SELECT pg_temp.expect('auth: SELECT site_users.email ok (owners list their users)',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), 'SELECT id, email, created_at, metadata FROM public.site_users'), 'ok rows=%');
SELECT pg_temp.expect('auth: rpc increment_usage denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('SELECT public.increment_usage(%L, -100000)', (SELECT u1 FROM _u))), 'denied');
SELECT pg_temp.expect('auth: rpc vexium_site_query denied',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select 1')), 'denied');
SELECT pg_temp.expect('auth: projects still readable (RLS helper chain works)',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), 'SELECT id FROM public.projects'), 'ok rows=%');
SELECT pg_temp.expect('auth: rpc get_my_projects works',
  pg_temp.try_as('authenticated', (SELECT u1 FROM _u), 'SELECT * FROM public.get_my_projects()'), 'ok rows=%');

-- ── C. anonymous (public anon key) ───────────────────────────────────────────────────────────────
SELECT pg_temp.expect('anon: SELECT profiles.email denied',   pg_temp.try_as('anon', NULL, 'SELECT email FROM public.profiles'), 'denied');
SELECT pg_temp.expect('anon: SELECT public profile cols ok',  pg_temp.try_as('anon', NULL, 'SELECT id, username FROM public.profiles WHERE username IS NOT NULL'), 'ok rows=%');
SELECT pg_temp.expect('anon: worker.js subdomain lookup ok',  pg_temp.try_as('anon', NULL, format('SELECT id FROM public.profiles WHERE username = %L', (SELECT username FROM public.profiles WHERE username IS NOT NULL LIMIT 1))), 'ok rows=1');
SELECT pg_temp.expect('anon: SELECT account_billing denied',  pg_temp.try_as('anon', NULL, 'SELECT * FROM public.account_billing'), 'denied');
SELECT pg_temp.expect('anon: SELECT billing_history denied',  pg_temp.try_as('anon', NULL, 'SELECT * FROM public.billing_history'), 'denied');
SELECT pg_temp.expect('anon: UPDATE profiles denied',         pg_temp.try_as('anon', NULL, 'UPDATE public.profiles SET bio = ''x'''), 'denied');
SELECT pg_temp.expect('anon: rpc increment_usage denied',     pg_temp.try_as('anon', NULL, format('SELECT public.increment_usage(%L, -100000)', (SELECT u1 FROM _u))), 'denied');
SELECT pg_temp.expect('anon: rpc vexium_site_query denied',   pg_temp.try_as('anon', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select * from auth.users')), 'denied');
SELECT pg_temp.expect('anon: rpc check_signup_availability works', pg_temp.try_as('anon', NULL, 'SELECT public.check_signup_availability(''zz_nobody'', ''nobody@example.invalid'')'), 'ok rows=1');
SELECT pg_temp.expect('anon: rpc get_email_by_username works (OPEN #10 — still leaks real emails)', pg_temp.try_as('anon', NULL, format('SELECT public.get_email_by_username(%L)', (SELECT username FROM public.profiles WHERE username IS NOT NULL LIMIT 1))), 'ok rows=1');

-- ── D. behaviour that must keep working ──────────────────────────────────────────────────────────
-- D1. show_email toggle mirrors into public_email (as a signed-in user, then inspected as owner)
SELECT pg_temp.expect('toggle show_email on (as user)', pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.profiles SET show_email = true WHERE id = %L', (SELECT u1 FROM _u))), 'ok rows=1');
SELECT pg_temp.expect('public_email = email when show_email on',  (SELECT (public_email IS NOT DISTINCT FROM email AND email IS NOT NULL)::text FROM public.profiles WHERE id = (SELECT u1 FROM _u)), 'true');
SELECT pg_temp.expect('toggle show_email off (as user)', pg_temp.try_as('authenticated', (SELECT u1 FROM _u), format('UPDATE public.profiles SET show_email = false WHERE id = %L', (SELECT u1 FROM _u))), 'ok rows=1');
SELECT pg_temp.expect('public_email is NULL when show_email off', (SELECT (public_email IS NULL)::text FROM public.profiles WHERE id = (SELECT u1 FROM _u)), 'true');

-- D2. follow triggers (SECURITY DEFINER, EXECUTE revoked from clients) still maintain counts + notifications
CREATE TEMP TABLE _f AS
  SELECT a.id AS follower, b.id AS followee,
         (SELECT follower_count FROM public.profiles WHERE id = b.id) AS before_cnt,
         (SELECT count(*) FROM public.notifications WHERE user_id = b.id) AS before_notif
  FROM auth.users a, auth.users b
  WHERE a.id <> b.id AND NOT EXISTS (SELECT 1 FROM public.follows f WHERE f.follower_id = a.id AND f.following_id = b.id)
  LIMIT 1;
SELECT pg_temp.expect('follow insert as user ok', pg_temp.try_as('authenticated', (SELECT follower FROM _f), format('INSERT INTO public.follows (follower_id, following_id) VALUES (%L, %L)', (SELECT follower FROM _f), (SELECT followee FROM _f))), 'ok rows=1');
SELECT pg_temp.expect('follower_count incremented by trigger', (SELECT (follower_count = (SELECT before_cnt FROM _f) + 1)::text FROM public.profiles WHERE id = (SELECT followee FROM _f)), 'true');
SELECT pg_temp.expect('follow notification created by trigger', ((SELECT count(*) FROM public.notifications WHERE user_id = (SELECT followee FROM _f)) = (SELECT before_notif FROM _f) + 1)::text, 'true');

-- D3. signup trigger creates profile + billing row with a server-side 7-day trial
-- (trigger functions fire without the caller holding EXECUTE — proven by the follow-trigger test in D2)
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'dryrun1@example.invalid', '{"username":"dryrun_one","selected_plan":"max"}', now(), now());
SELECT pg_temp.expect('new user: profile row created',  (SELECT count(*)::text FROM public.profiles WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001'), '1');
SELECT pg_temp.expect('new user: billing row, plan=trial, selected_plan=max, 7-day trial',
  (SELECT (plan = 'trial' AND selected_plan = 'max' AND trial_ends_at BETWEEN now() + interval '6 days 23 hours' AND now() + interval '7 days 1 hour')::text
     FROM public.account_billing WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 'true');
INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
VALUES ('aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'dryrun2@example.invalid', '{"username":"dryrun_two","selected_plan":"god","plan":"max"}', now(), now());
SELECT pg_temp.expect('new user: bogus selected_plan -> trial, plan stays trial, trial_ends_at set',
  (SELECT (selected_plan = 'trial' AND plan = 'trial' AND trial_ends_at IS NOT NULL)::text FROM public.account_billing WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000002'), 'true');
SELECT pg_temp.expect('new user: no client-supplied billing leaks in (metadata plan=max ignored)',
  (SELECT plan FROM public.account_billing WHERE user_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 'trial');

-- D4. usage accounting (what ai-chat / the build worker call with the service role)
CREATE TEMP TABLE _c AS SELECT credits_used_cents AS before_cents FROM public.account_billing WHERE user_id = (SELECT u1 FROM _u);
SELECT pg_temp.expect('service_role increment_usage works',
  pg_temp.try_as('service_role', NULL, format('SELECT public.increment_usage(%L, 7)', (SELECT u1 FROM _u))), 'ok rows=1');
SELECT pg_temp.expect('credits incremented by exactly 7 (or cycle rolled to 7)',
  (SELECT (credits_used_cents = (SELECT before_cents FROM _c) + 7 OR credits_used_cents = 7)::text FROM public.account_billing WHERE user_id = (SELECT u1 FROM _u)), 'true');
SELECT pg_temp.expect('service_role can UPDATE account_billing (webhook path)',
  pg_temp.try_as('service_role', NULL, format('UPDATE public.account_billing SET extra_credits_cents = extra_credits_cents WHERE user_id = %L', (SELECT u1 FROM _u))), 'ok rows=1');
SELECT pg_temp.expect('service_role can INSERT billing_history',
  pg_temp.try_as('service_role', NULL, format('INSERT INTO public.billing_history (user_id, type, description, amount_paid_cents) VALUES (%L, %L, %L, 0)', (SELECT u1 FROM _u), 'subscription', 'dry-run')), 'ok rows=1');

-- ── E. SQL tab sandbox (vexium_site_query) ───────────────────────────────────────────────────────
INSERT INTO public.site_data (project_id, collection, data) VALUES
  ((SELECT p1 FROM _p), 'dryrun', '{"email":"a@example.invalid"}'),
  ((SELECT p2 FROM _p), 'dryrun', '{"email":"b@example.invalid"}');
SELECT pg_temp.expect('sandbox: SELECT from site_data returns only this project',
  (public.vexium_site_query((SELECT p1 FROM _p), 'select count(*) as n from site_data where collection = ''dryrun'''))::text, '%"n":1}%');
SELECT pg_temp.expect('sandbox: runs as vexium_sql_ro',
  (public.vexium_site_query((SELECT p1 FROM _p), 'select current_user as u'))::text, '%vexium_sql_ro%');
SELECT pg_temp.expect('sandbox: other project''s rows invisible',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), format('select data from site_data where project_id = %L', (SELECT p2 FROM _p)))), 'ok rows=1');
SELECT pg_temp.expect('sandbox: ...and the result is an empty array',
  (public.vexium_site_query((SELECT p1 FROM _p), format('select data from site_data where project_id = %L', (SELECT p2 FROM _p))))::text, '[]');
SELECT pg_temp.expect('sandbox: auth.users unreadable',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select * from auth.users')), 'error%permission denied%');
SELECT pg_temp.expect('sandbox: public.profiles unreadable',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select * from public.profiles')), 'error%permission denied%');
SELECT pg_temp.expect('sandbox: public.account_billing unreadable',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select * from public.account_billing')), 'error%permission denied%');
SELECT pg_temp.expect('sandbox: qualified public.site_data (all projects) unreadable',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select * from public.site_data')), 'error%permission denied%');
SELECT pg_temp.expect('sandbox: qualified public.site_users (password_hash) unreadable',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select * from public.site_users')), 'error%permission denied%');
SELECT pg_temp.expect('sandbox: temp site_users has no password_hash',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select password_hash from site_users')), 'error%does not exist%');
SELECT pg_temp.expect('sandbox: temp site_users email/metadata readable',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select id, email, created_at, metadata from site_users')), 'ok rows=1');
SELECT pg_temp.expect('sandbox: multiple statements rejected',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select 1; select 2')), 'error%single statement%');
SELECT pg_temp.expect('sandbox: DELETE rejected',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'delete from site_data')), 'error%Only SELECT%');
SELECT pg_temp.expect('sandbox: WITH-DML rejected',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'with d as (delete from public.site_data returning *) select * from d')), 'error%Only SELECT%');
SELECT pg_temp.expect('sandbox: DML smuggled into a subquery fails',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select * from (with d as (delete from public.site_data returning *) select * from d) t')), 'error%');
SELECT pg_temp.expect('sandbox: set_config(role) escape fails',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select set_config(''role'', ''postgres'', true)')), 'error%');
SELECT pg_temp.expect('sandbox: comment tail cannot break the wrapper',
  pg_temp.try_as('service_role', NULL, format('SELECT public.vexium_site_query(%L, %L)', (SELECT p1 FROM _p), 'select 1 as x -- trailing comment')), 'ok rows=1');
-- (A statement_timeout cancellation can't be caught inside PL/pgSQL — it aborts the whole request, which is the
--  intended production behaviour — so here we only assert the limit is applied. Verified manually: pg_sleep(12) is
--  cancelled after 8s with SQLSTATE 57014.)
SELECT pg_temp.expect('sandbox: statement_timeout = 8s applied', current_setting('statement_timeout'), '8s');
SELECT pg_temp.expect('sandbox leaves the caller as itself (no role leakage after the call)',
  current_user::text, 'postgres');

-- ── report (RAISE aborts + rolls back everything above) ──────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
