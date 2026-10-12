-- Vertly / Vexium — Supabase schema SNAPSHOT (reference only, NOT a migration)
-- Generated 2026-10-12 by scripts/export-schema.py from project ciuqhxrxcznmgorjeumz
-- Extensions: pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp

-- ── ai_messages  (~213 rows, RLS ON) ──────────
CREATE TABLE public."ai_messages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "file_names" text[] NOT NULL DEFAULT '{}'::text[],
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "sender_display_name" text,
  "sender_username" text,
  CONSTRAINT "ai_messages_pkey" PRIMARY KEY (id),
  CONSTRAINT "ai_messages_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "ai_messages_role_check" CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
  CONSTRAINT "ai_messages_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ai_messages_pkey ON public.ai_messages USING btree (id);
CREATE INDEX ai_messages_project_id_idx ON public.ai_messages USING btree (project_id, created_at);
ALTER TABLE public."ai_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_messages_delete" ON public."ai_messages" AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "ai_messages_insert" ON public."ai_messages" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "ai_messages_select" ON public."ai_messages" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "collab_insert_messages" ON public."ai_messages" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((user_id = auth.uid()) AND ((EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = ai_messages.project_id) AND (projects.user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM project_members
  WHERE ((project_members.project_id = ai_messages.project_id) AND (project_members.user_id = auth.uid()) AND (project_members.status = 'accepted'::text)))))));
CREATE POLICY "collab_read_messages" ON public."ai_messages" AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR (project_id IN ( SELECT project_members.project_id
   FROM project_members
  WHERE ((project_members.user_id = auth.uid()) AND (project_members.status = 'accepted'::text))))));

-- ── billing_history  (~18 rows, RLS ON) ──────────
CREATE TABLE public."billing_history" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "type" text NOT NULL DEFAULT 'extra_usage'::text,
  "description" text NOT NULL,
  "amount_paid_cents" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "billing_history_pkey" PRIMARY KEY (id),
  CONSTRAINT "billing_history_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX billing_history_pkey ON public.billing_history USING btree (id);
ALTER TABLE public."billing_history" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can insert own billing history" ON public."billing_history" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can read own billing history" ON public."billing_history" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

-- ── build_jobs  (~118 rows, RLS ON) ──────────
CREATE TABLE public."build_jobs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'running'::text,
  "prompt" text NOT NULL DEFAULT ''::text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "build_jobs_pkey" PRIMARY KEY (id),
  CONSTRAINT "build_jobs_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "build_jobs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX build_jobs_pkey ON public.build_jobs USING btree (id);
ALTER TABLE public."build_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own build jobs" ON public."build_jobs" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

-- ── feedback  (~1 rows, RLS ON) ──────────
CREATE TABLE public."feedback" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid,
  "type" text NOT NULL DEFAULT 'other'::text,
  "message" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "feedback_pkey" PRIMARY KEY (id),
  CONSTRAINT "feedback_type_check" CHECK ((type = ANY (ARRAY['bug'::text, 'suggestion'::text, 'other'::text]))),
  CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX feedback_pkey ON public.feedback USING btree (id);
ALTER TABLE public."feedback" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can insert feedback" ON public."feedback" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Only service role can read feedback" ON public."feedback" AS PERMISSIVE FOR SELECT TO public USING (false);

