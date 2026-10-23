// BUSINESS over the network (REVAMP Step 13): the numbers come from the `business-state` edge function (server-computed, owner/member only) —
// the studio never reads page_views or site_data itself. Pure logic lives in lib/business-view.ts (unit-tested); this file is I/O.
import { SUPABASE_URL } from '../lib/config.ts';
import { readBusinessState, type Period } from '../lib/business-view.ts';
import type { BusinessState } from '../types/artifacts.ts';
import { authDeps } from './deps.ts';
import { postJson } from './http.ts';

export interface BusinessNumbers {
  state: BusinessState;
  /** Younger than a minute and for the same period, so the server returned it as saved. */
  cached: boolean;
}

/** The numbers for the last `days` days. `refresh` skips the 60-second cache. Rejects with an ApiError (409 = the site is not live, 404 = no access). */
export async function getBusinessNumbers(projectId: string, days: Period, refresh = false): Promise<BusinessNumbers> {
  const out = await postJson<{ state?: unknown; cached?: unknown }>(
    `${SUPABASE_URL}/functions/v1/business-state`,
    { project_id: projectId, days, ...(refresh ? { refresh: true } : {}) },
    authDeps,
  );
  const state = readBusinessState(out.state);
  if (!state) throw new Error('The server sent numbers we couldn’t read. Please try again.');
  return { state, cached: out.cached === true };
}
