export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const host = req.headers.get('host') || '';
  const target = `https://vexium-publisher.startafter.workers.dev${url.pathname}${url.search}`;
  const headers = new Headers(req.headers);
  headers.set('x-forwarded-host', host);
  return fetch(target, {
    method: req.method,
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
  });
}
