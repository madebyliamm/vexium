-- REVAMP Step 4 — close SECURITY_FINDINGS #10 (+ the signup-enumeration sibling).
--
-- `get_email_by_username` returned the REAL email of any username to anyone holding the public anon key;
-- `check_signup_availability` let anyone test which usernames/emails are registered. Both are now served by the
-- `auth-gate` edge function (service role, rate limited), so the RPCs are service-role only.
--
-- ORDER MATTERS: apply this ONLY AFTER `auth-gate` is deployed AND the new auth.html is live (pushed), otherwise
-- username login and the signup availability check break.
--
-- Apply:  supabase db query --linked -f supabase/migrations/20261012141000_revoke_enumeration_rpcs.sql
BEGIN;

REVOKE EXECUTE ON FUNCTION public.get_email_by_username(text)            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_signup_availability(text, text)  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_email_by_username(text)            TO service_role;
GRANT  EXECUTE ON FUNCTION public.check_signup_availability(text, text)  TO service_role;

COMMIT;
