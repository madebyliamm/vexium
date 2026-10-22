// LAUNCH over the network (REVAMP Step 12): publish the CURRENT draft through the publisher Worker (Hosting v2), look at the live versions,
// go back to one, take the site offline, and check/start Stripe Connect. Pure logic lives in lib/launch-view.ts (unit-tested); this file is I/O.
import { PUBLISH_API, SUPABASE_URL } from '../lib/config.ts';
import { DEPLOY_COLUMNS, readDeploys, type Deploy } from '../lib/launch-view.ts';
import { sb } from '../lib/supabase.ts';
import { authDeps } from './deps.ts';
import { authedFetch, postJson } from './http.ts';

export interface LaunchProject {
  /** The owner's public username — the site lives at `<username>.vexium.ai/<slug>` (a collaborator publishes under the OWNER's name). */
  username: string | null;
  name: string;
  slug: string | null;
  version: number | null;
  publishedAt: string | null;
  updatedAt: string | null;
  customDomain: string | null;
}

/** What the screen needs to know about the project's publishing state, in one round trip. null = no such project / no access. */
export async function getLaunchProject(projectId: string): Promise<LaunchProject | null> {
  const { data, error } = await sb.from('projects').select('user_id,name,published_slug,published_version,published_at,updated_at,custom_domain').eq('id', projectId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const p = data as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  let username: string | null = null;
  if (typeof p.user_id === 'string') {
    const u = await sb.from('profiles').select('username').eq('id', p.user_id).maybeSingle();
    if (!u.error) username = str((u.data as { username?: unknown } | null)?.username);
  }
  return {
    username,
    name: str(p.name) ?? '',
    slug: str(p.published_slug),
    version: typeof p.published_version === 'number' ? p.published_version : null,
    publishedAt: str(p.published_at),
    updatedAt: str(p.updated_at),
    customDomain: str(p.custom_domain),
  };
}

export interface PublishOutcome {
  version: number;
  slug: string;
}

/** Publish the project's CURRENT draft (`projects.files`). The publisher stores it as a new immutable version and flips the live pointer last,
 *  so a failure leaves the previous version live. A publish error carries the publisher's own plain sentence. */
export async function publishDraft(projectId: string, slug: string): Promise<PublishOutcome> {
  const { data, error } = await sb.from('projects').select('files,main_file').eq('id', projectId).maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { files?: unknown; main_file?: unknown } | null;
  if (!row || !row.files || typeof row.files !== 'object') throw new Error('There is nothing to publish yet — build your site first.');
  const mainFile = typeof row.main_file === 'string' && row.main_file ? row.main_file : 'index.html';
  const out = await postJson<{ ok?: boolean; version?: unknown; slug?: unknown }>(`${PUBLISH_API}/publish`, { projectId, files: row.files, mainFile, slug }, authDeps);
  if (out.ok !== true || typeof out.version !== 'number' || typeof out.slug !== 'string') throw new Error('Publishing did not finish. Your live site was not changed.');
  return { version: out.version, slug: out.slug };
}

/** The live site goes back to a saved version (the files are not rewritten — only the live pointer moves). */
export async function rollbackTo(projectId: string, version: number): Promise<void> {
  await postJson(`${PUBLISH_API}/rollback`, { projectId, version }, authDeps);
}

/** Take the site offline. The saved versions stay, so publishing again brings it back. */
export async function takeOffline(projectId: string): Promise<void> {
  await postJson(`${PUBLISH_API}/unpublish`, { projectId }, authDeps);
}

/** The saved live versions (newest first, readable ones only). */
export async function listDeploys(projectId: string, liveVersion: number | null): Promise<Deploy[]> {
  const { data, error } = await sb.from('project_deploys').select(DEPLOY_COLUMNS).eq('project_id', projectId).order('version', { ascending: false }).limit(20);
  if (error) throw new Error(error.message);
  return readDeploys(data, liveVersion);
}

/** Has the address started answering? (The publisher is fast, but DNS/CDN caches can lag a few seconds on a first publish.) */
export async function isReachable(username: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`https://${username}.vexium.ai/__vexium_ping`, { cache: 'no-store', ...(signal ? { signal } : {}) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── payments (Stripe Connect) ────────────────────────────────────────────────

/** Is the owner's Stripe account ready to take payments? null = could not find out (the screen then asks to try again). */
export async function getPaymentsReady(): Promise<boolean | null> {
  try {
    const res = await authedFetch(`${SUPABASE_URL}/functions/v1/stripe-connect-status`, { method: 'GET' }, authDeps);
    if (!res.ok) return null;
    const out = (await res.json()) as { charges_enabled?: unknown; error?: unknown };
    if (out.error) return null;
    return out.charges_enabled === true;
  } catch {
    return null;
  }
}

/** Stripe's own sign-up/onboarding page; it sends the owner back to this project when they finish. */
export async function startPaymentsSetup(projectId: string): Promise<string> {
  const back = `${location.origin}/studio/#/p/${encodeURIComponent(projectId)}`;
  const out = await postJson<{ url?: unknown; error?: unknown }>(`${SUPABASE_URL}/functions/v1/stripe-connect-start`, { project_id: projectId, return_url: back, refresh_url: back }, authDeps);
  if (typeof out.url !== 'string' || !out.url.startsWith('https://')) throw new Error('Could not start the Stripe setup. Please try again.');
  return out.url;
}