-- ── follows  (~3 rows, RLS ON) ──────────
CREATE TABLE public."follows" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "follower_id" uuid NOT NULL,
  "following_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "follows_check" CHECK ((follower_id <> following_id)),
  CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY (follower_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT "follows_follower_id_following_id_key" UNIQUE (follower_id, following_id),
  CONSTRAINT "follows_following_id_fkey" FOREIGN KEY (following_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT "follows_pkey" PRIMARY KEY (id)
);
CREATE UNIQUE INDEX follows_follower_id_following_id_key ON public.follows USING btree (follower_id, following_id);
CREATE UNIQUE INDEX follows_pkey ON public.follows USING btree (id);
ALTER TABLE public."follows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "follows_delete_own" ON public."follows" AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = follower_id));
CREATE POLICY "follows_insert_own" ON public."follows" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = follower_id));
CREATE POLICY "follows_select" ON public."follows" AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE TRIGGER on_follow_delete AFTER DELETE ON public.follows FOR EACH ROW EXECUTE FUNCTION handle_follow_delete();
CREATE TRIGGER on_follow_insert AFTER INSERT ON public.follows FOR EACH ROW EXECUTE FUNCTION handle_follow_insert();
CREATE TRIGGER on_follow_notify AFTER INSERT ON public.follows FOR EACH ROW EXECUTE FUNCTION handle_follow_notify();

-- ── notifications  (~4 rows, RLS ON) ──────────
CREATE TABLE public."notifications" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "actor_id" uuid,
  "type" text NOT NULL,
  "project_id" text,
  "read" boolean DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT "notifications_pkey" PRIMARY KEY (id),
  CONSTRAINT "notifications_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "notifications_type_check" CHECK ((type = ANY (ARRAY['follow'::text, 'project_invite'::text]))),
  CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id);
ALTER TABLE public."notifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notif_delete" ON public."notifications" AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "notif_insert" ON public."notifications" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "notif_select" ON public."notifications" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));
CREATE POLICY "notif_update" ON public."notifications" AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = user_id));

-- ── page_views  (~904 rows, RLS ON) ──────────
CREATE TABLE public."page_views" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "page" text NOT NULL DEFAULT '/'::text,
  "referrer" text DEFAULT ''::text,
  "device" text DEFAULT 'unknown'::text,
  "country" text DEFAULT ''::text,
  "session_id" text DEFAULT ''::text,
  "ts" timestamp with time zone DEFAULT now(),
  "visitor_id" text DEFAULT ''::text,
  CONSTRAINT "page_views_pkey" PRIMARY KEY (id),
  CONSTRAINT "page_views_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX page_views_pkey ON public.page_views USING btree (id);
CREATE INDEX page_views_project_ts_idx ON public.page_views USING btree (project_id, ts DESC);
ALTER TABLE public."page_views" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners can read their page views" ON public."page_views" AS PERMISSIVE FOR SELECT TO public USING ((project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid()))));

-- ── plan_messages  (~0 rows, RLS ON) ──────────
CREATE TABLE public."plan_messages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "plan_messages_pkey" PRIMARY KEY (id),
  CONSTRAINT "plan_messages_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "plan_messages_role_check" CHECK ((role = ANY (ARRAY['user'::text, 'ai'::text]))),
  CONSTRAINT "plan_messages_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX plan_messages_pkey ON public.plan_messages USING btree (id);
CREATE INDEX plan_messages_project_id_idx ON public.plan_messages USING btree (project_id, created_at);
ALTER TABLE public."plan_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plan_messages_delete" ON public."plan_messages" AS PERMISSIVE FOR DELETE TO public USING ((auth.uid() = user_id));
CREATE POLICY "plan_messages_insert" ON public."plan_messages" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "plan_messages_select" ON public."plan_messages" AS PERMISSIVE FOR SELECT TO public USING ((auth.uid() = user_id));

