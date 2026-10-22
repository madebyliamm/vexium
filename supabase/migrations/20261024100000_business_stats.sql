-- REVAMP Step 13 (chunk A) — BUSINESS data layer: one aggregate RPC the `business-state` edge function turns into the `business_state` artifact.
--
--   vx_business_stats(project, days, now)  → jsonb of raw counts for the last `days` UTC calendar days (today included) and the `days`
--                                             before them: visitors / views / pages / sources / devices / daily series (page_views),
--                                             sales + refunds + products (site_data 'transactions', written ONLY by the Stripe webhook),
--                                             sign-ups (site_users), leads (every other site_data collection), lifetime totals, recent activity.
--
-- Service-role only: the edge function checks that the caller owns (or is an accepted member of) a published project first.
-- It reads; it never writes. Every number is a count of rows that exist — nothing is estimated here.

BEGIN;

CREATE OR REPLACE FUNCTION public.vx_business_stats(p_project text, p_days integer DEFAULT 30, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d     integer := least(greatest(coalesce(p_days, 30), 1), 365);
  day0  timestamptz := (date_trunc('day', p_now AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';   -- start of today, UTC
  t0    timestamptz;   -- start of the current window
  tp    timestamptz;   -- start of the previous window
  out   jsonb;
BEGIN
  t0 := day0 - make_interval(days => d - 1);
  tp := t0 - make_interval(days => d);

  WITH
  pv AS (
    SELECT coalesce(nullif(visitor_id, ''), nullif(session_id, ''), id::text) AS vkey,
           nullif(session_id, '') AS skey,
           page, device, referrer, ts
      FROM public.page_views
     WHERE project_id = p_project AND ts >= tp AND ts <= p_now
  ),
  cur AS (SELECT * FROM pv WHERE ts >= t0),
  prv AS (SELECT * FROM pv WHERE ts < t0),
  tx AS (
    SELECT created_at,
           lower(coalesce(nullif(data ->> 'currency', ''), 'usd')) AS currency,
           data ->> 'type' AS kind,
           CASE WHEN (data ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN round((data ->> 'amount')::numeric * 100)::bigint ELSE 0 END AS cents,
           coalesce(nullif(data ->> 'description', ''), nullif(data ->> 'product_id', ''), 'Purchase') AS what
      FROM public.site_data
     WHERE project_id = p_project AND collection = 'transactions' AND created_at >= tp AND created_at <= p_now
       AND ((data ->> 'type' = 'sale' AND data ->> 'status' = 'paid') OR data ->> 'type' = 'refund')
  ),
  txc AS (SELECT * FROM tx WHERE created_at >= t0),
  txp AS (SELECT * FROM tx WHERE created_at < t0),
  su AS (SELECT created_at FROM public.site_users WHERE project_id = p_project AND created_at >= tp AND created_at <= p_now),
  ld AS (
    SELECT created_at, collection FROM public.site_data
     WHERE project_id = p_project AND collection <> 'transactions' AND created_at >= tp AND created_at <= p_now
  )
  SELECT jsonb_build_object(
    'days', d,
    'window_start', t0,
    'window_end', p_now,
    'traffic', jsonb_build_object(
      'views',             (SELECT count(*) FROM cur),
      'visitors',          (SELECT count(DISTINCT vkey) FROM cur),
      'sessions',          (SELECT count(DISTINCT skey) FROM cur),
      'prev_views',        (SELECT count(*) FROM prv),
      'prev_visitors',     (SELECT count(DISTINCT vkey) FROM prv),
      'pages',   coalesce((SELECT jsonb_agg(jsonb_build_object('page', page, 'views', v, 'visitors', u) ORDER BY v DESC, page)
                             FROM (SELECT left(page, 200) AS page, count(*) AS v, count(DISTINCT vkey) AS u FROM cur GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8) s), '[]'::jsonb),
      'sources', coalesce((SELECT jsonb_agg(jsonb_build_object('source', src, 'visitors', u) ORDER BY u DESC, src)
                             FROM (SELECT left(coalesce(nullif(lower(regexp_replace(coalesce(referrer, ''), '^[a-z]+://([^/?#:]+).*$', '\1')), ''), ''), 120) AS src,
                                          count(DISTINCT vkey) AS u
                                     FROM cur GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12) s), '[]'::jsonb),
      'devices', coalesce((SELECT jsonb_agg(jsonb_build_object('device', dv, 'visitors', u) ORDER BY u DESC, dv)
                             FROM (SELECT left(coalesce(nullif(device, ''), 'unknown'), 20) AS dv, count(DISTINCT vkey) AS u FROM cur GROUP BY 1) s), '[]'::jsonb),
      'daily',   coalesce((SELECT jsonb_agg(jsonb_build_object('day', to_char(g.day, 'YYYY-MM-DD'),
                                                               'views', coalesce(x.v, 0), 'visitors', coalesce(x.u, 0)) ORDER BY g.day)
                             FROM generate_series((t0 AT TIME ZONE 'UTC')::date, (day0 AT TIME ZONE 'UTC')::date, interval '1 day') AS g(day)
                             LEFT JOIN (SELECT (ts AT TIME ZONE 'UTC')::date AS day, count(*) AS v, count(DISTINCT vkey) AS u FROM cur GROUP BY 1) x
                                    ON x.day = g.day::date), '[]'::jsonb)
    ),
    'money', jsonb_build_object(
      'current', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', currency,
                                  'orders', n, 'gross_cents', gross, 'refunds_cents', ref, 'net_cents', gross + ref) ORDER BY gross + ref DESC, currency)
                             FROM (SELECT currency, count(*) FILTER (WHERE kind = 'sale') AS n,
                                          coalesce(sum(cents) FILTER (WHERE kind = 'sale'), 0) AS gross,
                                          coalesce(sum(cents) FILTER (WHERE kind = 'refund'), 0) AS ref
                                     FROM txc GROUP BY currency) s), '[]'::jsonb),
      'previous', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', currency,
                                  'orders', n, 'gross_cents', gross, 'refunds_cents', ref, 'net_cents', gross + ref) ORDER BY gross + ref DESC, currency)
                             FROM (SELECT currency, count(*) FILTER (WHERE kind = 'sale') AS n,
                                          coalesce(sum(cents) FILTER (WHERE kind = 'sale'), 0) AS gross,
                                          coalesce(sum(cents) FILTER (WHERE kind = 'refund'), 0) AS ref
                                     FROM txp GROUP BY currency) s), '[]'::jsonb),
      'products', coalesce((SELECT jsonb_agg(jsonb_build_object('name', what, 'currency', currency, 'units', n, 'cents', c) ORDER BY c DESC, what)
                             FROM (SELECT left(what, 120) AS what, currency, count(*) AS n, sum(cents) AS c
                                     FROM txc WHERE kind = 'sale' GROUP BY 1, 2 ORDER BY 4 DESC, 1 LIMIT 8) s), '[]'::jsonb)
    ),
    'signups', jsonb_build_object(
      'current',  (SELECT count(*) FROM su WHERE created_at >= t0),
      'previous', (SELECT count(*) FROM su WHERE created_at < t0)
    ),
    'leads', jsonb_build_object(
      'current',  (SELECT count(*) FROM ld WHERE created_at >= t0),
      'previous', (SELECT count(*) FROM ld WHERE created_at < t0),
      'by_collection', coalesce((SELECT jsonb_agg(jsonb_build_object('collection', collection, 'count', n) ORDER BY n DESC, collection)
                                   FROM (SELECT collection, count(*) AS n FROM ld WHERE created_at >= t0 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8) s), '[]'::jsonb)
    ),
    'lifetime', jsonb_build_object(
      'views',   (SELECT count(*) FROM public.page_views WHERE project_id = p_project AND ts <= p_now),
      'first_view_at', (SELECT min(ts) FROM public.page_views WHERE project_id = p_project),
      'orders',  (SELECT count(*) FROM public.site_data WHERE project_id = p_project AND collection = 'transactions'
                    AND data ->> 'type' = 'sale' AND data ->> 'status' = 'paid' AND created_at <= p_now),
      'signups', (SELECT count(*) FROM public.site_users WHERE project_id = p_project AND created_at <= p_now),
      'leads',   (SELECT count(*) FROM public.site_data WHERE project_id = p_project AND collection <> 'transactions' AND created_at <= p_now)
    ),
    -- Newest first; no emails or names, only what the owner needs to recognise the event.
    'recent', coalesce((SELECT jsonb_agg(e ORDER BY (e ->> 'at') DESC) FROM (
        (SELECT jsonb_build_object('type', 'sale', 'at', created_at, 'what', left(what, 120), 'cents', cents, 'currency', currency) AS e
           FROM tx WHERE kind = 'sale' ORDER BY created_at DESC LIMIT 5)
        UNION ALL
        (SELECT jsonb_build_object('type', 'lead', 'at', created_at, 'what', collection) AS e
           FROM ld ORDER BY created_at DESC LIMIT 5)
        UNION ALL
        (SELECT jsonb_build_object('type', 'signup', 'at', created_at) AS e
           FROM su ORDER BY created_at DESC LIMIT 5)
      ) r), '[]'::jsonb)
  ) INTO out;

  RETURN out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.vx_business_stats(text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vx_business_stats(text, integer, timestamptz) TO service_role;

COMMIT;
