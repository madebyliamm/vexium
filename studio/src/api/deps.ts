// Wires the pure API clients (http.ts / ai.ts) to the live Supabase session.
import { sb } from '../lib/supabase.ts';
import type { AuthDeps } from './http.ts';

export const authDeps: AuthDeps = {
  async getToken(force) {
    if (force) {
      const { data } = await sb.auth.refreshSession();
      return data.session?.access_token ?? null;
    }
    const { data } = await sb.auth.getSession();
    return data.session?.access_token ?? null;
  },
};
