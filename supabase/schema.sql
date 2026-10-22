-- Vertly / Vexium — Supabase schema SNAPSHOT (reference only, NOT a migration)
-- Generated 2026-10-22 by scripts/export-schema.py from project ciuqhxrxcznmgorjeumz
-- Extensions: pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp

-- ── account_billing  (~6 rows, RLS ON) ──────────
CREATE TABLE public."account_billing" (
  "user_id" uuid NOT NULL,
  "plan" text NOT NULL DEFAULT 'trial'::text,
  "selected_plan" text NOT NULL DEFAULT 'pro'::text,
  "trial_ends_at" timestamp with time zone,
  "credits_used_cents" bigint NOT NULL DEFAULT 0,
  "extra_credits_cents" integer NOT NULL DEFAULT 0,
  "extra_credits_purchased_cents" integer NOT NULL DEFAULT 0,
  "plan_cycle_start" timestamp with time zone NOT NULL DEFAULT now(),
  "billing_period" text DEFAULT 'monthly'::text,
  "tokens_used_this_month" bigint DEFAULT 0,
  "usage_month" text DEFAULT to_char(now(), 'YYYY-MM'::text),
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "stripe_connect_account_id" text,
  "stripe_connect_charges_enabled" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "account_billing_pkey" PRIMARY KEY (user_id),
  CONSTRAINT "account_billing_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX account_billing_pkey ON public.account_billing USING btree (user_id);
CREATE INDEX idx_account_billing_stripe_customer_id ON public.account_billing USING btree (stripe_customer_id);
ALTER TABLE public."account_billing" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "account_billing_select_own" ON public."account_billing" AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE TRIGGER set_account_billing_updated_at BEFORE UPDATE ON public.account_billing FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_zero_tiny_extra_credits BEFORE INSERT OR UPDATE OF extra_credits_cents ON public.account_billing FOR EACH ROW EXECUTE FUNCTION zero_tiny_extra_credits();

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
CREATE POLICY "Users can read own billing history" ON public."billing_history" AS PERMISSIVE FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));

-- ── build_jobs  (~118 rows, RLS ON) ──────────
CREATE TABLE public."build_jobs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'running'::text,
  "prompt" text NOT NULL DEFAULT ''::text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "stage" text,
  "artifact_kind" text,
  "finished_at" timestamp with time zone,
  "error" text,
  "heartbeat_at" timestamp with time zone,
  CONSTRAINT "build_jobs_artifact_kind_check" CHECK (((artifact_kind IS NULL) OR (artifact_kind = ANY (ARRAY['plan'::text, 'style_spec'::text, 'manifest'::text, 'launch_checks'::text, 'business_state'::text])))),
  CONSTRAINT "build_jobs_pkey" PRIMARY KEY (id),
  CONSTRAINT "build_jobs_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "build_jobs_stage_check" CHECK (((stage IS NULL) OR (stage = ANY (ARRAY['plan'::text, 'example'::text, 'build'::text, 'tweaks'::text, 'launch'::text, 'business'::text])))),
  CONSTRAINT "build_jobs_status_check" CHECK ((status = ANY (ARRAY['running'::text, 'complete'::text, 'failed'::text]))),
  CONSTRAINT "build_jobs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX build_jobs_pkey ON public.build_jobs USING btree (id);
CREATE INDEX build_jobs_project_idx ON public.build_jobs USING btree (project_id, created_at DESC);
ALTER TABLE public."build_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own build jobs" ON public."build_jobs" AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

-- ── build_steps  (~0 rows, RLS ON) ──────────
CREATE TABLE public."build_steps" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "job_id" uuid NOT NULL,
  "project_id" text NOT NULL,
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  "file" text,
  "label" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending'::text,
  "attempt" integer NOT NULL DEFAULT 0,
  "detail" text,
  "cost_cents" numeric(10,2) NOT NULL DEFAULT 0,
  "output" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "build_steps_job_id_fkey" FOREIGN KEY (job_id) REFERENCES build_jobs(id) ON DELETE CASCADE,
  CONSTRAINT "build_steps_job_seq_key" UNIQUE (job_id, seq),
  CONSTRAINT "build_steps_kind_check" CHECK ((kind = ANY (ARRAY['prepare'::text, 'page'::text, 'fix'::text, 'verify'::text, 'save'::text]))),
  CONSTRAINT "build_steps_label_check" CHECK (((char_length(label) >= 1) AND (char_length(label) <= 200))),
  CONSTRAINT "build_steps_output_check" CHECK (((output IS NULL) OR (char_length(output) <= 600000))),
  CONSTRAINT "build_steps_pkey" PRIMARY KEY (id),
  CONSTRAINT "build_steps_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "build_steps_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text, 'skipped'::text])))
);
CREATE UNIQUE INDEX build_steps_job_seq_key ON public.build_steps USING btree (job_id, seq);
CREATE UNIQUE INDEX build_steps_pkey ON public.build_steps USING btree (id);
CREATE INDEX build_steps_project_idx ON public.build_steps USING btree (project_id, created_at DESC);
ALTER TABLE public."build_steps" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "build_steps_select" ON public."build_steps" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = build_steps.project_id) AND ((p.user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members m
          WHERE ((m.project_id = p.id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.status = 'accepted'::text)))))))));

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

