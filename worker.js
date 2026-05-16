/**
 * Vexium Publishing Worker
 * Handles: username.vexium.ai/project-slug  (vexium subdomains)
 *          www.customdomain.com/page         (custom domains via Cloudflare for SaaS)
 */

const SUPABASE_URL  = 'https://ciuqhxrxcznmgorjeumz.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpdXFoeHJ4Y3pubWdvcmpldW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NDYxODUsImV4cCI6MjA4ODMyMjE4NX0.54fc-rv6tLCE-6BM6eFFy3HjPcPnus69NckKjIKNJCY';

const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

export default {
  async fetch(request) {
    const url  = new URL(request.url);
    const host = url.hostname;

    // Health check — used by the editor to confirm the Worker is live
    if (url.pathname === '/__vexium_ping') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    }

    const isVexiumDomain = host.endsWith('.vexium.ai');

    if (isVexiumDomain) {
      return handleVexiumDomain(host, url);
    } else {
      return handleCustomDomain(host, url);
    }
  },
};

// ── VEXIUM SUBDOMAIN: username.vexium.ai/project-slug ────────────────────────
async function handleVexiumDomain(host, url) {
  const subdomain = host.split('.')[0];

  const pathParts = url.pathname.replace(/^\//, '').split('/');
  const slug    = pathParts[0];
  const subpage = pathParts.slice(1).join('/') || null;

  if (!slug) return notFound('No project specified.');

  // Look up user by username
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?username=eq.${enc(subdomain)}&select=id`,
    { headers: HEADERS }
  );
  const profiles = await profileRes.json();
  if (!Array.isArray(profiles) || !profiles.length) return notFound('User not found.');

  const userId = profiles[0].id;

  // Look up published project
  const projRes = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?user_id=eq.${userId}&published_slug=eq.${enc(slug)}&select=id,published_files,files,main_file,name`,
    { headers: HEADERS }
  );
  const projects = await projRes.json();
  if (!Array.isArray(projects) || !projects.length) return notFound('Project not found or not published.');

  return serveProject(projects[0], subpage);
}

// ── CUSTOM DOMAIN: www.theirdomain.com/page ──────────────────────────────────
async function handleCustomDomain(host, url) {
  const pathParts = url.pathname.replace(/^\//, '').split('/');
  const subpage   = pathParts.join('/') || null;

  const projRes = await fetch(
    `${SUPABASE_URL}/rest/v1/projects?custom_domain=eq.${enc(host)}&published_slug=not.is.null&select=id,published_files,files,main_file,name&limit=1`,
    { headers: HEADERS }
  );
  const projects = await projRes.json();
  if (!Array.isArray(projects) || !projects.length) return notFound('No published project found for this domain.');

  return serveProject(projects[0], subpage);
}

// ── SERVE ─────────────────────────────────────────────────────────────────────
function serveProject(project, subpage) {
  const files     = project.published_files || project.files || {};
  const projectId = project.id;
  const mainFile  = project.main_file || 'index.html';

  let pageName = subpage || mainFile;
  if (!files[pageName]) {
    if (files[pageName + '.html'])  pageName = pageName + '.html';
    else if (files[mainFile])       pageName = mainFile;
    else return notFound('Page not found.');
  }

  let html = files[pageName] || '';
  if (projectId) html = html.split('{{VEXIUM_PROJECT_ID}}').join(projectId);

  const isImg = fn => /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(fn);

  // Pass 1: inline CSS/JS first so url() refs inside CSS are visible to image pass
  Object.entries(files).forEach(([fn, fc]) => {
    if (!fc || fn === pageName || typeof fc !== 'string' || isImg(fn)) return;
    const safe = fn.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    if (fn.endsWith('.css')) {
      html = html.replace(
        new RegExp(`<link[^>]+href=["']${safe}["'][^>]*/?>`, 'gi'),
        '<style>' + fc.replace(/<\/style>/gi, '<\\/style>') + '</style>'
      );
    } else if (fn.endsWith('.js')) {
      html = html.replace(
        new RegExp(`<script[^>]+src=["']${safe}["'][^>]*>[\\s\\S]*?<\\/script>`, 'gi'),
        '<script>' + fc.replace(/<\/script>/gi, '<\\/script>') + '</script>'
      );
    }
  });

  // Pass 2: substitute image data URLs (catches url() refs now inside inlined CSS too)
  Object.entries(files).forEach(([fn, fc]) => {
    if (!fc || fn === pageName || typeof fc !== 'string' || !isImg(fn)) return;
    if (!fc.startsWith('data:')) return;
    const safe = fn.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    html = html.replace(new RegExp(`(src=["'])${safe}(["'])`, 'gi'), `$1${fc}$2`);
    html = html.replace(new RegExp(`url\\(["']?${safe}["']?\\)`, 'gi'), `url(${fc})`);
  });

  // Inject analytics snippet so published sites track real visitors
  const trackSnippet = `<script>(function(){try{var sid=sessionStorage.getItem('_vsid')||Math.random().toString(36).slice(2);sessionStorage.setItem('_vsid',sid);var vid=localStorage.getItem('_vvid')||Math.random().toString(36).slice(2);localStorage.setItem('_vvid',vid);fetch('https://ciuqhxrxcznmgorjeumz.supabase.co/functions/v1/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:'${projectId}',page:location.pathname,referrer:document.referrer,session_id:sid,visitor_id:vid})}).catch(function(){});}catch(e){}})()</script>`;
  if (html.includes('</body>')) {
    html = html.replace('</body>', trackSnippet + '</body>');
  } else {
    html += trackSnippet;
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function enc(s) { return encodeURIComponent(s); }

function notFound(msg) {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
    <title>Not found — Vexium</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}
    body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100vh;gap:12px}
    h1{font-size:18px;font-weight:700}p{font-size:13px;color:#666}
    a{color:#fff;font-size:13px;font-weight:600;text-decoration:none;
    margin-top:8px;padding:8px 20px;background:#1a1a1a;border-radius:8px}
    a:hover{background:#222}</style></head>
    <body><h1>Page not found</h1><p>${msg}</p>
    <a href="https://vexium.ai">Back to Vexium</a></body></html>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
