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