-- ── profiles  (~5 rows, RLS ON) ──────────
CREATE TABLE public."profiles" (
  "id" uuid NOT NULL,
  "username" text,
  "display_name" text,
  "bio" text DEFAULT ''::text,
  "avatar_url" text DEFAULT ''::text,
  "follower_count" integer DEFAULT 0,
  "following_count" integer DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "show_usage_warning" boolean DEFAULT true,
  "tokens_used_this_month" bigint DEFAULT 0,
  "usage_month" text DEFAULT to_char(now(), 'YYYY-MM'::text),
  "credits_used_cents" bigint DEFAULT 0,
  "advanced_mode" boolean DEFAULT false,
  "email" text,
  "show_email" boolean DEFAULT false,
  "plan" text NOT NULL DEFAULT 'trial'::text,
  "trial_ends_at" timestamp with time zone,
  "selected_plan" text NOT NULL DEFAULT 'pro'::text,
  "extra_credits_cents" integer NOT NULL DEFAULT 0,
  "extra_credits_purchased_cents" integer NOT NULL DEFAULT 0,
  "plan_cycle_start" timestamp with time zone NOT NULL DEFAULT now(),
  "billing_period" text DEFAULT 'monthly'::text,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "stripe_connect_account_id" text,
  "stripe_connect_charges_enabled" boolean NOT NULL DEFAULT false,
  "banner" text,
  CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT "profiles_pkey" PRIMARY KEY (id),
  CONSTRAINT "profiles_username_key" UNIQUE (username)
);
CREATE INDEX idx_profiles_stripe_customer_id ON public.profiles USING btree (stripe_customer_id);
CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);
CREATE UNIQUE INDEX profiles_username_key ON public.profiles USING btree (username);
ALTER TABLE public."profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_anon_read" ON public."profiles" AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "profiles_insert_own" ON public."profiles" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = id));
CREATE POLICY "profiles_select" ON public."profiles" AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "profiles_update_own" ON public."profiles" AS PERMISSIVE FOR UPDATE TO public USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));
CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_zero_tiny_extra_credits BEFORE INSERT OR UPDATE OF extra_credits_cents ON public.profiles FOR EACH ROW EXECUTE FUNCTION zero_tiny_extra_credits();

-- ── project_backups  (~2 rows, RLS ON) ──────────
CREATE TABLE public."project_backups" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "slot" integer NOT NULL,
  "label" text,
  "files" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "project_backups_pkey" PRIMARY KEY (id),
  CONSTRAINT "project_backups_project_id_slot_key" UNIQUE (project_id, slot),
  CONSTRAINT "project_backups_slot_check" CHECK (((slot >= 1) AND (slot <= 3)))
);
CREATE UNIQUE INDEX project_backups_pkey ON public.project_backups USING btree (id);
CREATE UNIQUE INDEX project_backups_project_id_slot_key ON public.project_backups USING btree (project_id, slot);
ALTER TABLE public."project_backups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners can manage backups" ON public."project_backups" AS PERMISSIVE FOR ALL TO public USING ((project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid()))));

-- ── project_members  (~0 rows, RLS ON) ──────────
CREATE TABLE public."project_members" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL DEFAULT 'editor'::text,
  "invited_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "status" text NOT NULL DEFAULT 'accepted'::text,
  CONSTRAINT "project_members_invited_by_fkey" FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT "project_members_pkey" PRIMARY KEY (id),
  CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "project_members_project_id_user_id_key" UNIQUE (project_id, user_id),
  CONSTRAINT "project_members_role_check" CHECK ((role = 'editor'::text)),
  CONSTRAINT "project_members_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text]))),
  CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX project_members_pkey ON public.project_members USING btree (id);
CREATE UNIQUE INDEX project_members_project_id_user_id_key ON public.project_members USING btree (project_id, user_id);
ALTER TABLE public."project_members" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members_delete" ON public."project_members" AS PERMISSIVE FOR DELETE TO public USING (((auth.uid() = user_id) OR is_project_owner(project_id, auth.uid())));
CREATE POLICY "members_insert" ON public."project_members" AS PERMISSIVE FOR INSERT TO public WITH CHECK (is_project_owner(project_id, auth.uid()));
CREATE POLICY "members_select" ON public."project_members" AS PERMISSIVE FOR SELECT TO public USING (((auth.uid() = user_id) OR is_project_owner(project_id, auth.uid())));
CREATE POLICY "project_members_update" ON public."project_members" AS PERMISSIVE FOR UPDATE TO public USING (((user_id = auth.uid()) OR (project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid())))));
CREATE TRIGGER on_invite_notify AFTER INSERT ON public.project_members FOR EACH ROW EXECUTE FUNCTION handle_invite_notify();