-- ── page_views  (~918 rows, RLS ON) ──────────
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

-- ── profiles  (~6 rows, RLS ON) ──────────
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
  "advanced_mode" boolean DEFAULT false,
  "email" text,
  "show_email" boolean DEFAULT false,
  "banner" text,
  "public_email" text,
  CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT "profiles_pkey" PRIMARY KEY (id),
  CONSTRAINT "profiles_username_key" UNIQUE (username)
);
CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);
CREATE UNIQUE INDEX profiles_username_key ON public.profiles USING btree (username);
ALTER TABLE public."profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_public_read" ON public."profiles" AS PERMISSIVE FOR SELECT TO anon,authenticated USING (true);
CREATE POLICY "profiles_update_own" ON public."profiles" AS PERMISSIVE FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = id)) WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_profiles_public_email BEFORE INSERT OR UPDATE OF email, show_email ON public.profiles FOR EACH ROW EXECUTE FUNCTION profiles_sync_public_email();

-- ── project_artifacts  (~4 rows, RLS ON) ──────────
CREATE TABLE public."project_artifacts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "kind" text NOT NULL,
  "version" integer NOT NULL,
  "data" jsonb NOT NULL,
  "stale" boolean NOT NULL DEFAULT false,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_artifacts_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT "project_artifacts_data_check" CHECK (((jsonb_typeof(data) = 'object'::text) AND (octet_length((data)::text) <= 262144))),
  CONSTRAINT "project_artifacts_kind_check" CHECK ((kind = ANY (ARRAY['plan'::text, 'style_spec'::text, 'manifest'::text, 'launch_checks'::text, 'business_state'::text]))),
  CONSTRAINT "project_artifacts_pkey" PRIMARY KEY (id),
  CONSTRAINT "project_artifacts_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "project_artifacts_version_check" CHECK ((version > 0)),
  CONSTRAINT "project_artifacts_version_key" UNIQUE (project_id, kind, version)
);
CREATE UNIQUE INDEX project_artifacts_pkey ON public.project_artifacts USING btree (id);
CREATE UNIQUE INDEX project_artifacts_version_key ON public.project_artifacts USING btree (project_id, kind, version);
ALTER TABLE public."project_artifacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_artifacts_select" ON public."project_artifacts" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = project_artifacts.project_id) AND ((p.user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members m
          WHERE ((m.project_id = p.id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.status = 'accepted'::text)))))))));

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

-- ── project_deploys  (~0 rows, RLS ON) ──────────
CREATE TABLE public."project_deploys" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'uploading'::text,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "main_file" text NOT NULL DEFAULT 'index.html'::text,
  "file_count" integer NOT NULL DEFAULT 0,
  "total_bytes" bigint NOT NULL DEFAULT 0,
  "backend" jsonb,
  CONSTRAINT "project_deploys_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT "project_deploys_pkey" PRIMARY KEY (id),
  CONSTRAINT "project_deploys_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "project_deploys_project_id_version_key" UNIQUE (project_id, version),
  CONSTRAINT "project_deploys_status_check" CHECK ((status = ANY (ARRAY['uploading'::text, 'ready'::text, 'failed'::text]))),
  CONSTRAINT "project_deploys_version_check" CHECK ((version > 0))
);
CREATE UNIQUE INDEX project_deploys_pkey ON public.project_deploys USING btree (id);
CREATE UNIQUE INDEX project_deploys_project_id_version_key ON public.project_deploys USING btree (project_id, version);
CREATE INDEX project_deploys_project_idx ON public.project_deploys USING btree (project_id, version DESC);
ALTER TABLE public."project_deploys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_deploys_select" ON public."project_deploys" AS PERMISSIVE FOR SELECT TO authenticated USING (((project_id IN ( SELECT p.id
   FROM projects p
  WHERE (p.user_id = auth.uid()))) OR (project_id IN ( SELECT pm.project_id
   FROM project_members pm
  WHERE ((pm.user_id = auth.uid()) AND (pm.status = 'accepted'::text))))));

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

