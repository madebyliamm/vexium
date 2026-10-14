import { useEffect, useState } from 'preact/hooks';
import { authDeps } from '../api/deps.ts';
import { getMyBilling } from '../api/data.ts';
import { runChecks, type Check } from '../api/system.ts';
import type { UserInfo } from '../lib/session.ts';
import { useAsync } from '../lib/use-async.ts';

/** Diagnostics: who you're signed in as, your plan, and whether every backend answers from this origin. Not linked in the nav. */
export function System({ user }: { user: UserInfo }) {
  const billing = useAsync(() => getMyBilling(user.id), [user.id]);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [run, setRun] = useState(0);
  useEffect(() => {
    let live = true;
    setChecks(null);
    void runChecks(authDeps).then((c) => live && setChecks(c));
    return () => {
      live = false;
    };
  }, [run]);

  return (
    <main class="page">
      <div class="crumbs"><a href="#/">Projects</a> / System</div>
      <div class="page-head">
        <h1>System</h1>
        <button class="btn ghost" type="button" onClick={() => setRun((n) => n + 1)}>Run checks again</button>
      </div>
      <div class="stack">
        <section class="card" aria-label="Account">
          <h2>Account</h2>
          <p class="sub" style="margin-top:8px" data-testid="account">
            Signed in as <b>{user.name}</b>
            {billing.status === 'ready' && billing.data ? ` · ${billing.data.plan} plan` : ''}
          </p>
        </section>
        <section class="card" aria-label="Connectivity">
          <h2>Connectivity</h2>
          <div class="checks" style="margin-top:8px" data-testid="checks" aria-busy={checks === null}>
            {checks === null && <div class="check"><span class="dot" />Running checks…</div>}
            {checks?.map((c) => (
              <div class="check" key={c.name}>
                <span class={'dot ' + (c.ok ? 'ok' : 'bad')} />
                {c.name}
                <span class="detail">{c.detail} · {c.ms} ms</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