-- ── projects  (~9 rows, RLS ON) ──────────
CREATE TABLE public."projects" (
  "id" text NOT NULL,
  "user_id" uuid,
  "name" text NOT NULL DEFAULT 'Untitled'::text,
  "emoji" text DEFAULT '💻'::text,
  "files" jsonb DEFAULT '{}'::jsonb,
  "main_file" text DEFAULT 'index.html'::text,
  "is_public" boolean DEFAULT false,
  "custom_domain" text DEFAULT ''::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "project_type" text,
  "project_phases" text,
  "current_phase" integer DEFAULT 0,
  "ai_context" jsonb DEFAULT '{}'::jsonb,
  "published_slug" text,
  "published_at" timestamp with time zone,
  "published_files" jsonb,
  "custom_domain_cf_id" text,
  "custom_domain_verified" boolean DEFAULT false,
  "ai_lock_user_id" uuid,
  "ai_lock_at" timestamp with time zone,
  "ai_lock_name" text,
  "stripe_connect_account_id" text,
  "stripe_connect_charges_enabled" boolean DEFAULT false,
  CONSTRAINT "projects_pkey" PRIMARY KEY (id),
  CONSTRAINT "projects_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX projects_pkey ON public.projects USING btree (id);
CREATE UNIQUE INDEX projects_published_slug_user_idx ON public.projects USING btree (user_id, published_slug) WHERE (published_slug IS NOT NULL);
ALTER TABLE public."projects" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone can delete projects" ON public."projects" AS PERMISSIVE FOR DELETE TO public USING (true);
CREATE POLICY "anyone can update projects" ON public."projects" AS PERMISSIVE FOR UPDATE TO public USING (true);
CREATE POLICY "projects_insert_own" ON public."projects" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "projects_published_anon_read" ON public."projects" AS PERMISSIVE FOR SELECT TO anon USING ((published_slug IS NOT NULL));
CREATE POLICY "projects_select" ON public."projects" AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR (is_public = true) OR (id IN ( SELECT project_members.project_id
   FROM project_members
  WHERE ((project_members.user_id = auth.uid()) AND (project_members.status = ANY (ARRAY['pending'::text, 'accepted'::text])))))));
CREATE TRIGGER set_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── site_data  (~1 rows, RLS ON) ──────────
CREATE TABLE public."site_data" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "collection" text NOT NULL DEFAULT 'default'::text,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "site_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "site_data_pkey" PRIMARY KEY (id),
  CONSTRAINT "site_data_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "site_data_site_user_id_fkey" FOREIGN KEY (site_user_id) REFERENCES site_users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX site_data_pkey ON public.site_data USING btree (id);
CREATE INDEX site_data_project_collection_idx ON public.site_data USING btree (project_id, collection, created_at DESC);
ALTER TABLE public."site_data" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners can delete their site data" ON public."site_data" AS PERMISSIVE FOR DELETE TO public USING ((project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid()))));
CREATE POLICY "owners can read their site data" ON public."site_data" AS PERMISSIVE FOR SELECT TO public USING ((project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid()))));

-- ── site_users  (~0 rows, RLS ON) ──────────
CREATE TABLE public."site_users" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "site_users_pkey" PRIMARY KEY (id),
  CONSTRAINT "site_users_project_id_email_key" UNIQUE (project_id, email),
  CONSTRAINT "site_users_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX site_users_pkey ON public.site_users USING btree (id);
CREATE INDEX site_users_project_email_idx ON public.site_users USING btree (project_id, email);
CREATE UNIQUE INDEX site_users_project_id_email_key ON public.site_users USING btree (project_id, email);
ALTER TABLE public."site_users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners can delete their site users" ON public."site_users" AS PERMISSIVE FOR DELETE TO public USING ((project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid()))));
CREATE POLICY "owners can read their site users" ON public."site_users" AS PERMISSIVE FOR SELECT TO public USING ((project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid()))));

