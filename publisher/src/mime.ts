const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
};

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Content-Type for a file path; `fallback` (e.g. the mime of a data: URL) is used for unknown extensions. */
export function mimeFor(path: string, fallback?: string): string {
  return TYPES[extOf(path)] || fallback || 'application/octet-stream';
}

export function isHtml(contentType: string): boolean {
  return contentType.startsWith('text/html');
}

/**
 * Browser cache policy. Asset URLs are not fingerprinted, so anything long-lived could show stale files right
 * after a republish; revalidation is cheap because every response carries an ETag (304 from the Worker).
 */
export function cacheControlFor(contentType: string): string {
  if (isHtml(contentType)) return 'public, max-age=0, must-revalidate';
  if (contentType.startsWith('text/css') || contentType.startsWith('text/javascript') || contentType.includes('json') || contentType.includes('xml')) {
    return 'public, max-age=300, must-revalidate';
  }
  return 'public, max-age=3600, stale-while-revalidate=86400';
}
