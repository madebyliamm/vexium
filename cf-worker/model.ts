// One FULL BUILD model call (REVAMP Step 10): send a page's instructions to Anthropic, read the stream with the same parser as every other
// build (core.ts), and return the files it wrote. Expected failures never throw — they come back classified so the build flow can decide
// whether to retry the page, wait, or stop the whole build. Pure of Cloudflare APIs: `doFetch` is injected so Node tests run it against a
// fake stream.

import { streamBuild } from './core.ts';
import type { ModelRequest, ModelResult, Usage } from './build-flow.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export interface ModelEnv {
  ANTHROPIC_API_KEY: string;
  /** Test hook: a stand-in for api.anthropic.com (used by the mock-Anthropic live test). Unset in production. */
  ANTHROPIC_BASE_URL?: string;
}

const decode = (b64: string): string => {
  try { return decodeURIComponent(escape(atob(b64))); } catch { return atob(b64); }
};

/** Words the user can be shown. Never the provider's raw error text (it can name keys, accounts or limits). */
export function classifyHttpError(status: number, text: string): Pick<ModelResult, 'error' | 'busy' | 'fatal'> {
  if (status === 401 || status === 403) return { error: 'The AI service is not available right now. Please try again later.', fatal: true };
  if (status === 402 || (status === 400 && /credit balance|billing/i.test(text))) return { error: 'The AI service is out of credit right now. Please try again later.', fatal: true };
  if (status === 429 || status === 529 || status >= 500) return { error: 'The AI service is busy.', busy: true };
  return { error: 'The AI service had a problem with this page.' };
}

export async function callModel(
  env: ModelEnv,
  req: ModelRequest,
  signal: AbortSignal,
  doFetch: typeof fetch = fetch,
  usageOut: Usage = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 },
): Promise<ModelResult> {
  const stopped = (): ModelResult => ({ files: {}, usage: { ...usageOut }, stopped: true });
  let res: Response;
  try {
    res = await doFetch(env.ANTHROPIC_BASE_URL ? `${env.ANTHROPIC_BASE_URL.replace(/\/+$/, '')}/v1/messages` : ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31,output-128k-2025-02-19',
      },
      // The same system block for every page of the build, so the second page onward reads it from the prompt cache.
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.max_tokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.prompt }],
        stream: true,
      }),
      signal,
    });
  } catch {
    return signal.aborted ? stopped() : { files: {}, usage: { ...usageOut }, error: 'The AI service could not be reached.', busy: true };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { files: {}, usage: { ...usageOut }, ...classifyHttpError(res.status, text) };
  }

  let streamError: string | null = null;
  let finished = false;
  const partial: Record<string, string> = {};
  const emit = async (event: string, data: unknown): Promise<void> => {
    const d = (data ?? {}) as Record<string, unknown>;
    if (event === 'done') finished = true;
    else if (event === 'error') streamError = 'The AI stopped before finishing.';
    else if (event === 'partial_file' && typeof d.name === 'string' && typeof d.content === 'string') partial[d.name] = decode(d.content);
  };

  let result: Awaited<ReturnType<typeof streamBuild>>;
  try {
    result = await streamBuild(res, {}, emit, usageOut, signal);
  } catch {
    return signal.aborted ? stopped() : { files: {}, usage: { ...usageOut }, error: 'The AI stopped before finishing.', busy: true };
  }
  const usage: Usage = { in: result.tokensIn, out: result.tokensOut, cacheWrite: result.tokensCacheWrite, cacheRead: result.tokensCacheRead };
  if (signal.aborted) return { files: {}, usage, stopped: true };

  // A page the AI was still writing when the reply ended (it ran out of room, or the connection dropped) is handed over as it is: the
  // launch check sees it is cut off and the repair round writes a shorter one. Only a name that did not also complete is taken.
  const files = { ...result.files };
  for (const [name, text] of Object.entries(partial)) if (!(name in files)) files[name] = text;

  if (Object.keys(files).length === 0) {
    return { files, usage, error: streamError ?? (finished ? 'The AI replied without writing the page.' : 'The AI stopped before finishing.'), busy: !finished };
  }
  return { files, usage };
}
