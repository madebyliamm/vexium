// Typed reads from Supabase. RLS decides what comes back; select explicit columns only (profiles/billing are
// column-granted — never select('*') there, see memory project_supabase_security_model).
import { sb } from '../lib/supabase.ts';

export interface ProjectSummary {
  id: string;
  name: string;
  emoji: string | null;
  updated_at: string | null;
  published_slug: string | null;
  published_version: number | null;
}

const PROJECT_COLUMNS = 'id,name,emoji,updated_at,published_slug,published_version';

export async function listMyProjects(userId: string): Promise<ProjectSummary[]> {
  const { data, error } = await sb
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ProjectSummary[];
}

export async function getProject(id: string): Promise<ProjectSummary | null> {
  const { data, error } = await sb.from('projects').select(PROJECT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProjectSummary | null) ?? null;
}

export interface BillingSummary {
  plan: string;
  trial_ends_at: string | null;
}

/** The caller's own billing row (own-row SELECT only; null if none yet). */
export async function getMyBilling(userId: string): Promise<BillingSummary | null> {
  const { data, error } = await sb.from('account_billing').select('plan,trial_ends_at').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as BillingSummary | null) ?? null;
}

/** A fresh project id, same format the dashboard and editor use. */
export function newProjectId(now: number = Date.now(), random: () => number = Math.random): string {
  return 'proj_' + now + '_' + random().toString(36).slice(2, 7);
}

/**
 * Create an empty project for the signed-in owner (stage defaults to 'plan'). The starter index.html is what the dashboard
 * creates too, so "Open in editor" works on it. Note: unlike the dashboard this does not check the plan's project limit — Step 14.
 */
export async function createProject(userId: string, name = 'Untitled'): Promise<string> {
  const id = newProjectId();
  const now = new Date().toISOString();
  const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8"/>\n  <title>${name}</title>\n</head>\n<body>\n\n</body>\n</html>`;
  const { error } = await sb.from('projects').insert({ id, user_id: userId, name, emoji: '💻', files: { 'index.html': html }, main_file: 'index.html', is_public: false, created_at: now, updated_at: now });
  if (error) throw new Error(error.message);
  return id;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const { error } = await sb.from('projects').update({ name }).eq('id', id);
  if (error) throw new Error(error.message);
}
