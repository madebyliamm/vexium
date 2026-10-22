-- REVAMP Step 13 (chunk A) — verification of supabase/migrations/20261024100000_business_stats.sql (vx_business_stats).
--
-- Run against production:   supabase db query --linked -f supabase/tests/step13_business_stats.sql
-- Never commits: ends with a deliberate RAISE EXCEPTION carrying the PASS/FAIL report ("error" is the expected exit).
-- Dry-run BEFORE applying the migration: splice the migration (minus its BEGIN/COMMIT) in front of the "-- ── A." marker.
--
-- Test data: one throwaway project (vxt_biz_a) owned by the oldest auth user, with page views / transactions / sign-ups / leads at fixed
-- times around a fixed "now" (2026-10-24 12:00 UTC, 7-day windows: current = Oct 18..24, previous = Oct 11..17) — all rolled back.
BEGIN;

CREATE TEMP TABLE _t (n serial, name text, passed boolean, got text);

CREATE FUNCTION pg_temp.expect(p_name text, p_got text, p_want_like text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  ok := coalesce(p_got LIKE p_want_like, p_got IS NULL AND p_want_like IS NULL);
  INSERT INTO _t(name, passed, got) VALUES (p_name, coalesce(ok, false), p_got);
END $$;

CREATE FUNCTION pg_temp.try_as(p_role text, p_stmt text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_stmt;
    RESET ROLE;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'RB000';
  EXCEPTION
    WHEN SQLSTATE 'RB000' THEN r := 'ok';
    WHEN insufficient_privilege THEN r := 'denied';
    WHEN OTHERS THEN r := 'error ' || SQLSTATE || ': ' || SQLERRM;
  END;
  RESET ROLE;
  RETURN r;
END $$;

-- ── A. data ────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO public.projects (id, user_id, name, files)
  SELECT 'vxt_biz_a', (SELECT id FROM auth.users ORDER BY created_at LIMIT 1), 'Business stats test', '{}'::jsonb;
INSERT INTO public.projects (id, user_id, name, files)
  SELECT 'vxt_biz_empty', (SELECT id FROM auth.users ORDER BY created_at LIMIT 1), 'Business stats empty', '{}'::jsonb;

INSERT INTO public.page_views (project_id, page, referrer, device, session_id, visitor_id, ts) VALUES
  -- current window: V1 (4 views, desktop, direct), V2 (google, mobile), V3 (no visitor id → session), V4 (no ids at all)
  ('vxt_biz_a', '/',      '',                                       'desktop', 'sa', 'V1', '2026-10-18 09:00+00'),
  ('vxt_biz_a', '/',      '',                                       'desktop', 'sa', 'V1', '2026-10-18 09:01+00'),
  ('vxt_biz_a', '/',      '',                                       'desktop', 'sa', 'V1', '2026-10-20 10:00+00'),
  ('vxt_biz_a', '/menu',  '',                                       'desktop', 'sa', 'V1', '2026-10-20 10:01+00'),
  ('vxt_biz_a', '/',      'https://www.google.com/search?q=coffee', 'mobile',  'sb', 'V2', '2026-10-24 08:00+00'),
  ('vxt_biz_a', '/',      'https://www.google.com/',                'mobile',  's3', '',   '2026-10-22 08:00+00'),
  ('vxt_biz_a', '/',      '',                                       'desktop', '',   '',   '2026-10-23 08:00+00'),
  -- previous window
  ('vxt_biz_a', '/',      '',                                       'desktop', 'sa', 'V1', '2026-10-12 09:00+00'),
  ('vxt_biz_a', '/',      '',                                       'desktop', 'sa', 'V1', '2026-10-13 09:00+00'),
  ('vxt_biz_a', '/',      '',                                       'desktop', 'sz', 'V9', '2026-10-15 09:00+00'),
  -- older than both windows, and in the future (after "now")
  ('vxt_biz_a', '/',      '',                                       'desktop', 'sa', 'V10', '2026-10-10 09:00+00'),
  ('vxt_biz_a', '/',      '',                                       'desktop', 'sa', 'V11', '2026-10-25 09:00+00');

INSERT INTO public.site_data (project_id, collection, data, created_at) VALUES
  ('vxt_biz_a', 'transactions', '{"type":"sale","amount":25,"currency":"usd","status":"paid","description":"Coffee beans"}',   '2026-10-20 10:30+00'),
  ('vxt_biz_a', 'transactions', '{"type":"sale","amount":10.5,"currency":"usd","status":"paid","description":"Coffee beans"}', '2026-10-21 10:30+00'),
  ('vxt_biz_a', 'transactions', '{"type":"sale","amount":99,"currency":"usd","status":"unpaid","description":"Never paid"}',  '2026-10-21 11:30+00'),
  ('vxt_biz_a', 'transactions', '{"type":"refund","amount":-10.5,"currency":"usd","status":"refunded","description":"Refund issued"}', '2026-10-22 10:30+00'),
  ('vxt_biz_a', 'transactions', '{"type":"sale","amount":5,"currency":"gbp","status":"paid","description":"Cake"}',            '2026-10-22 11:30+00'),
  ('vxt_biz_a', 'transactions', '{"type":"sale","amount":40,"currency":"usd","status":"paid","description":"Tea"}',            '2026-10-14 10:30+00'),
  ('vxt_biz_a', 'bookings', '{"name":"A"}', '2026-10-19 10:00+00'),
  ('vxt_biz_a', 'bookings', '{"name":"B"}', '2026-10-20 10:00+00'),
  ('vxt_biz_a', 'bookings', '{"name":"C"}', '2026-10-24 10:00+00'),
  ('vxt_biz_a', 'contact',  '{"name":"D"}', '2026-10-21 10:00+00'),
  ('vxt_biz_a', 'bookings', '{"name":"E"}', '2026-10-13 10:00+00');
INSERT INTO public.site_users (project_id, email, password_hash, created_at) VALUES
  ('vxt_biz_a', 'a@x.test', 'x', '2026-10-19 10:00+00'),
  ('vxt_biz_a', 'b@x.test', 'x', '2026-10-23 10:00+00'),
  ('vxt_biz_a', 'c@x.test', 'x', '2026-10-12 10:00+00');

CREATE TEMP TABLE _s AS SELECT public.vx_business_stats('vxt_biz_a', 7, '2026-10-24 12:00:00+00') AS j;
CREATE TEMP TABLE _e AS SELECT public.vx_business_stats('vxt_biz_empty', 7, '2026-10-24 12:00:00+00') AS j;

-- ── B. traffic ─────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('window is the last 7 UTC days, today included', (SELECT j ->> 'window_start' FROM _s), '2026-10-18T00:00:00+00:00');
SELECT pg_temp.expect('visitors (id, else session, else the row)',   (SELECT j #>> '{traffic,visitors}' FROM _s), '4');
SELECT pg_temp.expect('views',                                      (SELECT j #>> '{traffic,views}' FROM _s), '7');
SELECT pg_temp.expect('sessions',                                   (SELECT j #>> '{traffic,sessions}' FROM _s), '3');
SELECT pg_temp.expect('previous visitors',                          (SELECT j #>> '{traffic,prev_visitors}' FROM _s), '2');
SELECT pg_temp.expect('previous views',                             (SELECT j #>> '{traffic,prev_views}' FROM _s), '3');
SELECT pg_temp.expect('top page is / with 6 views, 4 visitors',      (SELECT (j #> '{traffic,pages,0}')::text FROM _s), '%"page": "/"%"views": 6%"visitors": 4%');
SELECT pg_temp.expect('second page is /menu',                        (SELECT j #>> '{traffic,pages,1,page}' FROM _s), '/menu');
SELECT pg_temp.expect('direct (empty referrer) is the top source',   (SELECT j #>> '{traffic,sources,0,source}' FROM _s), '');
SELECT pg_temp.expect('direct = V1 + V4',                            (SELECT j #>> '{traffic,sources,0,visitors}' FROM _s), '2');
SELECT pg_temp.expect('google host, www kept for the app to tidy',   (SELECT j #>> '{traffic,sources,1,source}' FROM _s), 'www.google.com');
SELECT pg_temp.expect('google visitors',                             (SELECT j #>> '{traffic,sources,1,visitors}' FROM _s), '2');
SELECT pg_temp.expect('devices: desktop 2 visitors',                 (SELECT (j #> '{traffic,devices}')::text FROM _s), '%"device": "desktop"%"visitors": 2%');
SELECT pg_temp.expect('daily has 7 entries',                         (SELECT jsonb_array_length(j #> '{traffic,daily}')::text FROM _s), '7');
SELECT pg_temp.expect('daily starts on the window start',            (SELECT j #>> '{traffic,daily,0,day}' FROM _s), '2026-10-18');
SELECT pg_temp.expect('daily ends today',                            (SELECT j #>> '{traffic,daily,6,day}' FROM _s), '2026-10-24');
SELECT pg_temp.expect('daily views add up to views',                 (SELECT sum((x ->> 'views')::int)::text FROM _s, jsonb_array_elements(j #> '{traffic,daily}') x), '7');
SELECT pg_temp.expect('a quiet day is a zero, not a gap',            (SELECT j #>> '{traffic,daily,1,views}' FROM _s), '0');
SELECT pg_temp.expect('Oct 18 had 2 views, 1 visitor',               (SELECT (j #> '{traffic,daily,0}')::text FROM _s), '%"views": 2%"visitors": 1%');

-- ── C. money ───────────────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('usd: 2 paid orders (unpaid ignored)',         (SELECT j #>> '{money,current,0,orders}' FROM _s), '2');
SELECT pg_temp.expect('usd gross 35.50',                             (SELECT j #>> '{money,current,0,gross_cents}' FROM _s), '3550');
SELECT pg_temp.expect('usd refunds -10.50',                          (SELECT j #>> '{money,current,0,refunds_cents}' FROM _s), '-1050');
SELECT pg_temp.expect('usd net 25.00',                               (SELECT j #>> '{money,current,0,net_cents}' FROM _s), '2500');
SELECT pg_temp.expect('currencies are kept apart (gbp second)',      (SELECT j #>> '{money,current,1,currency}' FROM _s), 'gbp');
SELECT pg_temp.expect('gbp net 5.00',                                (SELECT j #>> '{money,current,1,net_cents}' FROM _s), '500');
SELECT pg_temp.expect('previous usd net 40.00',                      (SELECT j #>> '{money,previous,0,net_cents}' FROM _s), '4000');
SELECT pg_temp.expect('top product is Coffee beans',                 (SELECT j #>> '{money,products,0,name}' FROM _s), 'Coffee beans');
SELECT pg_temp.expect('  … 2 units, 35.50',                          (SELECT (j #>> '{money,products,0,units}') || '/' || (j #>> '{money,products,0,cents}') FROM _s), '2/3550');
SELECT pg_temp.expect('refunds are not products',                    (SELECT count(*)::text FROM _s, jsonb_array_elements(j #> '{money,products}') x WHERE x ->> 'name' = 'Refund issued'), '0');

-- ── D. sign-ups, leads, lifetime, recent ──────────────────────────────────────────────────────────
SELECT pg_temp.expect('sign-ups now',                                (SELECT j #>> '{signups,current}' FROM _s), '2');
SELECT pg_temp.expect('sign-ups before',                             (SELECT j #>> '{signups,previous}' FROM _s), '1');
SELECT pg_temp.expect('leads now (transactions excluded)',           (SELECT j #>> '{leads,current}' FROM _s), '4');
SELECT pg_temp.expect('leads before',                                (SELECT j #>> '{leads,previous}' FROM _s), '1');
SELECT pg_temp.expect('leads by collection: bookings 3 first',       (SELECT (j #> '{leads,by_collection,0}')::text FROM _s), '%"count": 3%"collection": "bookings"%');
SELECT pg_temp.expect('lifetime views (future ignored)',             (SELECT j #>> '{lifetime,views}' FROM _s), '11');
SELECT pg_temp.expect('lifetime paid orders',                        (SELECT j #>> '{lifetime,orders}' FROM _s), '4');
SELECT pg_temp.expect('lifetime sign-ups',                           (SELECT j #>> '{lifetime,signups}' FROM _s), '3');
SELECT pg_temp.expect('lifetime leads',                              (SELECT j #>> '{lifetime,leads}' FROM _s), '5');
SELECT pg_temp.expect('first view is recorded',                      (SELECT j #>> '{lifetime,first_view_at}' FROM _s), '2026-10-10%');
SELECT pg_temp.expect('recent activity carries no email or name',    (SELECT (j -> 'recent')::text FROM _s), '%"type": "sale"%');
SELECT pg_temp.expect('  … no @ anywhere in it',                     (SELECT (position('@' IN (j -> 'recent')::text) = 0)::text FROM _s), 'true');
SELECT pg_temp.expect('  … no customer names',                       (SELECT (position('"A"' IN (j -> 'recent')::text) = 0)::text FROM _s), 'true');
SELECT pg_temp.expect('recent is newest first',                      (SELECT j #>> '{recent,0,at}' FROM _s), '2026-10-24T10:00:00+00:00');

-- ── E. an empty project answers with zeros, not an error ──────────────────────────────────────────
SELECT pg_temp.expect('empty: visitors 0',                           (SELECT j #>> '{traffic,visitors}' FROM _e), '0');
SELECT pg_temp.expect('empty: 7 quiet days',                         (SELECT jsonb_array_length(j #> '{traffic,daily}')::text FROM _e), '7');
SELECT pg_temp.expect('empty: no money',                             (SELECT (j #> '{money,current}')::text FROM _e), '[]');
SELECT pg_temp.expect('empty: no first view',                        (SELECT coalesce(j #>> '{lifetime,first_view_at}', 'none') FROM _e), 'none');
SELECT pg_temp.expect('a project that does not exist is just empty', (SELECT public.vx_business_stats('vxt_nope', 7, '2026-10-24 12:00+00') #>> '{traffic,views}'), '0');
SELECT pg_temp.expect('days are clamped (0 → 1 day)',                (SELECT jsonb_array_length(public.vx_business_stats('vxt_biz_a', 0, '2026-10-24 12:00+00') #> '{traffic,daily}')::text), '1');

-- ── F. who may call it ────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.expect('anon cannot call it',          pg_temp.try_as('anon',          $q$ SELECT public.vx_business_stats('vxt_biz_a', 7) $q$), 'denied');
SELECT pg_temp.expect('authenticated cannot call it', pg_temp.try_as('authenticated', $q$ SELECT public.vx_business_stats('vxt_biz_a', 7) $q$), 'denied');
SELECT pg_temp.expect('service_role can',             pg_temp.try_as('service_role',  $q$ SELECT public.vx_business_stats('vxt_biz_a', 7) $q$), 'ok');

-- ── report (RAISE aborts + rolls back everything above) ────────────────────────────────────────────
DO $$
DECLARE v_fail int; v_total int; v_report text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT passed), count(*) INTO v_fail, v_total FROM _t;
  SELECT string_agg(CASE WHEN passed THEN 'PASS ' ELSE 'FAIL ' END || name || '   [' || coalesce(got, 'NULL') || ']', E'\n' ORDER BY n)
    INTO v_report FROM _t;
  RAISE EXCEPTION E'RESULTS %/% passed, % failed\n%', v_total - v_fail, v_total, v_fail, v_report;
END $$;
