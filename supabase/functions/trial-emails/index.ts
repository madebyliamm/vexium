import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_KEY = Deno.env.get('RESEND_API_KEY')!;
const FROM = 'Vexium <hello@vexium.ai>';

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const now = new Date();

  // Reminder: trial ends within the next 23–25 hours
  const reminderFrom = new Date(now.getTime() + 23 * 60 * 60 * 1000).toISOString();
  const reminderTo   = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();

  // Expired: trial ended within the last 1 hour
  const expiredFrom = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const expiredTo   = now.toISOString();

  const [{ data: reminderUsers }, { data: expiredUsers }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, email, display_name, username')
      .eq('plan', 'trial')
      .gte('trial_ends_at', reminderFrom)
      .lte('trial_ends_at', reminderTo),
    supabase
      .from('profiles')
      .select('id, email, display_name, username')
      .eq('plan', 'trial')
      .gte('trial_ends_at', expiredFrom)
      .lte('trial_ends_at', expiredTo),
  ]);

  const results: string[] = [];

  for (const user of (reminderUsers || [])) {
    const name = user.display_name || user.username || 'there';
    if (!user.email) continue;
    await sendEmail(user.email, `Your Vexium trial ends tomorrow`, reminderHtml(name));
    results.push(`reminder: ${user.email}`);
  }

  for (const user of (expiredUsers || [])) {
    const name = user.display_name || user.username || 'there';
    if (!user.email) continue;
    await sendEmail(user.email, `Your Vexium free trial has ended`, expiredHtml(name));
    results.push(`expired: ${user.email}`);
  }

  return new Response(JSON.stringify({ ok: true, sent: results }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
}

function reminderHtml(name: string) {
  return `<!DOCTYPE html><html><body style="background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;padding:40px 24px;max-width:520px;margin:0 auto">
  <img src="https://vexium.ai/vexium_logo.png" width="36" style="border-radius:8px;margin-bottom:24px"/>
  <h1 style="font-size:22px;font-weight:800;margin:0 0 12px">Your trial ends tomorrow, ${name}</h1>
  <p style="font-size:15px;color:#888;line-height:1.7;margin:0 0 28px">You have 1 day left on your Vexium free trial. Your projects stay exactly as they are — you just need a plan to keep building.</p>
  <a href="https://vexium.ai/settings.html?tab=billing" style="display:inline-block;background:#fff;color:#000;font-weight:700;font-size:14px;padding:12px 28px;border-radius:99px;text-decoration:none">Choose a plan</a>
  <p style="font-size:12px;color:#444;margin-top:32px">Questions? <a href="mailto:hello@vexium.ai" style="color:#666">hello@vexium.ai</a></p>
</body></html>`;
}

function expiredHtml(name: string) {
  return `<!DOCTYPE html><html><body style="background:#0a0a0a;color:#fff;font-family:system-ui,sans-serif;padding:40px 24px;max-width:520px;margin:0 auto">
  <img src="https://vexium.ai/vexium_logo.png" width="36" style="border-radius:8px;margin-bottom:24px"/>
  <h1 style="font-size:22px;font-weight:800;margin:0 0 12px">Your free trial has ended, ${name}</h1>
  <p style="font-size:15px;color:#888;line-height:1.7;margin:0 0 8px">Your 7-day Vexium trial is up. Everything you built is still here — pick a plan to get back to it.</p>
  <p style="font-size:15px;color:#888;line-height:1.7;margin:0 0 28px">Plans start at <strong style="color:#fff">$12/month</strong>.</p>
  <a href="https://vexium.ai/settings.html?tab=billing" style="display:inline-block;background:#fff;color:#000;font-weight:700;font-size:14px;padding:12px 28px;border-radius:99px;text-decoration:none">Keep building →</a>
  <p style="font-size:12px;color:#444;margin-top:32px">Questions? <a href="mailto:hello@vexium.ai" style="color:#666">hello@vexium.ai</a></p>
</body></html>`;
}
