// A small, forgiving HTML reader and a JavaScript bracket checker — what the launch verifier (verifier.ts) and the backend deriver
// (site-derive.ts) look at generated pages with. Pure TypeScript with no DOM, so it runs in Deno edge functions, Workers and Node tests.
//
// This is not a browser: it does not run scripts or apply CSS. It reads the page the way the checks need — tags, attributes, text,
// the order and nesting of elements — and tolerates what models write (unclosed <p>/<li>, stray end tags, unquoted attributes).

export interface TextNode {
  text: string;
}
export interface El {
  tag: string;
  attrs: Record<string, string>;
  children: (El | TextNode)[];
  parent: El | null;
  /** Source offset of the opening tag. */
  at: number;
}
export type HtmlNode = El | TextNode;

export interface ParsedPage {
  root: El;
  /** `<script>` elements: external (src) and inline (code). */
  scripts: { src: string | null; code: string; at: number }[];
  /** Contents of every `<style>` element. */
  styles: string[];
  /** The text of every HTML comment. */
  comments: string[];
  /** Whether a `<!DOCTYPE html>` and the closing `</html>` and `</body>` were seen. */
  seen: { doctype: boolean; htmlEnd: boolean; bodyEnd: boolean };
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function readAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function parseHtml(html: string): ParsedPage {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null, at: 0 };
  const out: ParsedPage = { root, scripts: [], styles: [], comments: [], seen: { doctype: false, htmlEnd: false, bodyEnd: false } };
  let cur = root;
  let i = 0;
  const n = html.length;
  const text = (t: string) => {
    if (t) cur.children.push({ text: t });
  };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      out.comments.push(html.slice(i + 4, end === -1 ? n : end));
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      if (/^<!doctype/i.test(html.slice(i, i + 10))) out.seen.doctype = true;
      const end = html.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (html[i + 1] === '/') {
      const m = /^<\/([A-Za-z][^\s>]*)\s*>/.exec(html.slice(i, i + 80));
      if (!m) {
        text('<');
        i += 1;
        continue;
      }
      const tag = m[1]!.toLowerCase();
      if (tag === 'html') out.seen.htmlEnd = true;
      if (tag === 'body') out.seen.bodyEnd = true;
      for (let e: El | null = cur; e && e !== root; e = e.parent) {
        if (e.tag === tag) {
          cur = e.parent ?? root;
          break;
        }
      }
      i += m[0].length;
      continue;
    }
    // An opening tag: find its closing '>' (a quoted attribute value may contain one).
    const open = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(i, i + 60));
    if (!open) {
      text('<');
      i += 1;
      continue;
    }
    let j = i + open[0].length;
    let quote = '';
    while (j < n) {
      const c = html[j]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const tag = open[1]!.toLowerCase();
    const raw = html.slice(i + open[0].length, j);
    const selfClosed = raw.endsWith('/');
    const el: El = { tag, attrs: readAttrs(selfClosed ? raw.slice(0, -1) : raw), children: [], parent: cur, at: i };
    cur.children.push(el);
    i = j + 1;
    if (RAW.has(tag) && !selfClosed) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = closeRe.exec(rest);
      const code = m ? rest.slice(0, m.index) : rest;
      if (tag === 'script') out.scripts.push({ src: el.attrs.src ?? null, code, at: el.at });
      else out.styles.push(code);
      el.children.push({ text: code });
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }
    if (!VOID.has(tag) && !selfClosed) cur = el;
  }
  return out;
}

export function isEl(n: HtmlNode): n is El {
  return (n as El).tag !== undefined;
}

