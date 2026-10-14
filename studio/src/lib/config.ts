// The ONE place the studio learns where things live. Public values only (the anon key is public by design; RLS and
// in-function auth do the securing). The anon key must equal config.js and the two wrangler.toml files —
// test/config.test.ts fails if they drift (a stale key once broke login for days).

export const SUPABASE_URL = 'https://ciuqhxrxcznmgorjeumz.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpdXFoeHJ4Y3pubWdvcmpldW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NDYxODUsImV4cCI6MjA4ODMyMjE4NX0.54fc-rv6tLCE-6BM6eFFy3HjPcPnus69NckKjIKNJCY';

/** Supabase edge function that owns every prompt (spec/brief/prepare/suggest modes). */
export const AI_EDGE_URL = `${SUPABASE_URL}/functions/v1/ai-chat`;
/** Cloudflare Worker that runs the long streaming builds with no wall-clock limit. */
export const AI_BUILD_URL = 'https://vexium-ai-build.startafter.workers.dev';
/** Cloudflare Worker (Hosting v2): POST {publish,rollback,unpublish}. */
export const PUBLISH_API = 'https://vexium-publisher.startafter.workers.dev/__vx';

/** Where the studio is mounted. Must equal `base` in vite.config.ts. */
export const STUDIO_PATH = '/studio/';

/** Legacy pages the studio links to. Absolute paths: they live next to /studio/ on the same origin. */
export const LEGACY = {
  signIn: '/auth.html',
  home: '/home.html',
  landing: '/index.html',
  settings: '/settings.html',
  editor: (projectId: string) => `/editor.html?project=${encodeURIComponent(projectId)}`,
} as const;
