// A stand-in for Anthropic's /v1/messages, for testing the FULL BUILD Workflow end to end without spending model credits.
// Deployed on its own (cf-worker/mock/wrangler.toml), pointed at by the build Worker's ANTHROPIC_BASE_URL var, and removed afterwards
// (docs/INFRA.md "Testing the build without credit"). It reads the page assignment the build prompts give (`PAGE TO BUILD: …`, the forms,
// products and sign-in forms the page hosts) and answers with a small but complete page in the real reply format, streamed like the API.
// The owner's note steers it: `mock-slow` makes every page take ~40 s (so a test can press Stop mid-build), `mock-credit` answers
// like an account that is out of credit (HTTP 402). `mock-flaw` in a page's purpose: see pageFor.
// What it proves is the plumbing — Workflow steps, ai-chat operations, verifier, repair loop, atomic save — NOT the quality of a model's pages.

interface Msg { role: string; content: unknown }

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const flat = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : '');

export function pageFor(system: string, prompt: string): { file: string; html: string } | null {
  const file = /PAGE TO BUILD: (\S+)/.exec(prompt)?.[1];
  if (!file) return null;
  const title = /\nTitle: ([^\n]+)/.exec(prompt)?.[1]?.trim() ?? file;
  const purpose = /\nPurpose: ([^\n]+)/.exec(prompt)?.[1]?.trim() ?? '';
  const html = (prompt.match(/data-vx-skip-if-auth="([^"]+)"/) ? ` data-vx-skip-if-auth="${/data-vx-skip-if-auth="([^"]+)"/.exec(prompt)![1]}"` : '')
    + (/This site is an app: every page except/.test(prompt) ? ` data-vx-require-auth="${/data-vx-require-auth="([^"]+)"/.exec(prompt)?.[1] ?? 'login.html'}"` : '');
  const parts: string[] = [];
  for (const m of prompt.matchAll(/FORM "([^"]+)" lives on this page/g)) {
    parts.push(`<form data-vx-form="${m[1]}" data-vx-success="Thanks, we will be in touch."><label>Your email <input type="email" name="email" required></label><label>Your message <textarea name="message" required></textarea></label><button type="submit">Send</button><p data-vx-message></p></form>`);
  }
  for (const m of prompt.matchAll(/- id "([^"]+)": (.+?) — (\$[\d.,]+), one time/g)) {
    parts.push(`<article><h2>${esc(m[2]!)}</h2><p>Made for you and shipped to your door.</p><p class="price">${m[3]}</p><button data-vx-buy="${m[1]}">Buy now</button></article>`);
  }
  const auth = /<form data-vx-auth="(login|signup)" data-vx-redirect="([^"]+)">/.exec(prompt);
  if (auth) parts.push(`<form data-vx-auth="${auth[1]}" data-vx-redirect="${auth[2]}"><label>Email <input type="email" name="email" required></label><label>Password <input type="password" name="password" required></label><button type="submit">${auth[1] === 'login' ? 'Log in' : 'Create account'}</button><p data-vx-message></p></form>`);
  // links to the other pages of the site map (the system block lists them as "- file — Title…")
  const siteMap = system.slice(Math.max(0, system.indexOf('SITE MAP')), Math.max(0, system.indexOf('STYLES.CSS')) || undefined);
  const links = [...siteMap.matchAll(/^- (\S+\.html) — ([^:(\n]+)/gm)].filter((m) => m[1] !== file).slice(0, 6)
    .map((m) => `<li><a href="${m[1]}">${esc(m[2]!.trim())}</a></li>`);
  if (links.length && !auth) parts.push(`<nav aria-label="More pages"><ul>${links.join('')}</ul></nav>`);
  // `mock-flaw` in a page's purpose makes its FIRST attempt link to a page that does not exist, so a live run exercises the repair loop;
  // the repair call (its prompt has a REPAIR section) answers with the clean page.
  const flawed = /mock-flaw/.test(purpose) && !/\nREPAIR\n/.test(prompt);
  const shown = purpose.replace(/\s*mock-flaw\s*/g, ' ').trim();
  const copy = `<p>This page is part of a small site that says what it offers and where to find it. Everything on it is written to be read in a minute.</p><p>If you need something that is not here, write to us from the contact page and a real person will answer, usually within a day or two.</p>`;
  const body = `<section><h1>${esc(title)}</h1>${shown ? `<p>${esc(shown)}</p>` : ''}${copy}${parts.join('\n')}${flawed ? '<p><a href="missing-page.html">More about this</a></p>' : ''}</section>`;
  return {
    file,
    html: `<!DOCTYPE html><html lang="en"${html}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="description" content="${esc(shown || title).slice(0, 150)}"/><title>${esc(title)}</title><link rel="stylesheet" href="styles.css"/></head><body><header data-vx-nav></header><main>${body}</main><footer data-vx-footer></footer><script src="site.js"></script></body></html>`,
  };
}

const sse = (event: string, data: unknown): Uint8Array => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return new Response('mock anthropic: POST /v1/messages only', { status: 404 });
    const body = (await req.json().catch(() => null)) as { system?: unknown; messages?: Msg[]; stream?: boolean } | null;
    if (!body) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad json' } }), { status: 400 });
    const system = flat(body.system);
    const prompt = flat(body.messages?.[0]?.content);
    if (/mock-credit/.test(prompt)) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const slow = /mock-slow/.test(prompt);
    const page = pageFor(system, prompt);
    const reply = page ? `<file name="${page.file}">\n${page.html}\n</file>` : 'Nothing to build.';
    const tokensIn = Math.ceil((system.length + prompt.length) / 4);
    // the system block is "cached" after the first call of a build: bill it as a cache read, like the real API does
    const cached = /x-mock-cold/.test(prompt) ? 0 : tokensIn - Math.ceil(prompt.length / 4);
    const usage = { input_tokens: Math.ceil(prompt.length / 4), cache_creation_input_tokens: cached ? 0 : tokensIn, cache_read_input_tokens: cached, output_tokens: 1 };
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(sse('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock', usage } }));
        c.enqueue(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        const size = Math.max(200, Math.ceil(reply.length / 6));
        for (let i = 0; i < reply.length; i += size) {
          c.enqueue(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(i, i + size) } }));
          await new Promise((r) => setTimeout(r, slow ? 7000 : 250));
        }
        c.enqueue(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        c.enqueue(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: Math.ceil(reply.length / 4) } }));
        c.enqueue(sse('message_stop', { type: 'message_stop' }));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  },
};
