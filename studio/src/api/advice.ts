// The AI business partner over the network (REVAMP Step 13, chunk C): one call to the `business-partner` edge function, which reads the
// numbers it saved for this owner (never anything the browser sends) and answers with recommendations. It costs AI credits, so it only
// runs when the owner presses the button. Pure logic (reading and checking the answer, error text) lives in lib/advice-view.ts.
import { SUPABASE_URL } from '../lib/config.ts';
import { readPartnerReply, type PartnerReply } from '../lib/advice-view.ts';
import { authDeps } from './deps.ts';
import { postJson } from './http.ts';

/** Ask for advice on the numbers last opened. Rejects with an ApiError (409 = numbers out of date / not live, 402 = out of credits, 429 = asked too often, 503 = AI unavailable). */
export async function askPartner(projectId: string, signal?: AbortSignal): Promise<PartnerReply> {
  const out = await postJson<unknown>(`${SUPABASE_URL}/functions/v1/business-partner`, { project_id: projectId }, authDeps, signal);
  const reply = readPartnerReply(out);
  if (!reply) throw new Error('The server sent advice we couldn’t read. Please try again.');
  return reply;
}