-- ── projects  (~10 rows, RLS ON) ──────────
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
  "published_version" integer,
  "stage" text NOT NULL DEFAULT 'plan'::text,
  CONSTRAINT "projects_pkey" PRIMARY KEY (id),
  CONSTRAINT "projects_stage_check" CHECK ((stage = ANY (ARRAY['plan'::text, 'example'::text, 'build'::text, 'tweaks'::text, 'launch'::text, 'business'::text]))),
  CONSTRAINT "projects_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX projects_custom_domain_uidx ON public.projects USING btree (lower(custom_domain)) WHERE ((custom_domain IS NOT NULL) AND (custom_domain <> ''::text));
CREATE UNIQUE INDEX projects_pkey ON public.projects USING btree (id);
CREATE UNIQUE INDEX projects_published_slug_user_idx ON public.projects USING btree (user_id, published_slug) WHERE (published_slug IS NOT NULL);
ALTER TABLE public."projects" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "projects_delete_owner" ON public."projects" AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY "projects_insert_own" ON public."projects" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "projects_published_anon_read" ON public."projects" AS PERMISSIVE FOR SELECT TO anon USING ((published_slug IS NOT NULL));
CREATE POLICY "projects_select" ON public."projects" AS PERMISSIVE FOR SELECT TO public USING (((user_id = auth.uid()) OR (is_public = true) OR (id IN ( SELECT project_members.project_id
   FROM project_members
  WHERE ((project_members.user_id = auth.uid()) AND (project_members.status = ANY (ARRAY['pending'::text, 'accepted'::text])))))));
CREATE POLICY "projects_update_owner_or_member" ON public."projects" AS PERMISSIVE FOR UPDATE TO authenticated USING (((user_id = auth.uid()) OR (id IN ( SELECT pm.project_id
   FROM project_members pm
  WHERE ((pm.user_id = auth.uid()) AND (pm.status = 'accepted'::text)))))) WITH CHECK (((user_id = auth.uid()) OR (id IN ( SELECT pm.project_id
   FROM project_members pm
  WHERE ((pm.user_id = auth.uid()) AND (pm.status = 'accepted'::text))))));
CREATE TRIGGER projects_guard_hosting_columns BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION projects_guard_hosting_columns();
CREATE TRIGGER projects_guard_owner BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION projects_guard_owner();
CREATE TRIGGER projects_guard_stage BEFORE INSERT OR UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION projects_guard_stage();
CREATE TRIGGER set_projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── rate_limits  (~41 rows, RLS ON) ──────────
CREATE TABLE public."rate_limits" (
  "key" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "hits" integer NOT NULL DEFAULT 0,
  CONSTRAINT "rate_limits_pkey" PRIMARY KEY (key, window_start)
);
CREATE UNIQUE INDEX rate_limits_pkey ON public.rate_limits USING btree (key, window_start);
ALTER TABLE public."rate_limits" ENABLE ROW LEVEL SECURITY;

-- ── site_data  (~1 rows, RLS ON) ──────────
CREATE TABLE public."site_data" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "collection" text NOT NULL DEFAULT 'default'::text,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "site_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "site_data_collection_chk" CHECK ((collection ~ '^[a-z0-9_-]{1,40}$'::text)),
  CONSTRAINT "site_data_pkey" PRIMARY KEY (id),
  CONSTRAINT "site_data_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "site_data_site_user_id_fkey" FOREIGN KEY (site_user_id) REFERENCES site_users(id) ON DELETE SET NULL,
  CONSTRAINT "site_data_size_chk" CHECK ((octet_length((data)::text) <= 16384))
);
CREATE UNIQUE INDEX site_data_pkey ON public.site_data USING btree (id);
CREATE INDEX site_data_project_collection_idx ON public.site_data USING btree (project_id, collection, created_at DESC);
CREATE INDEX site_data_user_idx ON public.site_data USING btree (project_id, collection, site_user_id, created_at DESC);
ALTER TABLE public."site_data" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners can delete their site data" ON public."site_data" AS PERMISSIVE FOR DELETE TO public USING ((project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid()))));
CREATE POLICY "owners can read their site data" ON public."site_data" AS PERMISSIVE FOR SELECT TO public USING ((project_id IN ( SELECT projects.id
   FROM projects
  WHERE (projects.user_id = auth.uid()))));

-- ── site_sessions  (~0 rows, RLS ON) ──────────
CREATE TABLE public."site_sessions" (
  "token_hash" text NOT NULL,
  "project_id" text NOT NULL,
  "site_user_id" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "site_sessions_pkey" PRIMARY KEY (token_hash),
  CONSTRAINT "site_sessions_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "site_sessions_site_user_id_fkey" FOREIGN KEY (site_user_id) REFERENCES site_users(id) ON DELETE CASCADE
);
CREATE INDEX site_sessions_expires_idx ON public.site_sessions USING btree (expires_at);
CREATE UNIQUE INDEX site_sessions_pkey ON public.site_sessions USING btree (token_hash);
CREATE INDEX site_sessions_user_idx ON public.site_sessions USING btree (site_user_id);
ALTER TABLE public."site_sessions" ENABLE ROW LEVEL SECURITY;