/** Every element under `el` (depth-first, document order), `el` itself excluded. */
export function allEls(el: El): El[] {
  const out: El[] = [];
  const walk = (e: El) => {
    for (const c of e.children) {
      if (isEl(c)) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

/** The text a visitor can read inside `el` — scripts, styles and comments excluded, entities decoded, whitespace collapsed. */
export function visibleText(el: El): string {
  const parts: string[] = [];
  const walk = (e: El) => {
    for (const c of e.children) {
      if (isEl(c)) {
        if (c.tag !== 'script' && c.tag !== 'style' && c.tag !== 'template' && c.tag !== 'noscript') walk(c);
      } else parts.push(c.text);
    }
  };
  walk(el);
  return decodeEntities(parts.join(' ')).replace(/\s+/g, ' ').trim();
}

export function hasAncestor(el: El, pred: (e: El) => boolean): boolean {
  for (let p = el.parent; p; p = p.parent) if (pred(p)) return true;
  return false;
}

// ── JavaScript bracket check ────────────────────────────────────────────────────────────────────────

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof', 'yield', 'await']);
const CLOSER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Does this script end where it should? Walks the code the way a tokenizer would — strings, template literals (with `${}`), comments,
 * regex literals — and checks every bracket closes in order. This is the one thing a model that ran out of room reliably gets wrong,
 * and it silently turns the whole page's JavaScript off. Returns a plain description of the first problem, or null when it balances.
 */
export function jsBalanceProblem(code: string): string | null {
  const stack: string[] = [];
  let i = 0;
  const n = code.length;
  let mode: 'code' | 'template' = 'code';
  let prev = ''; // last significant character in code mode
  let prevWord = '';
  const closeTemplate = (): string | null => {
    // Reads template text from i; leaves i after the closing backtick or after a `${`.
    while (i < n) {
      const c = code[i]!;
      if (c === '\\') i += 2;
      else if (c === '`') {
        i++;
        mode = 'code';
        prev = '`';
        prevWord = '';
        return null;
      } else if (c === '$' && code[i + 1] === '{') {
        stack.push('$');
        i += 2;
        mode = 'code';
        prev = '{';
        prevWord = '';
        return null;
      } else i++;
    }
    return 'a template string is not closed';
  };
  while (i < n) {
    if (mode === 'template') {
      const p = closeTemplate();
      if (p) return p;
      continue;
    }
    const c = code[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end === -1) return 'a comment is not closed';
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && code[i] !== c) {
        if (code[i] === '\\') i++;
        else if (code[i] === '\n') return 'a text string is not closed';
        i++;
      }
      if (i >= n) return 'a text string is not closed';
      i++;
      prev = c;
      prevWord = '';
      continue;
    }
    if (c === '`') {
      i++;
      mode = 'template';
      continue;
    }
    if (c === '/') {
      const regexOk = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || (/[A-Za-z]/.test(prev) && REGEX_AFTER_WORD.has(prevWord));
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n && code[j] !== '\n') {
          const d = code[j]!;
          if (d === '\\') j++;
          else if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) {
            ok = true;
            break;
          }
          j++;
        }
        if (ok) {
          i = j + 1;
          while (i < n && /[a-z]/i.test(code[i]!)) i++;
          prev = '/';
          prevWord = '';
          continue;
        }
      }
      i++;
      prev = '/';
      prevWord = '';
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      stack.push(c);
      i++;
      prev = c;
      prevWord = '';
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (c === '}' && top === '$') {
        i++;
        mode = 'template';
        continue;
      }
      if (top !== CLOSER[c]) return top ? `a "${c}" closes a "${top === '$' ? '${' : top}"` : `a stray "${c}"`;
      i++;
      prev = c;
      prevWord = '';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(code[j]!)) j++;
      prevWord = code.slice(i, j);
      prev = prevWord[prevWord.length - 1]!;
      i = j;
      continue;
    }
    prev = c;
    prevWord = '';
    i++;
  }
  if (mode === 'template') return 'a template string is not closed';
  if (stack.length) return `a "${stack[stack.length - 1] === '$' ? '${' : stack[stack.length - 1]}" is never closed — the script is cut off`;
  return null;
}
