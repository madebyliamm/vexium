import { LEGACY } from '../lib/config.ts';
import { signOut, type UserInfo } from '../lib/session.ts';

export function Topbar({ user }: { user: UserInfo }) {
  return (
    <header class="topbar">
      <a class="tb-logo" href="#/" aria-label="Vertly Studio home">
        <img src="/vertly_mark.svg" alt="" />
        <span class="tb-wordmark">Vertly</span>
      </a>
      <span class="tb-tag">Studio</span>
      <span class="tb-spacer" />
      <a class="tb-link" href={LEGACY.home}>Dashboard</a>
      <button class="tb-link" type="button" onClick={() => void signOut()}>Sign out</button>
      <span class="avatar" title={user.name} aria-label={`Signed in as ${user.name}`}>{user.initial}</span>
    </header>
  );
}
