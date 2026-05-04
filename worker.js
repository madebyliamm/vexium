/**
 * Vexium Publishing Worker
 * Handles: username.vexium.ai/project-slug
 * Serves the published project files from Supabase.
 */

const SUPABASE_URL  = 'https://ciuqhxrxcznmgorjeumz.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpdXFoeHJ4Y3pubWdvcmpldW16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NDYxODUsImV4cCI6MjA4ODMyMjE4NX0.54fc-rv6tLCE-6BM6eFFy3HjPcPnus69NckKjIKNJCY';

const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname; // e.g. "liam.vexium.ai"
    const subdomain = host.split('.')[0];

    // Health check route — used by the editor to confirm the Worker is live
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

    // Parse path: /project-slug  or  /project-slug/about.html
    const pathParts = url.pathname.replace(/^\//, '').split('/');
    const slug      = pathParts[0];
    const subpage   = pathParts.slice(1).join('/') || null;

    if (!slug) return notFound('No project specified.');

    // 1. Look up the user by username
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?username=eq.${enc(subdomain)}&select=id`,
      { headers: HEADERS }
    );
    const profiles = await profileRes.json();
    if (!Array.isArray(profiles) || !profiles.length) return notFound('User not found.');

    const userId = profiles[0].id;

    // 2. Look up the published project
    const projRes = await fetch(
      `${SUPABASE_URL}/rest/v1/projects?user_id=eq.${userId}&published_slug=eq.${enc(slug)}&select=id,published_files,files,main_file,name`,
      { headers: HEADERS }
    );
    const projects = await projRes.json();
    if (!Array.isArray(projects) || !projects.length) return notFound('Project not found or not published.');

    const project   = projects[0];
    // Use published_files snapshot if available, fall back to files for older published projects
    const files     = project.published_files || project.files || {};
    const projectId = project.id;
    const mainFile  = project.main_file || 'index.html';

    // 3. Determine which page to serve
    let pageName = subpage || mainFile;
    if (!files[pageName]) {
      // Try adding .html
      if (files[pageName + '.html']) pageName = pageName + '.html';
      // Fall back to main file
      else if (files[mainFile]) pageName = mainFile;
      else return notFound('Page not found.');
    }

    // 4. Get the HTML and substitute the project ID placeholder
    let html = files[pageName] || '';
    if (projectId) html = html.split('{{VEXIUM_PROJECT_ID}}').join(projectId);

    // 5. Also inline any CSS/JS files referenced in this HTML
    // (matches how viewer.html works so the published site looks identical)
    Object.entries(files).forEach(([fn, fc]) => {
      if (!fc || fn === pageName) return;
      if (typeof fc !== 'string') return;
      const safe = fn.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      if (fn.endsWith('.css')) {
        const inlined = fc.replace(/<\/style>/gi, '<\\/style>');
        html = html.replace(
          new RegExp(`<link[^>]+href=["']${safe}["'][^>]*/?>`, 'gi'),
          '<style>' + inlined + '</style>'
        );
      } else if (fn.endsWith('.js')) {
        const inlined = fc.replace(/<\/script>/gi, '<\\/script>');
        html = html.replace(
          new RegExp(`<script[^>]+src=["']${safe}["'][^>]*>[\\s\\S]*?<\\/script>`, 'gi'),
          '<script>' + inlined + '</script>'
        );
      }
    });

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      },
    });
  },
};

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
    {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}