-- ── site_snapshots  (~0 rows, RLS ON) ──────────
CREATE TABLE public."site_snapshots" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "files" jsonb NOT NULL,
  "is_current" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "site_snapshots_files_check" CHECK ((jsonb_typeof(files) = 'object'::text)),
  CONSTRAINT "site_snapshots_kind_check" CHECK ((kind = ANY (ARRAY['stage'::text, 'tweak'::text, 'baseline'::text]))),
  CONSTRAINT "site_snapshots_label_check" CHECK (((char_length(label) >= 1) AND (char_length(label) <= 200))),
  CONSTRAINT "site_snapshots_pkey" PRIMARY KEY (id),
  CONSTRAINT "site_snapshots_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "site_snapshots_project_seq_key" UNIQUE (project_id, seq),
  CONSTRAINT "site_snapshots_seq_check" CHECK ((seq > 0))
);
CREATE UNIQUE INDEX site_snapshots_current_idx ON public.site_snapshots USING btree (project_id) WHERE is_current;
CREATE UNIQUE INDEX site_snapshots_pkey ON public.site_snapshots USING btree (id);
CREATE UNIQUE INDEX site_snapshots_project_seq_key ON public.site_snapshots USING btree (project_id, seq);
ALTER TABLE public."site_snapshots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "site_snapshots_select" ON public."site_snapshots" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = site_snapshots.project_id) AND ((p.user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members m
          WHERE ((m.project_id = p.id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.status = 'accepted'::text)))))))));

-- ── site_users  (~0 rows, RLS ON) ──────────
CREATE TABLE public."site_users" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "site_users_email_chk" CHECK (((email = lower(email)) AND ((char_length(email) >= 3) AND (char_length(email) <= 254)))),
  CONSTRAINT "site_users_metadata_chk" CHECK (((metadata IS NULL) OR (octet_length((metadata)::text) <= 4096))),
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

-- ── stage_messages  (~0 rows, RLS ON) ──────────
CREATE TABLE public."stage_messages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "project_id" text NOT NULL,
  "stage" text NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "user_id" uuid,
  "job_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stage_messages_content_check" CHECK (((char_length(content) >= 1) AND (char_length(content) <= 20000))),
  CONSTRAINT "stage_messages_job_id_fkey" FOREIGN KEY (job_id) REFERENCES build_jobs(id) ON DELETE SET NULL,
  CONSTRAINT "stage_messages_pkey" PRIMARY KEY (id),
  CONSTRAINT "stage_messages_project_id_fkey" FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT "stage_messages_role_check" CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
  CONSTRAINT "stage_messages_stage_check" CHECK ((stage = ANY (ARRAY['plan'::text, 'example'::text, 'build'::text, 'tweaks'::text, 'launch'::text, 'business'::text]))),
  CONSTRAINT "stage_messages_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX stage_messages_chat_idx ON public.stage_messages USING btree (project_id, stage, created_at);
CREATE UNIQUE INDEX stage_messages_job_role_uidx ON public.stage_messages USING btree (job_id, role) WHERE (job_id IS NOT NULL);
CREATE UNIQUE INDEX stage_messages_pkey ON public.stage_messages USING btree (id);
ALTER TABLE public."stage_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stage_messages_select" ON public."stage_messages" AS PERMISSIVE FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = stage_messages.project_id) AND ((p.user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM project_members m
          WHERE ((m.project_id = p.id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.status = 'accepted'::text)))))))));

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

