-- REVAMP Step 4 — site backend v2 (see docs/STEP4_DESIGN.md).
--
-- Adds what the rewritten `site-api` edge function needs:
--   * site_sessions  — opaque session tokens for SITE users (visitors of a generated site). Only the SHA-256 of the
--                      token is stored; a session is bound to one project and one site user.
--   * rate_limits    + vx_rate_hit()  — fixed-window counters in Postgres (one atomic upsert per check).
--   * size / shape CHECKs on site_data and site_users (defence in depth behind the function's own limits).
--
-- Everything here is service-role only: anon/authenticated have NO privileges on the new tables or the RPC. The edge
-- function is the only caller (it uses the service key and enforces every rule itself).
--
-- The revoke of the two anon-callable enumeration RPCs (SECURITY_FINDINGS #10) is a SEPARATE migration
-- (20261012141000) because it may only be applied once `auth-gate` + the new auth.html are live.
--
-- Apply:  supabase db query --linked -f supabase/migrations/20261012140000_site_backend_v2.sql
BEGIN;

-- ── site_sessions ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_sessions (
  token_hash   text        PRIMARY KEY,                                   -- hex sha256 of the bearer token
  project_id   text        NOT NULL REFERENCES public.projects(id)   ON DELETE CASCADE,
  site_user_id uuid        NOT NULL REFERENCES public.site_users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS site_sessions_user_idx    ON public.site_sessions (site_user_id);
CREATE INDEX IF NOT EXISTS site_sessions_expires_idx ON public.site_sessions (expires_at);
ALTER TABLE public.site_sessions ENABLE ROW LEVEL SECURITY;      -- no policies: only the service role (bypasses RLS)
REVOKE ALL ON public.site_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.site_sessions TO service_role;

-- ── rate limiting ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limits TO service_role;

-- vx_rate_hit(key, window_seconds, limit, cost)
--   Adds `cost` to the counter of the current fixed window and says whether the caller may proceed.
--   cost = 1 (default): "count this attempt"  → allowed while hits <= limit.
--   cost = 0          : "peek only"           → allowed while hits <  limit (used to gate login BEFORE checking the
--                       password, then call again with cost 1 only when the password was wrong).
--   retry_after = seconds until the window rolls over.
CREATE OR REPLACE FUNCTION public.vx_rate_hit(p_key text, p_window_seconds integer, p_limit integer, p_cost integer DEFAULT 1)
RETURNS TABLE(allowed boolean, hits integer, retry_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_window timestamptz;
  v_hits   integer;
BEGIN
  IF p_window_seconds < 1 OR p_limit < 1 OR p_cost < 0 THEN
    RAISE EXCEPTION 'bad rate-limit arguments';
  END IF;
  v_window := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);

  INSERT INTO public.rate_limits AS r (key, window_start, hits)
  VALUES (left(p_key, 200), v_window, p_cost)
  ON CONFLICT (key, window_start) DO UPDATE SET hits = r.hits + p_cost
  RETURNING r.hits INTO v_hits;

  -- Opportunistic cleanup (~2% of calls) so the table stays small without a scheduler.
  IF random() < 0.02 THEN
    DELETE FROM public.rate_limits WHERE window_start < now() - interval '2 days';
    DELETE FROM public.site_sessions WHERE expires_at < now() - interval '1 day';
  END IF;

  allowed     := CASE WHEN p_cost > 0 THEN v_hits <= p_limit ELSE v_hits < p_limit END;
  hits        := v_hits;
  retry_after := GREATEST(1, ceil(extract(epoch FROM (v_window + make_interval(secs => p_window_seconds) - now())))::integer);
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.vx_rate_hit(text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vx_rate_hit(text, integer, integer, integer) TO service_role;

-- ── shape / size limits (the function enforces the same, these are the backstop) ─────────────────────
-- Existing rows were checked before writing this: 1 site_data row ("bookings", 175 bytes), 0 site_users.
ALTER TABLE public.site_data
  DROP CONSTRAINT IF EXISTS site_data_collection_chk,
  DROP CONSTRAINT IF EXISTS site_data_size_chk;
ALTER TABLE public.site_data
  ADD CONSTRAINT site_data_collection_chk CHECK (collection ~ '^[a-z0-9_-]{1,40}$'),
  ADD CONSTRAINT site_data_size_chk       CHECK (octet_length(data::text) <= 16384);

ALTER TABLE public.site_users
  DROP CONSTRAINT IF EXISTS site_users_email_chk,
  DROP CONSTRAINT IF EXISTS site_users_metadata_chk;
ALTER TABLE public.site_users
  ADD CONSTRAINT site_users_email_chk    CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  ADD CONSTRAINT site_users_metadata_chk CHECK (metadata IS NULL OR octet_length(metadata::text) <= 4096);

-- Own-row lookups for `user` collections (list/update/delete only touch the caller's rows).
CREATE INDEX IF NOT EXISTS site_data_user_idx ON public.site_data (project_id, collection, site_user_id, created_at DESC);

COMMIT;
