-- Vertly REVAMP Step 2 — security lockdown.
-- Fixes docs/SECURITY_FINDINGS.md #1, #2, #3, #11 (+ the DB half of #9 and the password_hash part of #7).
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261012120000_security_lockdown.sql
-- Verify:  supabase db query --linked -f supabase/tests/step2_security_lockdown.sql   (always rolls back)
--
-- Deploy order matters (see REVAMP.md Step 2 deploy checklist): this migration drops billing columns from
-- public.profiles, so the edge functions + pages that read them must be redeployed right after.

BEGIN;

-- ═══ 1. Functions only the service role may call ═══════════════════════════════════════════════════
-- increment_usage / vexium_site_query were SECURITY DEFINER + executable by anon: anyone with the public anon
-- key could edit any user's credits or run SQL as the table owner. Edge functions use the service role.
REVOKE EXECUTE ON FUNCTION public.increment_usage(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.increment_usage(uuid, integer) TO service_role;

-- Dead + broken (references columns that no longer exist) and was also anon-callable.
DROP FUNCTION IF EXISTS public.log_usage(uuid, uuid, text, integer, integer);

-- Trigger functions are never called by clients.
REVOKE EXECUTE ON FUNCTION
  public.handle_follow_delete(), public.handle_follow_insert(), public.handle_follow_notify(),
  public.handle_invite_notify(), public.handle_new_user()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;

-- auth.uid()-based helpers have nothing to return for anon.
REVOKE EXECUTE ON FUNCTION public.get_my_page_views(timestamptz), public.get_my_projects() FROM PUBLIC, anon;

-- Pin search_path on the remaining functions (advisor: function_search_path_mutable; protects the
-- SECURITY DEFINER ones from search_path hijacking).
ALTER FUNCTION public.get_follow_counts(uuid)              SET search_path = public;
ALTER FUNCTION public.get_my_member_project_ids()          SET search_path = public;
ALTER FUNCTION public.get_my_page_views(timestamptz)       SET search_path = public;
ALTER FUNCTION public.get_my_projects()                    SET search_path = public;
ALTER FUNCTION public.get_user_id_by_username(text)        SET search_path = public;
ALTER FUNCTION public.handle_follow_delete()               SET search_path = public;
ALTER FUNCTION public.handle_follow_insert()               SET search_path = public;
ALTER FUNCTION public.handle_follow_notify()               SET search_path = public;
ALTER FUNCTION public.handle_invite_notify()               SET search_path = public;
ALTER FUNCTION public.is_following(uuid, uuid)             SET search_path = public;
ALTER FUNCTION public.is_project_member(text, uuid)        SET search_path = public;
ALTER FUNCTION public.is_project_owner(text, uuid)         SET search_path = public;
ALTER FUNCTION public.set_updated_at()                     SET search_path = public;
ALTER FUNCTION public.zero_tiny_extra_credits()            SET search_path = public;

-- ═══ 2. account_billing: private billing/usage state ═══════════════════════════════════════════════
-- Moved out of public.profiles (which is world-readable and client-writable). Clients may only SELECT their
-- own row; every write comes from the service role (Stripe webhook, ai-chat usage tracking, handle_new_user).
CREATE TABLE public.account_billing (
  user_id                         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                            text        NOT NULL DEFAULT 'trial',
  selected_plan                   text        NOT NULL DEFAULT 'pro',
  trial_ends_at                   timestamptz,
  credits_used_cents              bigint      NOT NULL DEFAULT 0,
  extra_credits_cents             integer     NOT NULL DEFAULT 0,
  extra_credits_purchased_cents   integer     NOT NULL DEFAULT 0,
  plan_cycle_start                timestamptz NOT NULL DEFAULT now(),
  billing_period                  text        DEFAULT 'monthly',
  tokens_used_this_month          bigint      DEFAULT 0,
  usage_month                     text        DEFAULT to_char(now(), 'YYYY-MM'),
  stripe_customer_id              text,
  stripe_subscription_id          text,
  stripe_connect_account_id       text,
  stripe_connect_charges_enabled  boolean     NOT NULL DEFAULT false,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.account_billing (
  user_id, plan, selected_plan, trial_ends_at, credits_used_cents, extra_credits_cents,
  extra_credits_purchased_cents, plan_cycle_start, billing_period, tokens_used_this_month, usage_month,
  stripe_customer_id, stripe_subscription_id, stripe_connect_account_id, stripe_connect_charges_enabled
)
SELECT
  id, plan, selected_plan, trial_ends_at, COALESCE(credits_used_cents, 0), extra_credits_cents,
  extra_credits_purchased_cents, plan_cycle_start, billing_period, tokens_used_this_month, usage_month,
  stripe_customer_id, stripe_subscription_id, stripe_connect_account_id, stripe_connect_charges_enabled
FROM public.profiles;

CREATE INDEX idx_account_billing_stripe_customer_id ON public.account_billing (stripe_customer_id);

ALTER TABLE public.account_billing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_billing FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON public.account_billing TO authenticated;
GRANT  ALL    ON public.account_billing TO service_role;
CREATE POLICY account_billing_select_own ON public.account_billing
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE TRIGGER set_account_billing_updated_at BEFORE UPDATE ON public.account_billing
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_zero_tiny_extra_credits BEFORE INSERT OR UPDATE OF extra_credits_cents ON public.account_billing
  FOR EACH ROW EXECUTE FUNCTION public.zero_tiny_extra_credits();

-- New accounts: profile + billing row, with the 7-day trial set SERVER-side (the old client-side update was
-- both forgeable and silently failing for trial signups, leaving trial_ends_at NULL = trial never expires).
-- selected_plan is only the user's signup choice; entitlement (plan) stays 'trial' until Stripe says otherwise.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_choice text := new.raw_user_meta_data->>'selected_plan';
begin
  insert into public.profiles (id, username, display_name, email)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'username', ''), split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nullif(new.raw_user_meta_data->>'username', ''), split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;

  insert into public.account_billing (user_id, selected_plan, trial_ends_at)
  values (
    new.id,
    case when v_choice in ('trial', 'starter', 'pro', 'max') then v_choice else 'trial' end,
    now() + interval '7 days'
  )
  on conflict (user_id) do nothing;

  return new;
end;
$function$;

-- Same logic as before, pointed at account_billing. Service-role only (see section 1).
CREATE OR REPLACE FUNCTION public.increment_usage(p_user_id uuid, p_cents integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cycle_start TIMESTAMPTZ;
  v_now         TIMESTAMPTZ := NOW();
  v_cycle_ms    INTERVAL    := INTERVAL '30 days';
BEGIN
  SELECT plan_cycle_start INTO v_cycle_start
  FROM account_billing WHERE user_id = p_user_id;

  IF v_cycle_start IS NULL THEN
    v_cycle_start := v_now;
  END IF;

  -- Advance cycle start in 30-day steps until it's within the current window
  WHILE v_cycle_start + v_cycle_ms <= v_now LOOP
    v_cycle_start := v_cycle_start + v_cycle_ms;
  END LOOP;

  UPDATE account_billing SET
    credits_used_cents = CASE
      WHEN v_cycle_start > plan_cycle_start THEN p_cents
      ELSE credits_used_cents + p_cents
    END,
    plan_cycle_start = v_cycle_start
  WHERE user_id = p_user_id;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.increment_usage(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.increment_usage(uuid, integer) TO service_role;

-- ═══ 3. profiles: public data only; clients may edit a short allow-list of columns ═════════════════
-- email stays in the table (login-by-username and signup checks read it through SECURITY DEFINER functions)
-- but is no longer selectable by clients. What the user chose to show publicly is mirrored into public_email.
ALTER TABLE public.profiles ADD COLUMN public_email text;
UPDATE public.profiles SET public_email = CASE WHEN show_email THEN email END;

CREATE OR REPLACE FUNCTION public.profiles_sync_public_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.public_email := case when new.show_email then new.email end;
  return new;
end;
$function$;
CREATE TRIGGER trg_profiles_public_email BEFORE INSERT OR UPDATE OF email, show_email ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_sync_public_email();

DROP TRIGGER IF EXISTS trg_zero_tiny_extra_credits ON public.profiles;
ALTER TABLE public.profiles
  DROP COLUMN plan,
  DROP COLUMN trial_ends_at,
  DROP COLUMN selected_plan,
  DROP COLUMN credits_used_cents,
  DROP COLUMN extra_credits_cents,
  DROP COLUMN extra_credits_purchased_cents,
  DROP COLUMN plan_cycle_start,
  DROP COLUMN billing_period,
  DROP COLUMN tokens_used_this_month,
  DROP COLUMN usage_month,
  DROP COLUMN stripe_customer_id,
  DROP COLUMN stripe_subscription_id,
  DROP COLUMN stripe_connect_account_id,
  DROP COLUMN stripe_connect_charges_enabled;

DROP POLICY IF EXISTS profiles_anon_read   ON public.profiles;
DROP POLICY IF EXISTS profiles_select      ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_own  ON public.profiles;
DROP POLICY IF EXISTS profiles_update_own  ON public.profiles;
CREATE POLICY profiles_public_read ON public.profiles
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = id) WITH CHECK ((SELECT auth.uid()) = id);

-- Column-level privileges are the real gate. Rows are created by handle_new_user, so clients get no INSERT/DELETE.
-- NOTE: any new column on profiles is invisible/unwritable to clients until it is added to these lists.
REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT  SELECT (id, username, display_name, bio, avatar_url, banner, follower_count, following_count,
               created_at, updated_at, show_email, public_email, show_usage_warning, advanced_mode)
  ON public.profiles TO anon, authenticated;
GRANT  UPDATE (username, display_name, bio, avatar_url, banner, show_email, show_usage_warning, advanced_mode)
  ON public.profiles TO authenticated;
GRANT  ALL ON public.profiles TO service_role;

-- ═══ 4. billing_history: receipts are written by the webhook (service role) only ═══════════════════
DROP POLICY IF EXISTS "Users can insert own billing history" ON public.billing_history;
DROP POLICY IF EXISTS "Users can read own billing history"   ON public.billing_history;
REVOKE ALL ON public.billing_history FROM PUBLIC, anon, authenticated;
GRANT  SELECT ON public.billing_history TO authenticated;
GRANT  ALL    ON public.billing_history TO service_role;
CREATE POLICY "Users can read own billing history" ON public.billing_history
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

-- ═══ 5. Site-user password hashes are never readable by clients ════════════════════════════════════
-- Owners read their site users straight from the browser (explicit column lists, no password_hash).
REVOKE ALL ON public.site_users FROM PUBLIC, anon, authenticated;
GRANT  SELECT (id, project_id, email, created_at, metadata) ON public.site_users TO authenticated;
GRANT  DELETE ON public.site_users TO authenticated;
GRANT  ALL    ON public.site_users TO service_role;

-- ═══ 6. vexium_site_query: confine the SQL tab to the owner's own project data ═════════════════════
-- Previously: SECURITY DEFINER (runs as table owner) + the caller's text concatenated into a CTE, so a "SELECT"
-- could read auth.users, profiles, other projects' data... via qualified names, and anon could call it directly.
-- Now:  (a) service-role only; (b) the project's rows are copied into TEMP tables named site_data / site_users;
-- (c) the caller's SELECT runs inside vx_sandbox.run(), a function OWNED BY a role that can read nothing except
-- those temp tables. No role switching is involved (SET ROLE would depend on the session user at runtime).
-- The full redesign (per-project views, rate limits) is still REVAMP Step 4.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vexium_sql_ro') THEN
    CREATE ROLE vexium_sql_ro NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT vexium_sql_ro TO postgres;   -- lets the migration owner create objects owned by it

CREATE SCHEMA IF NOT EXISTS vx_sandbox AUTHORIZATION vexium_sql_ro;
REVOKE ALL ON SCHEMA vx_sandbox FROM PUBLIC;
GRANT  USAGE ON SCHEMA vx_sandbox TO postgres;

CREATE OR REPLACE FUNCTION vx_sandbox.run(p_sql text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_temp'
AS $function$
DECLARE
  v_result json;
BEGIN
  EXECUTE 'SELECT json_agg(row_to_json(_q)) FROM (' || p_sql || E'\n) _q' INTO v_result;
  RETURN v_result;
END;
$function$;
ALTER FUNCTION vx_sandbox.run(text) OWNER TO vexium_sql_ro;
REVOKE ALL ON FUNCTION vx_sandbox.run(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION vx_sandbox.run(text) TO postgres;

CREATE OR REPLACE FUNCTION public.vexium_site_query(p_project_id text, p_query text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_q      text := btrim(p_query, E' \t\r\n;');
  v_result json;
BEGIN
  IF v_q !~* '^select\y' THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;
  IF position(';' IN v_q) > 0 THEN
    RAISE EXCEPTION 'Only a single statement is allowed';
  END IF;

  DROP TABLE IF EXISTS pg_temp.site_data;
  DROP TABLE IF EXISTS pg_temp.site_users;
  CREATE TEMP TABLE site_data ON COMMIT DROP AS
    SELECT * FROM public.site_data WHERE project_id = p_project_id ORDER BY created_at DESC LIMIT 50000;
  CREATE TEMP TABLE site_users ON COMMIT DROP AS
    SELECT id, project_id, email, created_at, metadata FROM public.site_users WHERE project_id = p_project_id LIMIT 50000;
  GRANT SELECT ON pg_temp.site_data, pg_temp.site_users TO vexium_sql_ro;

  SET LOCAL statement_timeout = '8s';
  v_result := vx_sandbox.run(v_q);
  RETURN COALESCE(v_result, '[]'::json);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION '%', SQLERRM;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.vexium_site_query(text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vexium_site_query(text, text) TO service_role;

-- Make PostgREST see the new table/columns immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
