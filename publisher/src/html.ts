import { sdkSnippet } from './sdk.ts';

const SUPABASE_FUNCTIONS = 'https://ciuqhxrxcznmgorjeumz.supabase.co/functions/v1';

/** Bump when the tracking snippet changes: it is part of every HTML ETag so browsers re-fetch. */
export const TRACKER_VERSION = 1;

// Page-view collector for published sites (`track` edge function). Injected at serve time so tracking changes
// reach every live site without a republish.
export function trackerSnippet(projectId: string): string {
  return `<script>(function(){try{var sid=sessionStorage.getItem('_vsid')||Math.random().toString(36).slice(2);sessionStorage.setItem('_vsid',sid);var vid=localStorage.getItem('_vvid')||Math.random().toString(36).slice(2);localStorage.setItem('_vvid',vid);fetch('${SUPABASE_FUNCTIONS}/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:${JSON.stringify(projectId)},page:location.pathname,referrer:document.referrer,session_id:sid,visitor_id:vid})}).catch(function(){});}catch(e){}})()</script>`;
}

/**
 * Per-request HTML changes: substitute the project-id placeholder, add <base> when the site lives under /slug/,
 * append the SDK + tracker. Everything else is served exactly as published.
 */
export function prepareHtml(html: string, opts: { projectId: string; baseHref: string }): string {
  let out = html.split('{{VEXIUM_PROJECT_ID}}').join(opts.projectId);

  // Relative links (href="schedule.html") must resolve under /slug/ on *.vexium.ai; custom domains are at the root.
  if (opts.baseHref && opts.baseHref !== '/') {
    const baseTag = `<base href="${opts.baseHref}">`;
    out = /<head[^>]*>/i.test(out) ? out.replace(/(<head[^>]*>)/i, `$1${baseTag}`) : baseTag + out;
  }

  const tracker = sdkSnippet(opts.projectId) + trackerSnippet(opts.projectId);
  const close = out.toLowerCase().lastIndexOf('</body>');
  return close >= 0 ? out.slice(0, close) + tracker + out.slice(close) : out + tracker;
}

/** Small stable string hash (FNV-1a) used to vary ETags by base path. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function notFoundPage(msg: string, status = 404): Response {
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Not found — Vertly</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#faf9ff;color:#1a1033;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px}
h1{font-size:18px;font-weight:700}p{font-size:13px;color:#6b6585}
a{color:#fff;font-size:13px;font-weight:600;text-decoration:none;margin-top:8px;padding:8px 20px;background:#6d28d9;border-radius:8px}</style></head>
<body><h1>Page not found</h1><p>${msg.replace(/[<>&]/g, '')}</p><a href="https://vexium.ai">Back to Vertly</a></body></html>`;
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
