// Vertly Publisher (Cloudflare Worker) — serves published sites and runs the publish API.
// ─────────────────────────────────────────────────────────────────────────────
// Serves   username.vexium.ai/<slug>/<page>   (route *.vexium.ai/*)
//          www.customer-domain.com/<page>     (custom domains arrive via the Vercel proxy with x-forwarded-host)
// Files live in R2 (binding SITES) as immutable versions: p/<project_id>/v<n>/<path>. A project's live version is
// projects.published_version; the Worker finds it with one RPC (cached ~10s in the isolate). Sites published before
// v2 (published_version NULL) still render from projects.published_files until their next publish.
//
// Publish API (see publish.ts):  POST /__vx/publish | /__vx/rollback | /__vx/unpublish
//
// Config: publisher/wrangler.toml.  Secret:  SUPABASE_SERVICE_ROLE_KEY
// Deploy: npx wrangler deploy --config publisher/wrangler.toml
// ─────────────────────────────────────────────────────────────────────────────

import { handleApi } from './publish.ts';
import { handleSite } from './serve.ts';
import { notFoundPage } from './html.ts';
import type { Ctx, Env } from './types.ts';

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);

    // Health check — the editor polls this to confirm the Worker is live after a publish.
    if (url.pathname === '/__vexium_ping') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/__vx/')) return handleApi(req, env, ctx);

    try {
      return await handleSite(req, env);
    } catch (e) {
      console.error('[publisher] serve failed', e);
      return notFoundPage('This site is temporarily unavailable. Please try again in a moment.', 503);
    }
  },
};
