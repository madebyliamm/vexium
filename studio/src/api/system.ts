// Zero-cost connectivity checks for the /system page: they prove CORS from the studio origin and that the signed-in
// token is accepted, without starting a build (nothing here calls a model, so nothing is billed).
import { AI_BUILD_URL, AI_EDGE_URL, PUBLISH_API } from '../lib/config.ts';
import { authedFetch, type AuthDeps } from './http.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

async function timed(name: string, run: () => Promise<{ ok: boolean; detail: string }>): Promise<Check> {
  const t0 = performance.now();
  try {
    const { ok, detail } = await run();
    return { name, ok, detail, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) };
  }
}

const preflight = (url: string) => async () => {
  const res = await fetch(url, { method: 'OPTIONS' });
  return { ok: res.status < 400, detail: `OPTIONS → ${res.status}` };
};

export function runChecks(deps: AuthDeps): Promise<Check[]> {
  return Promise.all([
    timed('Build Worker reachable (CORS)', preflight(AI_BUILD_URL)),
    timed('Publisher reachable (CORS)', preflight(PUBLISH_API + '/publish')),
    timed('ai-chat reachable (CORS)', preflight(AI_EDGE_URL)),
    // ai-chat verifies the token BEFORE parsing the body: a non-JSON body answers 400 for a valid user and 401 otherwise.
    timed('ai-chat accepts your session', async () => {
      const res = await authedFetch(AI_EDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' }, deps);
      return { ok: res.status === 400, detail: `POST (invalid body) → ${res.status}${res.status === 401 ? ' — session rejected' : ''}` };
    }),
  ]);
}
