// Pre-v2 sites: the whole published file map is a jsonb blob on the project row. Served exactly like the old
// Worker did (CSS/JS inlined into the page, images substituted as data: URLs) until the owner republishes — a
// republish writes a v2 deploy and this path is never used for that site again.

import { notFoundPage, prepareHtml } from './html.ts';

const isImg = (fn: string) => /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(fn);
const reEscape = (s: string) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

export function serveLegacy(project: { id: string; files: Record<string, string>; main_file: string }, rel: string, baseHref: string): Response {
  const files = project.files;
  const mainFile = project.main_file;

  let pageName = rel || mainFile;
  if (!files[pageName]) {
    if (files[pageName + '.html']) pageName = pageName + '.html';
    else if (files[mainFile]) pageName = mainFile; // legacy behaviour: unknown paths fall back to the main page
    else return notFoundPage('Page not found.');
  }

  let html = files[pageName] || '';

  // Pass 1: inline CSS/JS first so url() refs inside CSS are visible to the image pass.
  for (const [fn, fc] of Object.entries(files)) {
    if (!fc || fn === pageName || typeof fc !== 'string' || isImg(fn)) continue;
    const safe = reEscape(fn);
    if (fn.endsWith('.css')) {
      html = html.replace(new RegExp(`<link[^>]+href=["']${safe}["'][^>]*/?>`, 'gi'), () => '<style>' + fc.replace(/<\/style>/gi, '<\\/style>') + '</style>');
    } else if (fn.endsWith('.js')) {
      html = html.replace(new RegExp(`<script[^>]+src=["']${safe}["'][^>]*>[\\s\\S]*?<\\/script>`, 'gi'), () => '<script>' + fc.replace(/<\/script>/gi, '<\\/script>') + '</script>');
    }
  }

  // Pass 2: substitute image data URLs (also catches url() refs now inside inlined CSS).
  for (const [fn, fc] of Object.entries(files)) {
    if (!fc || fn === pageName || typeof fc !== 'string' || !isImg(fn) || !fc.startsWith('data:')) continue;
    const safe = reEscape(fn);
    html = html.replace(new RegExp(`(src=["'])${safe}(["'])`, 'gi'), (_m, a, b) => `${a}${fc}${b}`);
    html = html.replace(new RegExp(`url\\(["']?${safe}["']?\\)`, 'gi'), () => `url(${fc})`);
  }

  return new Response(prepareHtml(html, { projectId: project.id, baseHref }), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
