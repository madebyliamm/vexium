// The single Supabase client. It uses supabase-js's default storage key, so the session is shared with the legacy
// pages on the same origin (sign in on /auth.html → signed in here, and the other way round).
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config.ts';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Routes live in the URL hash (#/p/abc); never mistake them for an OAuth/magic-link callback.
    detectSessionInUrl: false,
  },
});
