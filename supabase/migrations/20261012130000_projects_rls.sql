-- Vertly REVAMP Step 3 (found during hosting recon) — close the open write policies on public.projects.
-- Fixes docs/SECURITY_FINDINGS.md #16.
--
-- Before: policies "anyone can update projects" / "anyone can delete projects" were USING (true) for role PUBLIC,
-- and anon has table-level UPDATE/DELETE, so anyone holding the public anon key could overwrite or delete ANY
-- project (files, published_files, custom_domain, user_id…) through PostgREST.
--
-- After: UPDATE = the owner or an ACCEPTED collaborator (the editor saves `files` as a member); DELETE = owner only;
-- ownership can't be moved by a client; anon can no longer write to the table at all.
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261012130000_projects_rls.sql
-- Verify:  supabase db query --linked -f supabase/tests/step3_projects_rls.sql   (always rolls back)
-- No page/function redeploy needed: every client write to `projects` is made by a signed-in owner/member, and the
-- edge functions + build Worker use the service role (bypasses RLS).

BEGIN;

DROP POLICY IF EXISTS "anyone can update projects" ON public.projects;
DROP POLICY IF EXISTS "anyone can delete projects" ON public.projects;

CREATE POLICY projects_update_owner_or_member ON public.projects
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR id IN (SELECT pm.project_id FROM public.project_members pm WHERE pm.user_id = auth.uid() AND pm.status = 'accepted')
  )
  WITH CHECK (
    user_id = auth.uid()
    OR id IN (SELECT pm.project_id FROM public.project_members pm WHERE pm.user_id = auth.uid() AND pm.status = 'accepted')
  );

CREATE POLICY projects_delete_owner ON public.projects
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- A collaborator passes the WITH CHECK above for any value of user_id, so ownership transfer needs its own guard.
-- Only API roles are restricted; service role and direct DB sessions (migrations, support) are not.
CREATE OR REPLACE FUNCTION public.projects_guard_owner() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id AND coalesce(auth.role(), 'postgres') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'project ownership cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.projects_guard_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS projects_guard_owner ON public.projects;
CREATE TRIGGER projects_guard_owner BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.projects_guard_owner();

-- Defence in depth: anon only ever reads projects (the publisher Worker + public profiles use the anon key).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.projects FROM anon;

COMMIT;