-- commit_site_build  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.commit_site_build(p_project text, p_files jsonb, p_remove jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  k       text;
  v       jsonb;
  n       integer := 0;
  total   bigint  := 0;
  gone    text[]  := '{}';
BEGIN
  -- true = platform (service role / postgres). A signed-in user gets false (or an error for a stranger) and is refused below.
  IF NOT public.vx_stage_access(p_project) THEN
    RAISE EXCEPTION 'commit_site_build is for the platform only' USING ERRCODE = '42501';
  END IF;
  IF p_files IS NULL OR jsonb_typeof(p_files) <> 'object' THEN
    RAISE EXCEPTION 'files must be a JSON object of name -> text' USING ERRCODE = '22023';
  END IF;
  IF p_remove IS NULL OR jsonb_typeof(p_remove) <> 'array' THEN
    RAISE EXCEPTION 'remove must be a JSON array of file names' USING ERRCODE = '22023';
  END IF;

  FOR k, v IN SELECT key, value FROM jsonb_each(p_files) LOOP
    n := n + 1;
    IF k !~ '^([A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|css|js|json)|_backend)$' THEN
      RAISE EXCEPTION 'file name not allowed: %', left(k, 80) USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v) <> 'string' THEN
      RAISE EXCEPTION 'file % must be text', k USING ERRCODE = '22023';
    END IF;
    IF length(v #>> '{}') > 600000 THEN
      RAISE EXCEPTION 'file % is too large', k USING ERRCODE = '54000';
    END IF;
    total := total + length(v #>> '{}');
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'nothing to commit' USING ERRCODE = '22023'; END IF;
  IF n > 80 OR total > 6000000 THEN
    RAISE EXCEPTION 'too many or too large files in one build' USING ERRCODE = '54000';
  END IF;

  -- Only plain pages can be removed, and never one this same build writes.
  FOR k IN SELECT jsonb_array_elements_text(p_remove) LOOP
    IF k !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html$' THEN
      RAISE EXCEPTION 'only pages can be removed: %', left(k, 80) USING ERRCODE = '22023';
    END IF;
    IF NOT (p_files ? k) THEN gone := gone || k; END IF;
  END LOOP;
  IF coalesce(array_length(gone, 1), 0) > 80 THEN
    RAISE EXCEPTION 'too many files to remove' USING ERRCODE = '54000';
  END IF;

  -- One UPDATE = one atomic step: the stale pages go and the new files arrive together; everything else (images, memory files) stays.
  UPDATE public.projects SET files = (coalesce(files, '{}'::jsonb) - gone) || p_files WHERE id = p_project;
  RETURN jsonb_build_object(
    'saved',   (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb) FROM jsonb_object_keys(p_files) AS key),
    'removed', to_jsonb(gone)
  );
END $function$;

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
 SET search_path TO 'public'
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
 SET search_path TO 'public'
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
 SET search_path TO 'public'
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
 SET search_path TO 'public'
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
 SET search_path TO 'public'
AS $function$
  select id from public.profiles where lower(username) = lower(uname) limit 1;
$function$;

-- handle_follow_delete  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.handle_follow_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
 SET search_path TO 'public'
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
 SET search_path TO 'public'
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
 SET search_path TO 'public'
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

-- increment_usage  [SECURITY DEFINER]
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

-- is_following  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.is_following(follower uuid, following uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.follows where follower_id = follower and following_id = following);
$function$;

-- is_project_member  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.is_project_member(p_project_id text, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.projects where id = p_project_id and user_id = p_user_id
  );
$function$;

-- keep_project_artifact  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.keep_project_artifact(p_project text, p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rules   jsonb := public.vx_stage_rules();
  trusted boolean;
  latest  integer;
  cleared boolean := false;
BEGIN
  trusted := public.vx_stage_access(p_project);
  IF p_kind IS NULL OR NOT ((rules -> 'kinds') ? p_kind) THEN
    RAISE EXCEPTION 'unknown artifact kind: %', coalesce(p_kind, '(null)') USING ERRCODE = '22023';
  END IF;
  IF NOT trusted AND NOT ((rules -> 'client_keepable') ? p_kind) THEN
    RAISE EXCEPTION 'artifact kind % must be regenerated by the platform', p_kind USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vx_artifacts:' || p_project, 0));

  SELECT max(version) INTO latest FROM public.project_artifacts WHERE project_id = p_project AND kind = p_kind;
  IF latest IS NOT NULL THEN
    UPDATE public.project_artifacts SET stale = false
     WHERE project_id = p_project AND kind = p_kind AND version = latest AND stale;
    cleared := FOUND;
  END IF;
  RETURN jsonb_build_object('kind', p_kind, 'version', latest, 'cleared', cleared);
END $function$;

-- move_site_history  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.move_site_history(p_project text, p_action text, p_seq integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cur     public.site_snapshots%ROWTYPE;
  target  public.site_snapshots%ROWTYPE;
  keys    text[];
BEGIN
  IF NOT public.vx_stage_access(p_project) THEN
    RAISE EXCEPTION 'move_site_history is for the platform only' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('undo', 'redo', 'restore') THEN
    RAISE EXCEPTION 'unknown action' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vx_site_history:' || p_project, 0));

  SELECT * INTO cur FROM public.site_snapshots WHERE project_id = p_project AND is_current;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('moved', false, 'reason', 'no_history');
  END IF;

  IF p_action = 'undo' THEN
    SELECT * INTO target FROM public.site_snapshots WHERE project_id = p_project AND seq < cur.seq ORDER BY seq DESC LIMIT 1;
  ELSIF p_action = 'redo' THEN
    SELECT * INTO target FROM public.site_snapshots WHERE project_id = p_project AND seq > cur.seq ORDER BY seq ASC LIMIT 1;
  ELSE
    IF p_seq IS NULL THEN RAISE EXCEPTION 'restore needs a checkpoint' USING ERRCODE = '22023'; END IF;
    SELECT * INTO target FROM public.site_snapshots WHERE project_id = p_project AND seq = p_seq;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('moved', false, 'reason', CASE p_action WHEN 'restore' THEN 'not_found' ELSE 'nothing_to_' || p_action END);
  END IF;
  IF target.id = cur.id THEN
    RETURN jsonb_build_object('moved', false, 'reason', 'already_here', 'seq', cur.seq);
  END IF;

  SELECT coalesce(array_agg(k), '{}') INTO keys
    FROM jsonb_object_keys(public.vx_site_text_files((SELECT files FROM public.projects WHERE id = p_project))) AS k;
  UPDATE public.projects SET files = (coalesce(files, '{}'::jsonb) - keys) || target.files WHERE id = p_project;

  UPDATE public.site_snapshots SET is_current = false WHERE id = cur.id;
  UPDATE public.site_snapshots SET is_current = true WHERE id = target.id;
  RETURN jsonb_build_object('moved', true, 'seq', target.seq, 'label', target.label, 'kind', target.kind);
END $function$;

-- profiles_sync_public_email
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

-- projects_guard_hosting_columns
CREATE OR REPLACE FUNCTION public.projects_guard_hosting_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
END $function$;

-- projects_guard_owner
CREATE OR REPLACE FUNCTION public.projects_guard_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id AND coalesce(auth.role(), 'postgres') IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'project ownership cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

-- projects_guard_stage
CREATE OR REPLACE FUNCTION public.projects_guard_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' AND NEW.stage IS DISTINCT FROM 'plan' THEN
      RAISE EXCEPTION 'a new project starts at the plan stage' USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE' AND NEW.stage IS DISTINCT FROM OLD.stage THEN
      RAISE EXCEPTION 'the project stage is changed with set_project_stage()' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- put_project_artifact  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.put_project_artifact(p_project text, p_kind text, p_data jsonb, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  rules   jsonb := public.vx_stage_rules();
  trusted boolean;
  cur     integer;
  v       integer;
  staled  text[];
BEGIN
  trusted := public.vx_stage_access(p_project);
  IF p_kind IS NULL OR NOT ((rules -> 'kinds') ? p_kind) THEN
    RAISE EXCEPTION 'unknown artifact kind: %', coalesce(p_kind, '(null)') USING ERRCODE = '22023';
  END IF;
  IF NOT trusted AND NOT ((rules -> 'client_writable') ? p_kind) THEN
    RAISE EXCEPTION 'artifact kind % is written by the platform', p_kind USING ERRCODE = '42501';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'artifact data must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_data::text) > (rules ->> 'max_bytes')::integer THEN
    RAISE EXCEPTION 'artifact is too large (max % bytes)', rules ->> 'max_bytes' USING ERRCODE = '54000';
  END IF;

  -- One writer per project at a time: version numbers and stale flags stay consistent.
  PERFORM pg_advisory_xact_lock(hashtextextended('vx_artifacts:' || p_project, 0));

  SELECT coalesce(max(version), 0) INTO cur FROM public.project_artifacts WHERE project_id = p_project AND kind = p_kind;
  IF p_expected_version IS NOT NULL AND p_expected_version <> cur THEN
    RAISE EXCEPTION 'version conflict: % is at version % (expected %)', p_kind, cur, p_expected_version USING ERRCODE = 'PT409';
  END IF;
  v := cur + 1;

  INSERT INTO public.project_artifacts (project_id, kind, version, data, created_by)
  VALUES (p_project, p_kind, v, p_data, CASE WHEN trusted THEN NULL ELSE auth.uid() END);

  WITH latest AS (
    SELECT DISTINCT ON (a.kind) a.id, a.kind, a.stale
      FROM public.project_artifacts a
     WHERE a.project_id = p_project
       AND a.kind IN (SELECT jsonb_array_elements_text(rules -> 'downstream' -> p_kind))
     ORDER BY a.kind, a.version DESC
  ), flagged AS (
    UPDATE public.project_artifacts a SET stale = true
      FROM latest l WHERE a.id = l.id AND NOT l.stale
    RETURNING a.kind
  )
  SELECT coalesce(array_agg(kind ORDER BY kind), '{}') INTO staled FROM flagged;

  DELETE FROM public.project_artifacts
   WHERE project_id = p_project AND kind = p_kind AND version <= v - (rules ->> 'max_versions')::integer;

  RETURN jsonb_build_object('kind', p_kind, 'version', v, 'staled', to_jsonb(staled));
END $function$;

-- resolve_published_site  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.resolve_published_site(p_username text DEFAULT NULL::text, p_slug text DEFAULT NULL::text, p_host text DEFAULT NULL::text)
 RETURNS TABLE(project_id text, version integer, main_file text, legacy boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- set_project_files  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.set_project_files(p_project text, p_files jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  k     text;
  v     jsonb;
  n     integer := 0;
  total integer := 0;
BEGIN
  PERFORM public.vx_stage_access(p_project);
  IF p_files IS NULL OR jsonb_typeof(p_files) <> 'object' THEN
    RAISE EXCEPTION 'files must be a JSON object of name -> text' USING ERRCODE = '22023';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(p_files) LOOP
    n := n + 1;
    IF k !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|css|js|json)$' THEN
      RAISE EXCEPTION 'file name not allowed: %', left(k, 80) USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v) <> 'string' THEN
      RAISE EXCEPTION 'file % must be text', k USING ERRCODE = '22023';
    END IF;
    IF length(v #>> '{}') > 600000 THEN
      RAISE EXCEPTION 'file % is too large', k USING ERRCODE = '54000';
    END IF;
    total := total + length(v #>> '{}');
  END LOOP;
  IF n = 0 THEN RETURN jsonb_build_object('saved', '[]'::jsonb); END IF;
  IF n > 20 OR total > 1500000 THEN
    RAISE EXCEPTION 'too many or too large files in one call' USING ERRCODE = '54000';
  END IF;

  -- `||` replaces the given keys and keeps every other file as it is; one UPDATE = atomic per row.
  UPDATE public.projects SET files = coalesce(files, '{}'::jsonb) || p_files WHERE id = p_project;
  RETURN jsonb_build_object('saved', (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb) FROM jsonb_object_keys(p_files) AS key));
END $function$;

-- set_project_stage  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.set_project_stage(p_project text, p_stage text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cur     text;
  blocked jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.vx_stage_access(p_project);
  IF public.vx_stage_rank(p_stage) IS NULL THEN
    RAISE EXCEPTION 'unknown stage: %', coalesce(p_stage, '(null)') USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vx_artifacts:' || p_project, 0));

  SELECT stage INTO cur FROM public.projects WHERE id = p_project;
  IF public.vx_stage_rank(p_stage) > public.vx_stage_rank(cur) THEN
    blocked := public.vx_stage_blockers(p_project, p_stage);
  END IF;
  IF jsonb_array_length(blocked) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'stage', cur, 'blocked_by', blocked);
  END IF;

  IF cur IS DISTINCT FROM p_stage THEN
    UPDATE public.projects SET stage = p_stage WHERE id = p_project;
  END IF;
  RETURN jsonb_build_object('ok', true, 'stage', p_stage, 'blocked_by', '[]'::jsonb);
END $function$;

-- set_updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin new.updated_at = now(); return new; end; $function$;

-- take_site_snapshot  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.take_site_snapshot(p_project text, p_kind text, p_label text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cur     public.site_snapshots%ROWTYPE;
  now_f   jsonb;
  next_n  integer;
  have    boolean;
BEGIN
  IF NOT public.vx_stage_access(p_project) THEN
    RAISE EXCEPTION 'take_site_snapshot is for the platform only' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('stage', 'tweak', 'baseline') THEN
    RAISE EXCEPTION 'unknown checkpoint kind' USING ERRCODE = '22023';
  END IF;
  IF p_label IS NULL OR char_length(btrim(p_label)) = 0 THEN
    RAISE EXCEPTION 'a checkpoint needs a label' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('vx_site_history:' || p_project, 0));

  SELECT public.vx_site_text_files(files) INTO now_f FROM public.projects WHERE id = p_project;
  SELECT * INTO cur FROM public.site_snapshots WHERE project_id = p_project AND is_current;
  have := FOUND;
  IF have AND cur.files = now_f THEN
    RETURN jsonb_build_object('seq', cur.seq, 'created', false);
  END IF;

  -- A new change made from an earlier point: the checkpoints after "you are here" are the redo branch, and they go.
  IF have THEN
    DELETE FROM public.site_snapshots WHERE project_id = p_project AND seq > cur.seq;
    UPDATE public.site_snapshots SET is_current = false WHERE id = cur.id;
    next_n := cur.seq + 1;
  ELSE
    SELECT coalesce(max(seq), 0) + 1 INTO next_n FROM public.site_snapshots WHERE project_id = p_project;
  END IF;

  INSERT INTO public.site_snapshots (project_id, seq, kind, label, files, is_current)
  VALUES (p_project, next_n, p_kind, left(btrim(p_label), 200), now_f, true);

  DELETE FROM public.site_snapshots WHERE project_id = p_project AND seq <= next_n - 40;
  RETURN jsonb_build_object('seq', next_n, 'created', true);
END $function$;

-- vexium_site_query  [SECURITY DEFINER]
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

-- vx_business_stats  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.vx_business_stats(p_project text, p_days integer DEFAULT 30, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- vx_rate_hit  [SECURITY DEFINER]
CREATE OR REPLACE FUNCTION public.vx_rate_hit(p_key text, p_window_seconds integer, p_limit integer, p_cost integer DEFAULT 1)
 RETURNS TABLE(allowed boolean, hits integer, retry_after integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- vx_site_text_files
CREATE OR REPLACE FUNCTION public.vx_site_text_files(p_files jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(coalesce(p_files, '{}'::jsonb))
   WHERE key ~ '^([A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(html|css|js|json)|_backend)$' AND jsonb_typeof(value) = 'string';
$function$;

-- vx_stage_access
CREATE OR REPLACE FUNCTION public.vx_stage_access(p_project text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  r   text := coalesce(auth.role(), 'postgres');
  uid uuid := auth.uid();
BEGIN
  IF r IN ('anon', 'authenticated') THEN
    IF uid IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.projects p
       WHERE p.id = p_project
         AND (p.user_id = uid OR EXISTS (
               SELECT 1 FROM public.project_members m
                WHERE m.project_id = p.id AND m.user_id = uid AND m.status = 'accepted'))
    ) THEN
      RAISE EXCEPTION 'project not found or not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project) THEN
    RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN true;
END $function$;

-- vx_stage_blockers
CREATE OR REPLACE FUNCTION public.vx_stage_blockers(p_project text, p_stage text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  rules   jsonb := public.vx_stage_rules();
  result  jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', t.k, 'reason', t.reason) ORDER BY t.ord), '[]'::jsonb)
    INTO result
    FROM (
      SELECT r.k, r.ord,
             CASE
               WHEN a.version IS NULL THEN 'missing'
               WHEN a.stale THEN 'stale'
               WHEN (rules -> 'required_flags' ->> r.k) IS NOT NULL
                    AND coalesce(a.data ->> (rules -> 'required_flags' ->> r.k), '') <> 'true'
                 THEN 'flag:' || (rules -> 'required_flags' ->> r.k)
             END AS reason
        FROM jsonb_array_elements_text(rules -> 'requires' -> p_stage) WITH ORDINALITY AS r(k, ord)
        LEFT JOIN LATERAL (
          SELECT x.version, x.stale, x.data FROM public.project_artifacts x
           WHERE x.project_id = p_project AND x.kind = r.k ORDER BY x.version DESC LIMIT 1
        ) a ON true
    ) t
   WHERE t.reason IS NOT NULL;

  IF (rules -> 'requires_published') ? p_stage
     AND NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project AND published_version IS NOT NULL) THEN
    result := result || jsonb_build_array(jsonb_build_object('kind', 'published', 'reason', 'missing'));
  END IF;
  RETURN result;
END $function$;

-- vx_stage_rank
CREATE OR REPLACE FUNCTION public.vx_stage_rank(p_stage text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT (t.ord - 1)::integer FROM jsonb_array_elements_text(public.vx_stage_rules() -> 'stages') WITH ORDINALITY AS t(v, ord) WHERE t.v = p_stage
$function$;

-- vx_stage_rules
CREATE OR REPLACE FUNCTION public.vx_stage_rules()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT $json$
{
  "stages": ["plan", "example", "build", "tweaks", "launch", "business"],
  "kinds": ["plan", "style_spec", "manifest", "launch_checks", "business_state"],
  "requires": {
    "plan": [],
    "example": ["plan"],
    "build": ["plan", "style_spec"],
    "tweaks": ["plan", "style_spec", "manifest"],
    "launch": ["plan", "style_spec", "manifest", "launch_checks"],
    "business": []
  },
  "requires_published": ["business"],
  "required_flags": { "style_spec": "locked" },
  "downstream": {
    "plan": ["style_spec", "manifest", "launch_checks"],
    "style_spec": ["manifest", "launch_checks"],
    "manifest": ["launch_checks"],
    "launch_checks": [],
    "business_state": []
  },
  "client_writable": ["plan", "style_spec"],
  "client_keepable": ["plan", "style_spec", "manifest"],
  "max_versions": 20,
  "max_bytes": 262144
}
$json$::jsonb $function$;

-- zero_tiny_extra_credits
CREATE OR REPLACE FUNCTION public.zero_tiny_extra_credits()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
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
