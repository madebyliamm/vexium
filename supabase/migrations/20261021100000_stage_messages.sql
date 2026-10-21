-- REVAMP Step 8 — stage_messages: the chat of each guided stage, kept per project so a refresh (or another device) restores it.
--
-- Why not `ai_messages`? The legacy editor loads EVERY ai_messages row of a project into its chat (and subscribes to inserts), so
-- PLAN-stage conversation would leak into the old editor's chat and into the history it replays to the model. A separate table
-- keeps the two flows apart.
--
-- Written ONLY by the platform (ai-chat, service role): the user's message when a run is prepared, the assistant's reply (with the
-- artifact block already stripped) when the build Worker reports the run finished. Clients can read, never write — a client must
-- not be able to plant "assistant" lines that later get replayed to the model as history.
--
--   stage_messages(project_id, stage, role, content, user_id (author of a user line, NULL = assistant), job_id (the run), created_at)
--
-- Apply:   supabase db query --linked -f supabase/migrations/20261021100000_stage_messages.sql
-- Verify:  supabase db query --linked -f supabase/tests/step8_stage_messages.sql        (always rolls back)

BEGIN;

CREATE TABLE IF NOT EXISTS public.stage_messages (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  project_id  text        NOT NULL,
  stage       text        NOT NULL,
  role        text        NOT NULL,
  content     text        NOT NULL,
  user_id     uuid,
  job_id      uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_messages_pkey PRIMARY KEY (id),
  CONSTRAINT stage_messages_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects (id) ON DELETE CASCADE,
  CONSTRAINT stage_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT stage_messages_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.build_jobs (id) ON DELETE SET NULL,
  CONSTRAINT stage_messages_stage_check CHECK (stage IN ('plan', 'example', 'build', 'tweaks', 'launch', 'business')),
  CONSTRAINT stage_messages_role_check CHECK (role IN ('user', 'assistant')),
  CONSTRAINT stage_messages_content_check CHECK (char_length(content) BETWEEN 1 AND 20000)
);

-- The chat of one stage, oldest first.
CREATE INDEX IF NOT EXISTS stage_messages_chat_idx ON public.stage_messages (project_id, stage, created_at);
-- A run writes at most one line of each role (a retried report can't double the assistant's reply).
CREATE UNIQUE INDEX IF NOT EXISTS stage_messages_job_role_uidx ON public.stage_messages (job_id, role) WHERE job_id IS NOT NULL;

ALTER TABLE public.stage_messages ENABLE ROW LEVEL SECURITY;

-- Read: the owner and ACCEPTED collaborators (same rule as project_artifacts). No INSERT/UPDATE/DELETE policy exists on purpose.
DROP POLICY IF EXISTS stage_messages_select ON public.stage_messages;
CREATE POLICY stage_messages_select ON public.stage_messages AS PERMISSIVE FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.projects p
     WHERE p.id = stage_messages.project_id
       AND (p.user_id = (SELECT auth.uid()) OR EXISTS (
             SELECT 1 FROM public.project_members m
              WHERE m.project_id = p.id AND m.user_id = (SELECT auth.uid()) AND m.status = 'accepted'))
  ));

-- Supabase's default privileges hand new tables to anon/authenticated in full; take everything back, then grant the one thing.
REVOKE ALL ON public.stage_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stage_messages TO authenticated;
GRANT ALL ON public.stage_messages TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