-- ── FUNCTIONS (SECURITY DEFINER marked) ────────────────────
-- check_signup_availability  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.check_signup_availability(p_username text, p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  username_taken boolean;
  email_taken boolean;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM auth.users
    WHERE lower(raw_user_meta_data->>'username') = lower(p_username)
  ) INTO username_taken;

  SELECT EXISTS(
    SELECT 1 FROM profiles
    WHERE lower(email) = lower(p_email)
  ) INTO email_taken;

  RETURN jsonb_build_object('username_taken', username_taken, 'email_taken', email_taken);
END;
$function$;

-- delete_own_account  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.delete_own_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin delete from auth.users where id = auth.uid(); end; $function$;

-- get_email_by_username  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.get_email_by_username(p_username text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text;
BEGIN
  SELECT email INTO v_email
  FROM profiles
  WHERE lower(username) = lower(p_username)
  LIMIT 1;
  RETURN v_email;
END;
$function$;

-- get_follow_counts  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.get_follow_counts(p_user_id uuid)
 RETURNS TABLE(followers bigint, following bigint)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select
    (select count(*) from public.follows where following_id = p_user_id) as followers,
    (select count(*) from public.follows where follower_id  = p_user_id) as following;
$function$;

-- get_my_member_project_ids
CREATE OR REPLACE FUNCTION public.get_my_member_project_ids()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT project_id FROM project_members
  WHERE user_id = auth.uid()
  AND status IN ('pending', 'accepted');
$function$;

-- get_my_page_views  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.get_my_page_views(since_ts timestamp with time zone)
 RETURNS TABLE(project_id text, session_id text, device text, referrer text, ts timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT pv.project_id, pv.session_id, pv.device, pv.referrer, pv.ts
  FROM public.page_views pv
  INNER JOIN public.projects p ON p.id = pv.project_id
  WHERE p.user_id = auth.uid()
  AND pv.ts >= since_ts
  ORDER BY pv.ts ASC;
$function$;

-- get_my_projects  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.get_my_projects()
 RETURNS TABLE(id text, name text, is_public boolean)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  SELECT id, name, is_public
  FROM public.projects
  WHERE user_id = auth.uid()
  ORDER BY updated_at DESC;
$function$;

-- get_user_id_by_username  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.get_user_id_by_username(uname text)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select id from public.profiles where lower(username) = lower(uname) limit 1;
$function$;

-- handle_follow_delete  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.handle_follow_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  update public.profiles set following_count = greatest(following_count - 1, 0) where id = old.follower_id;
  update public.profiles set follower_count  = greatest(follower_count  - 1, 0) where id = old.following_id;
  return old;
end; $function$;

-- handle_follow_insert  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.handle_follow_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  update public.profiles set following_count = following_count + 1 where id = new.follower_id;
  update public.profiles set follower_count  = follower_count  + 1 where id = new.following_id;
  return new;
end; $function$;

-- handle_follow_notify  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.handle_follow_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  insert into public.notifications (user_id, actor_id, type)
  values (new.following_id, new.follower_id, 'follow');
  return new;
end; $function$;

-- handle_invite_notify  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.handle_invite_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  insert into public.notifications (user_id, actor_id, type, project_id)
  values (new.user_id, new.invited_by, 'project_invite', new.project_id);
  return new;
end; $function$;

-- handle_new_user  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, username, display_name, email)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'username', ''), split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nullif(new.raw_user_meta_data->>'username', ''), split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$function$;

