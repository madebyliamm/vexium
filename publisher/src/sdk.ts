import { SDK_V1_HASH, SDK_V1_SOURCE } from './sdk.generated.ts';

export const SDK_PATH = '/__vx/sdk/v1.js';
/** Part of every HTML ETag: a new SDK build makes browsers re-fetch pages (which then reference the new ?v= URL). */
export const SDK_HASH = SDK_V1_HASH;

/** `<script>` tags added to every published page: tell the SDK which site this is, then load it. */
export function sdkSnippet(projectId: string): string {
  return `<script>window.__VX={site:${JSON.stringify(projectId)}}</script><script src="${SDK_PATH}?v=${SDK_HASH}"></script>`;
}

/**
 * GET /__vx/sdk/v1.js. The page references it as `?v=<hash>` — that exact URL never changes content, so it is cached
 * for a year; a bare URL (or a stale hash) gets a short cache so a new build reaches everyone within minutes.
 */
export function serveSdk(req: Request): Response {
  const url = new URL(req.url);
  const headers = new Headers({
    'Content-Type': 'application/javascript; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ETag: `"${SDK_HASH}"`,
    'Cache-Control': url.searchParams.get('v') === SDK_HASH
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300, stale-while-revalidate=86400',
  });
  const inm = req.headers.get('if-none-match');
  if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === `"${SDK_HASH}"`)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Length', String(new TextEncoder().encode(SDK_V1_SOURCE).length));
  return new Response(req.method === 'HEAD' ? null : SDK_V1_SOURCE, { status: 200, headers });
}
