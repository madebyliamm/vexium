// Session state + the auth guard. Sign-in itself happens on the legacy /auth.html (username → auth-gate → session);
// the studio only needs to know who is signed in and to bounce everyone else there, returning afterwards.
import type { Session } from '@supabase/supabase-js';
import { LEGACY } from './config.ts';
import { createStore } from './store.ts';
import { sb } from './supabase.ts';

export interface UserInfo {
  id: string;
  /** Shown in the UI. Never an email address (usernames are public; emails are not). */
  name: string;
  initial: string;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: UserInfo };

export const sessionStore = createStore<SessionState>({ status: 'loading' });

export function toUserInfo(session: Session): UserInfo {
  const meta = session.user.user_metadata as { username?: unknown } | null;
  const username = typeof meta?.username === 'string' ? meta.username.trim() : '';
  const name = username || 'Account';
  return { id: session.user.id, name, initial: name.charAt(0).toUpperCase() };
}

/** Where /auth.html should send the user back to: the current studio URL, hash included. */
export function signInUrl(here: { pathname: string; search: string; hash: string }): string {
  return `${LEGACY.signIn}?next=${encodeURIComponent(here.pathname + here.search + here.hash)}`;
}

/** Set once the user chose to sign out: the guard must not bounce them to /auth.html on the way to the landing page. */
let leaving = false;

export function redirectToSignIn(): void {
  if (leaving) return;
  window.location.replace(signInUrl(window.location));
}

function apply(session: Session | null): void {
  sessionStore.set(session ? { status: 'signed-in', user: toUserInfo(session) } : { status: 'signed-out' });
}

let started = false;

/** Load the session once and keep the store in sync (token refresh, sign-out in another tab). */
export async function startSession(): Promise<void> {
  if (started) return;
  started = true;
  sb.auth.onAuthStateChange((event, session) => {
    // INITIAL_SESSION is covered by getSession() below; ignoring it avoids a flash of signed-out.
    if (event === 'INITIAL_SESSION') return;
    apply(session);
  });
  const { data } = await sb.auth.getSession();
  apply(data.session);
}

export async function signOut(): Promise<void> {
  leaving = true;
  await sb.auth.signOut();
  window.location.assign(LEGACY.landing);
}
