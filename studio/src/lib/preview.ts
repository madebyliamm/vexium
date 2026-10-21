// The live preview of the example landing page: one self-contained HTML document built from the project's files, shown in a
// sandboxed iframe. Pure (unit-tested under Node, test/preview.test.ts); components/Preview.tsx owns the iframe.
//
// It is the studio twin of editor.html's buildPageHtml (inline the stylesheet + script, add the Vertly SDK so the menu and footer
// render exactly as on a published site), with two differences:
//   • the iframe has NO allow-same-origin, so the model's JavaScript runs in a null origin and can never reach the studio's session;
//   • the stylesheet sits in <style id="vx-style"> and a `vx-css` message swaps its text — that is what lets the vibe controls
//     re-skin the page instantly, without reloading it or asking the AI for anything.

/** The Vertly SDK, as served next to every published site. */
export const SDK_URL = 'https://vexium.ai/sdk/v1.js?r=2';

/** The id of the inlined stylesheet and the message that replaces its text. */
export const STYLE_ID = 'vx-style';
export const CSS_MESSAGE = 'vx-css';

/** Messages the preview page sends to the studio. */
export type PreviewMessage =
  | { source: 'vx-preview'; type: 'ready' }
  | { source: 'vx-preview'; type: 'error'; message: string }
  | { source: 'vx-preview'; type: 'navigate'; to: string };

export interface PreviewInput {
  projectId: string;
  /** The page being shown, e.g. 'index.html'. */
  page: string;
  /** The project's files by name (only text files are read). */
  files: Record<string, string>;
  /** Overrides files['styles.css'] — the stylesheet with the draft vibe applied. */
  css?: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Text that is safe to put inside <style>/<script>: the closing tag can't be written literally. */
export const inertStyle = (css: string): string => css.replace(/<\/style/gi, '<\\/style');
export const inertScript = (js: string): string => js.replace(/<\/script/gi, '<\\/script');

/** The code that runs first in the preview: report errors and navigation to the studio, and accept new CSS. */
const BRIDGE = [
  '(function(){',
  'function send(m){try{m.source="vx-preview";parent.postMessage(m,"*")}catch(e){}}',
  'window.addEventListener("error",function(e){send({type:"error",message:(e.message||"Error")+" (line "+e.lineno+")"})});',
  'window.addEventListener("unhandledrejection",function(e){send({type:"error",message:String(e.reason&&e.reason.message||e.reason||"Async error")})});',
  `window.addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!=="${CSS_MESSAGE}"||typeof d.css!=="string")return;var s=document.getElementById("${STYLE_ID}");if(s)s.textContent=d.css});`,
  // Links to other pages can't load in the preview: tell the studio, which says that page is built in the next step.
  'window.addEventListener("click",function(e){if(e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey)return;var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href")||"";if(!h||h.charAt(0)==="#")return;e.preventDefault();send({type:"navigate",to:h})},false);',
  'window.addEventListener("load",function(){send({type:"ready"})});',
  '})();',
].join('');

/** `window.__VX` tells the SDK the site id, which page this is and how to move between pages inside the preview. */
function boot(projectId: string, page: string): string {
  const navigate = 'function(u){parent.postMessage({source:"vx-preview",type:"navigate",to:String(u||"")},"*")}';
  return `<script>window.__VX={site:${JSON.stringify(projectId)},page:${JSON.stringify(page)},navigate:${navigate}}</script><script src="${SDK_URL}"></script>`;
}

/** One page of the project as a standalone document. */
export function buildPreviewHtml(input: PreviewInput): string {
  const { projectId, page, files } = input;
  const fill = (s: string): string => s.split('{{VEXIUM_PROJECT_ID}}').join(projectId);
  let html = fill(text(files[page]));

  // Inline every linked .css / .js the project has (the stylesheet becomes the swappable <style id>).
  for (const [name, raw] of Object.entries(files)) {
    if (name === page || typeof raw !== 'string' || !raw) continue;
    const re = escapeRe(name);
    if (name.endsWith('.css')) {
      const css = inertStyle(fill(name === 'styles.css' && input.css !== undefined ? input.css : raw));
      const id = name === 'styles.css' ? ` id="${STYLE_ID}"` : '';
      html = html.replace(new RegExp(`<link[^>]+href=["']${re}["'][^>]*/?>`, 'gi'), () => `<style${id}>${css}</style>`);
    } else if (name.endsWith('.js')) {
      const js = inertScript(fill(raw));
      html = html.replace(new RegExp(`<script[^>]+src=["']${re}["'][^>]*></script>`, 'gi'), () => `<script>${js}</script>`);
    }
  }
  // A page that never linked the stylesheet would be unstyled and the vibe controls would do nothing — add it so they always work.
  if (!html.includes(`id="${STYLE_ID}"`)) {
    const css = inertStyle(fill(input.css ?? text(files['styles.css'])));
    const tag = `<style id="${STYLE_ID}">${css}</style>`;
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${tag}</head>`) : tag + html;
  }

  const head = `<script>${BRIDGE}</script>${boot(projectId, page)}`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/(<head[^>]*>)/i, (m) => m + head) : head + html;
  return html;
}

/** Is `e` a message from OUR preview iframe? (Source check first: any other window could post anything.) */
export function readPreviewMessage(e: { source: unknown; data: unknown }, frame: unknown): PreviewMessage | null {
  if (!frame || e.source !== frame) return null;
  const d = e.data;
  if (!d || typeof d !== 'object') return null;
  const m = d as Record<string, unknown>;
  if (m.source !== 'vx-preview') return null;
  if (m.type === 'ready') return { source: 'vx-preview', type: 'ready' };
  if (m.type === 'error') return { source: 'vx-preview', type: 'error', message: text(m.message).slice(0, 300) };
  if (m.type === 'navigate') return { source: 'vx-preview', type: 'navigate', to: text(m.to).slice(0, 300) };
  return null;
}

/** "contact.html#form?x=1" → "contact.html"; null for external links and bare anchors. */
export function pageOfLink(to: string): string | null {
  const s = to.trim();
  if (!s || s.startsWith('#') || /^(https?:)?\/\/|^(mailto|tel|javascript|data|blob):/i.test(s)) return null;
  let p = s.split('#')[0]!.split('?')[0]!;
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  if (!p) return null;
  return p.includes('.') ? p : p + '.html';
}