-- increment_usage  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.increment_usage(p_user_id uuid, p_cents integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_cycle_start TIMESTAMPTZ;
  v_now         TIMESTAMPTZ := NOW();
  v_cycle_ms    INTERVAL    := INTERVAL '30 days';
BEGIN
  SELECT plan_cycle_start INTO v_cycle_start
  FROM profiles WHERE id = p_user_id;

  IF v_cycle_start IS NULL THEN
    v_cycle_start := v_now;
  END IF;

  -- Advance cycle start in 30-day steps until it's within the current window
  WHILE v_cycle_start + v_cycle_ms <= v_now LOOP
    v_cycle_start := v_cycle_start + v_cycle_ms;
  END LOOP;

  UPDATE profiles SET
    credits_used_cents = CASE
      WHEN v_cycle_start > plan_cycle_start THEN p_cents
      ELSE credits_used_cents + p_cents
    END,
    plan_cycle_start = v_cycle_start
  WHERE id = p_user_id;
END;
$function$;

-- is_following  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.is_following(follower uuid, following uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select exists (select 1 from public.follows where follower_id = follower and following_id = following);
$function$;

-- is_project_member  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.is_project_member(p_project_id text, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from public.project_members where project_id = p_project_id and user_id = p_user_id
  );
$function$;

-- is_project_owner  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.is_project_owner(p_project_id text, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select exists (
    select 1 from public.projects where id = p_project_id and user_id = p_user_id
  );
$function$;

-- log_usage  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.log_usage(p_user_id uuid, p_project_id uuid, p_action text, p_tokens_input integer, p_tokens_output integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_total integer := p_tokens_input + p_tokens_output;
  v_limit bigint; v_used bigint; v_is_overage boolean := false;
begin
  select tokens_monthly_limit, tokens_used_this_month
  into v_limit, v_used from profiles where id = p_user_id;

  if (v_used + v_total) > v_limit then
    v_is_overage := true;
    update profiles set overage_tokens = overage_tokens + v_total, updated_at = now() where id = p_user_id;
  else
    update profiles set tokens_used_this_month = tokens_used_this_month + v_total, updated_at = now() where id = p_user_id;
  end if;

  insert into usage_log (user_id, project_id, action, tokens_input, tokens_output, tokens_total, is_overage)
  values (p_user_id, p_project_id, p_action, p_tokens_input, p_tokens_output, v_total, v_is_overage);
end;
$function$;

-- set_updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at = now(); return new; end; $function$;

-- vexium_site_query  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.vexium_site_query(p_project_id text, p_query text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result json;
  v_cte text;
  v_full_query text;
BEGIN
  IF NOT (lower(trim(p_query)) LIKE 'select%') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  -- Build CTE that exposes site_data and site_users scoped to this project,
  -- plus each collection as a named virtual table
  v_cte := format(
    'WITH _data AS (SELECT * FROM public.site_data WHERE project_id = %L),
          _users AS (SELECT id, email, created_at, metadata FROM public.site_users WHERE project_id = %L),
          site_data AS (SELECT * FROM _data),
          site_users AS (SELECT * FROM _users)',
    p_project_id, p_project_id
  );

  v_full_query := v_cte || ', _user_query AS (' || p_query || ') SELECT json_agg(row_to_json(_user_query)) FROM _user_query';

  EXECUTE v_full_query INTO v_result;
  RETURN COALESCE(v_result, '[]'::json);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION '%', SQLERRM;
END;
$function$;

-- zero_tiny_extra_credits
CREATE OR REPLACE FUNCTION public.zero_tiny_extra_credits()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.extra_credits_cents IS NOT NULL AND NEW.extra_credits_cents > 0 AND NEW.extra_credits_cents <= 10 THEN
    NEW.extra_credits_cents := 0;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── STORAGE ────────────────────
-- bucket profile-media: public=True size_limit=None mime=None
-- storage.objects policy "profile media delete own" FOR DELETE TO authenticated USING (((bucket_id = 'profile-media'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)))
-- storage.objects policy "profile media insert own" FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'profile-media'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)))
-- storage.objects policy "profile media public read" FOR SELECT TO public USING ((bucket_id = 'profile-media'::text))
-- storage.objects policy "profile media update own" FOR UPDATE TO authenticated USING (((bucket_id = 'profile-media'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)))
