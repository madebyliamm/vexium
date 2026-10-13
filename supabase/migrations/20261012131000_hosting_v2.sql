-- Vertly REVAMP Step 3 — Hosting v2 (versioned deploys in R2).
--
-- • project_deploys   one row per publish; the files themselves live in R2 under p/<project_id>/v<version>/…
-- • projects.published_version   the live pointer (NULL = legacy site still served from published_files jsonb)
-- • resolve_published_site()     host/username+slug -> (project, version, main file) in ONE round trip for the Worker
-- • guard trigger                clients can no longer write published_version or the custom_domain* columns
--                                (custom_domain is only written by the `custom-domain` edge fn, the pointer only by
--                                the publisher Worker — both use the service role)
--
-- Apply (after 20261012130000_projects_rls.sql):
--   supabase db query --linked -f supabase/migrations/20261012131000_hosting_v2.sql
-- Verify:  supabase db query --linked -f supabase/tests/step3_hosting_v2.sql   (always rolls back)
-- Additive and safe to apply before the Worker is deployed: nothing reads these objects until then.

BEGIN;

-- ═══ 1. deploys ════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.project_deploys (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  text        NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  version     integer     NOT NULL CHECK (version > 0),
  status      text        NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready', 'failed')),
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  main_file   text        NOT NULL DEFAULT 'index.html',
  file_count  integer     NOT NULL DEFAULT 0,
  total_bytes bigint      NOT NULL DEFAULT 0,
  -- The parsed `_backend` file (collections, products, auth rules). It is NOT published to R2 (so it can't be
  -- fetched from the site) — server code (stripe-site-checkout today, site-api in Step 4) reads it from here.
  backend     jsonb,
  UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS project_deploys_project_idx ON public.project_deploys (project_id, version DESC);

ALTER TABLE public.project_deploys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_deploys FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.project_deploys TO authenticated;       -- history UI; all writes are service-role only
GRANT ALL    ON public.project_deploys TO service_role;

DROP POLICY IF EXISTS project_deploys_select ON public.project_deploys;
CREATE POLICY project_deploys_select ON public.project_deploys AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    project_id IN (SELECT p.id FROM public.projects p WHERE p.user_id = auth.uid())
    OR project_id IN (SELECT pm.project_id FROM public.project_members pm WHERE pm.user_id = auth.uid() AND pm.status = 'accepted')
  );

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS published_version integer;

-- ═══ 2. route resolution for the publisher Worker ═════════════════════════════════════════════════════
-- Callable by anon (the Worker uses the anon key); returns only what is needed to serve, nothing private.
--   by host     : resolve_published_site(p_host => 'www.example.com')
--   by subdomain: resolve_published_site(p_username => 'liam', p_slug => 'webre')
-- legacy = site published before v2 (no version yet) -> the Worker falls back to projects.published_files.
CREATE OR REPLACE FUNCTION public.resolve_published_site(p_username text DEFAULT NULL, p_slug text DEFAULT NULL, p_host text DEFAULT NULL)
RETURNS TABLE (project_id text, version integer, main_file text, legacy boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id,
         p.published_version,
         coalesce(d.main_file, nullif(p.main_file, ''), 'index.html'),
         (p.published_version IS NULL)
  FROM public.projects p
  LEFT JOIN public.project_deploys d
         ON d.project_id = p.id AND d.version = p.published_version AND d.status = 'ready'
  WHERE p.published_slug IS NOT NULL
    AND (p.published_version IS NULL OR d.id IS NOT NULL)
    AND CASE
          WHEN p_host IS NOT NULL THEN p.custom_domain <> '' AND lower(p.custom_domain) = lower(p_host)
          ELSE p.published_slug = p_slug
               AND p.user_id = (SELECT pr.id FROM public.profiles pr WHERE pr.username = p_username)
        END
  ORDER BY p.custom_domain_verified DESC NULLS LAST
  LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.resolve_published_site(text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.resolve_published_site(text, text, text) TO anon, authenticated, service_role;

-- ═══ 3. who may write what on `projects` ═══════════════════════════════════════════════════════════════
-- A client could otherwise claim someone else's domain (the Worker routes by custom_domain) or point the live
-- pointer at an arbitrary version. API roles (anon/authenticated) are blocked; the service role and direct DB
-- sessions are not.
CREATE OR REPLACE FUNCTION public.projects_guard_hosting_columns() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF coalesce(auth.role(), 'postgres') IN ('anon', 'authenticated') AND (
       NEW.published_version        IS DISTINCT FROM OLD.published_version
    OR NEW.custom_domain            IS DISTINCT FROM OLD.custom_domain
    OR NEW.custom_domain_cf_id      IS DISTINCT FROM OLD.custom_domain_cf_id
    OR NEW.custom_domain_verified   IS DISTINCT FROM OLD.custom_domain_verified
  ) THEN
    RAISE EXCEPTION 'hosting columns are managed by the platform' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.projects_guard_hosting_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS projects_guard_hosting_columns ON public.projects;
CREATE TRIGGER projects_guard_hosting_columns BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.projects_guard_hosting_columns();

-- One project per hostname (empty/NULL = no domain).
CREATE UNIQUE INDEX IF NOT EXISTS projects_custom_domain_uidx
  ON public.projects (lower(custom_domain)) WHERE custom_domain IS NOT NULL AND custom_domain <> '';

COMMIT;
