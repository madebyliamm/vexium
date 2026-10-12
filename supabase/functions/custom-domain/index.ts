import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const VERCEL_TOKEN      = Deno.env.get('VERCEL_TOKEN_KEY')!;
const VERCEL_PROJECT_ID = 'prj_lX2eSTLNZXJYyw8ZcHSIymZYfQxr';
const VERCEL_BASE       = `https://api.vercel.com/v9/projects/${VERCEL_PROJECT_ID}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const { project_id, domain, action } = await req.json();

    const { data: project } = await supabase
      .from('projects')
      .select('id, user_id, custom_domain')
      .eq('id', project_id)
      .eq('user_id', user.id)
      .single();
    if (!project) return json({ error: 'Project not found' }, 404);

    // REMOVE
    if (action === 'remove') {
      if (project.custom_domain) {
        await vercelFetch(`${VERCEL_BASE}/domains/${project.custom_domain}`, { method: 'DELETE' });
      }
      await supabase.from('projects').update({
        custom_domain: null,
        custom_domain_cf_id: null,
        custom_domain_verified: false,
      }).eq('id', project_id);
      return json({ ok: true });
    }

    // CHECK STATUS
    if (action === 'check') {
      if (!project.custom_domain) return json({ verified: false });
      const data = await vercelFetch(`${VERCEL_BASE}/domains/${project.custom_domain}`);
      const verified = data?.verified === true;
      if (verified) {
        await supabase.from('projects').update({ custom_domain_verified: true }).eq('id', project_id);
      }
      return json({ verified, status: verified ? 'active' : 'pending' });
    }

    // CONNECT
    const raw = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim();
    if (!raw || !raw.includes('.')) return json({ error: 'Invalid domain' }, 400);

    const parts = raw.split('.');
    const cleanDomain = parts.length === 2 ? 'www.' + raw : raw;

    // Remove old domain from Vercel if changing
    if (project.custom_domain && project.custom_domain !== cleanDomain) {
      await vercelFetch(`${VERCEL_BASE}/domains/${project.custom_domain}`, { method: 'DELETE' });
    }

    // Add domain to Vercel project
    const vercelData = await vercelFetch(`${VERCEL_BASE}/domains`, {
      method: 'POST',
      body: JSON.stringify({ name: cleanDomain }),
    });

    if (vercelData.error) {
      return json({ error: vercelData.error.message || 'Vercel error' }, 400);
    }

    await supabase.from('projects').update({
      custom_domain: cleanDomain,
      custom_domain_cf_id: null,
      custom_domain_verified: vercelData.verified === true,
    }).eq('id', project_id);

    return json({
      ok: true,
      domain: cleanDomain,
      verified: vercelData.verified === true,
      status: vercelData.verified ? 'active' : 'pending',
      cname: { name: cleanDomain.split('.')[0], value: 'cname.vercel-dns.com' },
      txt: null,
    });

  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

async function vercelFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  if (res.status === 204) return {};
  return res.json();
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
