// The live preview of the example landing page: one self-contained HTML document built from the project's files, shown in a
// sandboxed iframe. Pure (unit-tested under Node, test/preview.test.ts); components/Preview.tsx owns the iframe.
//
// It is the studio twin of editor.html's buildPageHtml (inline the stylesheet + script, add the Vertly SDK so the menu and footer
// render exactly as on a published site), with two differences:
//   • the iframe has NO allow-same-origin, so the model's JavaScript runs in a null origin and can never reach the studio's session;
//   • the stylesheet sits in <style id="vx-style"> and a `vx-css` message swaps its text — that is what lets the vibe controls
//     re-skin the page instantly, without reloading it or asking the AI for anything.
//
// TWEAKS adds "point at it": the studio switches the page into pick mode (`vx-pick`), the page outlines what the pointer is over and, on
// click, reports the element (page, selector, tag, text, html) instead of letting the click do its usual thing. The page is model-written
// code in a null origin, so what it reports is untrusted: readPreviewMessage() shape-checks and caps it, and the server cleans it again.

/** The Vertly SDK, as served next to every published site. */
export const SDK_URL = 'https://vexium.ai/sdk/v1.js?r=2';

/** The id of the inlined stylesheet and the message that replaces its text. */
export const STYLE_ID = 'vx-style';
export const CSS_MESSAGE = 'vx-css';
/** Studio → page: `{type: 'vx-pick', on}` turns pick mode on or off; `{type: 'vx-unpick'}` removes the mark from the chosen element. */
export const PICK_MESSAGE = 'vx-pick';
export const UNPICK_MESSAGE = 'vx-unpick';

/** The element the owner clicked in pick mode, as the page described it. */
export interface PickedElement {
  /** The page it is on, e.g. 'index.html'. */
  page: string;
  /** A CSS selector path to it, e.g. "main > section.hero > h1". */
  selector: string;
  /** Lower-case tag name. */
  tag: string;
  /** Its visible text, trimmed. */
  text: string;
  /** Its HTML (cut short). */
  html: string;
}

/** Messages the preview page sends to the studio. */
export type PreviewMessage =
  | { source: 'vx-preview'; type: 'ready' }
  | { source: 'vx-preview'; type: 'error'; message: string }
  | { source: 'vx-preview'; type: 'navigate'; to: string }
  | ({ source: 'vx-preview'; type: 'pick' } & PickedElement);

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

/**
 * Pick mode, inside the page. While it is on, the element under the pointer is outlined and a click (captured before the page's own
 * handlers, so a link or button does nothing) reports the element and marks it. Written as plain ES5 strings: it runs in the iframe.
 */
const PICK_CODE = [
  'var picking=false,hover=null,picked=null;',
  'function mark(el,name,on){if(el&&el.toggleAttribute)el.toggleAttribute(name,on)}',
  'function css(){if(document.getElementById("vx-pick-style")||!document.head)return;var s=document.createElement("style");s.id="vx-pick-style";',
  's.textContent="html[data-vx-picking],html[data-vx-picking] *{cursor:crosshair!important}[data-vx-hover]{outline:2px dashed #7c3aed!important;outline-offset:2px!important}[data-vx-picked]{outline:3px solid #7c3aed!important;outline-offset:2px!important}";document.head.appendChild(s)}',
  'function word(x){return /^[A-Za-z_-][\\w-]*$/.test(x)}',
  'function where(el){var parts=[],n=el,depth=0;',
  'while(n&&n.nodeType===1&&n!==document.body&&n!==document.documentElement&&depth<7){',
  'var t=n.tagName.toLowerCase();',
  'if(n.id&&word(n.id)){parts.unshift(t+"#"+n.id);break}',
  'var c=(n.getAttribute("class")||"").split(/\\s+/).filter(word).slice(0,2);if(c.length)t+="."+c.join(".");',
  'if(n.hasAttribute("data-vx-nav"))t+="[data-vx-nav]";if(n.hasAttribute("data-vx-footer"))t+="[data-vx-footer]";',
  'var p=n.parentElement;if(p){var same=[].filter.call(p.children,function(x){return x.tagName===n.tagName});if(same.length>1)t+=":nth-of-type("+([].indexOf.call(same,n)+1)+")"}',
  'parts.unshift(t);n=n.parentElement;depth++}',
  'return parts.join(" > ")}',
  'function clear(){mark(hover,"data-vx-hover",false);hover=null}',
  'function unpick(){mark(picked,"data-vx-picked",false);picked=null}',
  'function setPick(on){picking=on;mark(document.documentElement,"data-vx-picking",on);if(on)css();else clear()}',
  // the chosen element must not be the page itself
  'function target(e){var el=e.target;return el&&el.nodeType===1&&el!==document.body&&el!==document.documentElement?el:null}',
  'window.addEventListener("mouseover",function(e){if(!picking)return;var el=target(e);if(el===hover)return;clear();if(el){hover=el;mark(el,"data-vx-hover",true)}},true);',
  'window.addEventListener("mouseleave",function(){if(picking)clear()},true);',
  'window.addEventListener("click",function(e){if(!picking)return;e.preventDefault();e.stopImmediatePropagation();var el=target(e);if(!el)return;',
  'clear();unpick();picked=el;mark(el,"data-vx-picked",true);',
  'var html=el.outerHTML.replace(/ data-vx-(?:hover|picked)(?:="")?/g,"").slice(0,1500);',
  'var text=String(el.innerText||el.textContent||"").replace(/\\s+/g," ").trim().slice(0,300);',
  'send({type:"pick",page:String(window.__VX&&window.__VX.page||""),selector:where(el),tag:el.tagName.toLowerCase(),text:text,html:html})},true);',
  `window.addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d)return;if(d.type==="${PICK_MESSAGE}")setPick(d.on===true);else if(d.type==="${UNPICK_MESSAGE}")unpick()});`,
];

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
  ...PICK_CODE,
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
  if (m.type === 'pick') {
    const picked = cleanPicked(m);
    return picked ? { source: 'vx-preview', type: 'pick', ...picked } : null;
  }
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

/** What a page said about a clicked element → a PickedElement with every field a string of a sane size, or null when it isn't one. */
export function cleanPicked(raw: unknown): PickedElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const page = text(m.page).trim();
  const tag = text(m.tag).trim().toLowerCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html$/.test(page) || !/^[a-z][a-z0-9-]{0,24}$/.test(tag)) return null;
  const squash = (v: unknown, n: number): string => text(v).replace(/\s+/g, ' ').trim().slice(0, n);
  return { page, selector: squash(m.selector, 300), tag, text: squash(m.text, 300), html: text(m.html).trim().slice(0, 1500) };
}
