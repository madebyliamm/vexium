import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { recheckSite } from '../api/build.ts';
import {
  getLaunchProject, getPaymentsReady, isReachable, listDeploys, publishDraft, rollbackTo, startPaymentsSetup, takeOffline, type LaunchProject,
} from '../api/launch.ts';
import { backendSummary, readManifest, readReport, reportView } from '../lib/build-view.ts';
import { LEGACY } from '../lib/config.ts';
import {
  cleanSlug, deployLine, draftIsAhead, launchGate, launchStatus, productCount, publishErrorText, siteAddress, slugFrom, type Deploy,
} from '../lib/launch-view.ts';
import { qrModules, qrPath } from '../lib/qr.ts';
import type { LatestArtifacts } from '../lib/stages.ts';
import { ReportLists } from './ReportLists.tsx';

interface Props {
  projectId: string;
  projectName: string;
  artifacts: LatestArtifacts;
  /** A live deploy exists (the project row's published_version is set). */
  published: boolean;
  busy: boolean;
  /** Something changed on the server (published, rolled back, taken offline, report re-run): re-read the project. */
  onChanged: () => void;
  /** A publish / update / go-back is in flight — the page keeps "Continue" closed until it ends. */
  onWorkingChange: (working: boolean) => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const REACH_TRIES = 10;
const REACH_EVERY_MS = 1500;
const ICONS = { pass: '✓', warn: '!', fail: '✕', todo: '•' } as const;

/**
 * The guided LAUNCH screen: the pre-launch checklist (final check, payments, address), one button that puts the CURRENT draft online
 * through the publisher (a failed publish never changes the live site), then the live address with a QR code, update / go back / take
 * offline, and the way on to BUSINESS.
 */
export function LaunchStage({ projectId, projectName, artifacts, published, busy, onChanged, onWorkingChange }: Props) {
  const alive = useRef(true);
  const [info, setInfo] = useState<LaunchProject | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [payments, setPayments] = useState<boolean | null | 'loading'>('loading');
  const [slugText, setSlugText] = useState<string | null>(null);
  const [working, setWorking] = useState<'publishing' | 'rolling-back' | 'offline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ version: number } | null>(null);
  const [reach, setReach] = useState<'checking' | 'yes' | 'slow'>('yes');
  const [deploys, setDeploys] = useState<Deploy[]>([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmOffline, setConfirmOffline] = useState(false);
  const [stripeBusy, setStripeBusy] = useState(false);

  const manifestRow = artifacts.manifest ?? null;
  const manifest = manifestRow ? readManifest(manifestRow.data) : null;
  const reportRow = artifacts.launch_checks ?? null;
  const report = reportRow ? readReport(reportRow.data) : null;
  const reportOutdated = !!report && (reportRow?.stale === true || (manifestRow !== null && report.manifest_version !== manifestRow.version));
  const products = manifestRow ? productCount(manifestRow.data) : 0;
  const view = report ? reportView(report) : null;

  // The address: a published site keeps its address (the publisher never renames a live site); a new one can be chosen.
  const liveSlug = info?.slug ?? null;
  const slug = liveSlug ?? (slugText ?? slugFrom(info?.name || projectName));
  const address = siteAddress({ username: info?.username ?? null, slug, customDomain: info?.customDomain ?? null });

  const gate = launchGate({
    report, reportOutdated, built: manifest !== null, products, slug,
    paymentsConnected: payments === 'loading' ? null : payments,
    paymentsChecking: payments === 'loading',
  });
  const draftAhead = draftIsAhead({ updatedAt: info?.updatedAt ?? null, publishedAt: info?.publishedAt ?? null });
  const status = launchStatus({ published, publishing: working === 'publishing', canPublish: gate.canPublish, draftAhead });
  const isLive = published && liveSlug !== null;

  const loadInfo = useCallback(async () => {
    try {
      const p = await getLaunchProject(projectId);
      if (alive.current) { setInfo(p); setInfoError(p ? null : 'This project could not be found.'); }
    } catch (e) {
      if (alive.current) setInfoError(message(e));
    }
  }, [projectId]);

  const loadDeploys = useCallback(async (live: number | null) => {
    try {
      const d = await listDeploys(projectId, live);
      if (alive.current) setDeploys(d);
    } catch {
      /* the list is a convenience; the screen works without it */
    }
  }, [projectId]);

  const loadPayments = useCallback(async () => {
    const ok = await getPaymentsReady();
    if (alive.current) setPayments(ok);
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadInfo();
    return () => { alive.current = false; };
  }, [loadInfo]);

  // The shop needs Stripe: look now, and again whenever the owner comes back to this tab from Stripe's page.
  useEffect(() => {
    if (products <= 0) { setPayments(null); return; }
    void loadPayments();
    const onVisible = () => { if (document.visibilityState === 'visible') void loadPayments(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [products, loadPayments]);

  useEffect(() => { void loadDeploys(info?.version ?? null); }, [info?.version, loadDeploys]);
  useEffect(() => { onWorkingChange(working !== null); }, [working, onWorkingChange]);

  /** After a publish: wait (a few seconds at most) until the address answers, so "you're live" is true when we say it. */
  const waitUntilReachable = async (username: string | null) => {
    if (!username || info?.customDomain) { setReach('yes'); return; }
    setReach('checking');
    for (let i = 0; i < REACH_TRIES; i++) {
      if (!alive.current) return;
      if (await isReachable(username)) { setReach('yes'); return; }
      await new Promise((r) => setTimeout(r, REACH_EVERY_MS));
    }
    if (alive.current) setReach('slow');
  };

  const run = async (kind: 'publishing' | 'rolling-back' | 'offline', work: () => Promise<void>) => {
    setWorking(kind);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(publishErrorText(e));
    }
    await loadInfo();
    if (alive.current) { setWorking(null); onChanged(); }
  };

  const publish = () =>
    run('publishing', async () => {
      const out = await publishDraft(projectId, slug);
      if (!alive.current) return;
      setLaunched({ version: out.version });
      setConfirmOffline(false);
      void waitUntilReachable(info?.username ?? null);
    });
  const goBackTo = (version: number) => run('rolling-back', async () => { await rollbackTo(projectId, version); setLaunched(null); });
  const goOffline = () => run('offline', async () => { await takeOffline(projectId); setLaunched(null); setConfirmOffline(false); });

  const recheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await recheckSite(projectId);
      if (alive.current) onChanged();
    } catch (e) {
      if (alive.current) setCheckError(message(e));
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const connectStripe = async () => {
    setStripeBusy(true);
    setError(null);
    try {
      location.assign(await startPaymentsSetup(projectId));
    } catch (e) {
      if (alive.current) { setError(message(e)); setStripeBusy(false); }
    }
  };

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address.href);
      setCopied(true);
      setTimeout(() => alive.current && setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the address is on screen to copy by hand */
    }
  };

  if (infoError && !info) return <div class="error" role="alert" data-testid="launch-load-error">Couldn't load the launch details: {infoError}</div>;
  if (!info) return <div class="notice" role="status" data-testid="launch-loading"><span class="spinner inline" aria-hidden="true" /> Getting your launch checklist…</div>;

  const publishing = working === 'publishing';
  const locked = busy || working !== null;
  const stripeRow = gate.rows.find((r) => r.id === 'payments');
  const backend = manifest ? backendSummary(manifest.backend) : '';
  const qr = isLive && address ? qrModules(address.href) : null;

  return (
    <div class="launch-stage" data-testid="launch-stage" data-status={status}>
      {error && <div class="error" role="alert" data-testid="launch-error">{error}</div>}

      {isLive && address ? (
        <section class={'live-card' + (launched ? ' just-launched' : '')} aria-label="Your live site" data-testid="launch-live">
          {launched && <Confetti />}
          <div class="live-main">
            <span class={'pill ' + (reach === 'yes' ? 'ok' : 'warn')} data-testid="launch-reach" data-reach={reach}>
              {reach === 'checking' ? 'Going live…' : reach === 'slow' ? 'Live — it may take a minute to show everywhere' : 'Live'}
            </span>
            <h3 class="live-title" data-testid="launch-headline">{launched ? "You're live! 🎉" : 'Your site is live'}</h3>
            {launched && <p class="sub" data-testid="launch-launched">Version {launched.version} is online. Share it with the world.</p>}
            <a class="live-url" href={address.href} target="_blank" rel="noopener noreferrer" data-testid="launch-url">{address.display}</a>
            <div class="live-actions">
              <a class="btn" href={address.href} target="_blank" rel="noopener noreferrer" data-testid="launch-open">Open my site</a>
              <button type="button" class="btn ghost" data-testid="launch-copy" onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy link'}</button>
            </div>
          </div>
          {qr && (
            <figure class="qr" data-testid="launch-qr">
              <svg viewBox={`-2 -2 ${qr.length + 4} ${qr.length + 4}`} role="img" aria-label={`QR code for ${address.display}`} shape-rendering="crispEdges">
                <rect x="-2" y="-2" width={qr.length + 4} height={qr.length + 4} fill="#fff" />
                <path d={qrPath(qr)} fill="#111" />
              </svg>
              <figcaption class="sub small">Scan to open on a phone</figcaption>
            </figure>
          )}
        </section>
      ) : (
        <section class="gate-card" aria-label="Before you go live" data-testid="launch-gate">
          <div class="plan-head">
            <h3>{gate.canPublish ? 'Ready to go live' : 'Before you go live'}</h3>
            <button type="button" class="btn small ghost" disabled={checking || locked} data-testid="launch-recheck" onClick={() => void recheck()}>{checking ? 'Checking…' : report ? 'Check again' : 'Check now'}</button>
          </div>
          <ul class="gate" data-testid="launch-checklist">
            {gate.rows.map((r) => (
              <li key={r.id} class={'gate-row ' + r.state} data-testid="gate-row" data-id={r.id} data-state={r.state}>
                <span class="gate-icon" aria-hidden="true">{ICONS[r.state]}</span>
                <span class="gate-text"><b>{r.label}</b><span class="check-detail">{r.detail}</span></span>
              </li>
            ))}
          </ul>
          {checkError && <div class="error" role="alert" data-testid="launch-check-error">{checkError}</div>}
          {stripeRow && stripeRow.state !== 'pass' && (
            <div class="gate-action" data-testid="launch-payments">
              <button type="button" class="btn" disabled={stripeBusy || locked} data-testid="launch-connect-stripe" onClick={() => void connectStripe()}>{stripeBusy ? 'Opening Stripe…' : 'Connect Stripe'}</button>
              <button type="button" class="link-btn" disabled={payments === 'loading'} data-testid="launch-payments-recheck" onClick={() => { setPayments('loading'); void loadPayments(); }}>I've finished — check again</button>
            </div>
          )}
          {view && (view.fails.length > 0 || view.warns.length > 0 || view.openItems.length > 0) && !reportOutdated && (
            <details open={view.fails.length > 0} data-testid="launch-report">
              <summary>See the details</summary>
              <ReportLists view={view} openHeading="Still to add (you can do this after you go live)" />
            </details>
          )}
          {backend && <p class="sub small">Your site includes: {backend}.</p>}
        </section>
      )}

      {!isLive && (
        <section class="card address" aria-label="Your site's address">
          <label class="field">
            <span>Your site's address</span>
            <div class="address-input">
              <span class="address-prefix">{info.username ? `${info.username.toLowerCase()}.vexium.ai/` : 'vexium.ai/'}</span>
              <input
                type="text" inputMode="url" autocomplete="off" spellcheck={false} maxLength={63} value={slug} disabled={locked}
                aria-invalid={!gate.rows.find((r) => r.id === 'address' && r.state === 'pass')} data-testid="launch-slug"
                onInput={(e) => setSlugText(cleanSlug((e.currentTarget as HTMLInputElement).value))}
              />
            </div>
          </label>
          <p class="sub small">Visitors type this to find you. You can connect your own domain (like www.yourbusiness.com) in the{' '}
            <a class="link" href={LEGACY.editor(projectId)}>editor's publish settings</a>.</p>
        </section>
      )}

      {!isLive && (
        <div class="launch-go">
          <button type="button" class="btn big" disabled={!gate.canPublish || locked} data-testid="launch-publish" onClick={() => void publish()}>
            {publishing ? 'Putting your site online…' : 'Launch my site 🚀'}
          </button>
          {publishing && <span class="spinner inline" aria-hidden="true" />}
          {!gate.canPublish && !publishing && (
            <ul class="why-list" data-testid="launch-why">{gate.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          )}
        </div>
      )}

      {isLive && (
        <>
          {draftAhead && (
            <div class="notice" role="status" data-testid="launch-changed">
              You've made changes since this went live. Visitors still see the version below until you update it.
            </div>
          )}
          <div class="launch-go">
            <button type="button" class={'btn' + (draftAhead ? ' big' : ' ghost')} disabled={!gate.canPublish || locked} data-testid="launch-update" onClick={() => void publish()}>
              {publishing ? 'Updating…' : 'Update live site'}
            </button>
            {publishing && <span class="spinner inline" aria-hidden="true" />}
            <button type="button" class="btn ghost" disabled={checking || locked} data-testid="launch-recheck" onClick={() => void recheck()}>{checking ? 'Checking…' : 'Check my site again'}</button>
            {!gate.canPublish && !publishing && (
              <ul class="why-list" data-testid="launch-why">{gate.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            )}
          </div>
          {checkError && <div class="error" role="alert" data-testid="launch-check-error">{checkError}</div>}

          {deploys.length > 1 && (
            <details class="redo versions" data-testid="launch-versions">
              <summary>Earlier versions ({deploys.length - 1})</summary>
              <ul class="version-list">
                {deploys.map((d) => (
                  <li key={d.version} class={'version' + (d.isLive ? ' current' : '')} data-testid="deploy-row" data-live={d.isLive}>
                    <span class="version-line">{deployLine(d)}</span>
                    {d.isLive ? <span class="pill ok">Live now</span> : (
                      <button type="button" class="btn small ghost" disabled={locked} data-testid={`deploy-back-${d.version}`} onClick={() => void goBackTo(d.version)}>Go back to this</button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p class="sub" data-testid="launch-next">
            <b>What's next:</b> keep an eye on how it's doing. Continue to <b>Business</b> to see visits, sign-ups and sales as they come in.
          </p>
          <div class="offline">
            {!confirmOffline ? (
              <button type="button" class="link-btn danger" disabled={locked} data-testid="launch-offline" onClick={() => setConfirmOffline(true)}>Take my site offline</button>
            ) : (
              <div class="notice" role="alertdialog" aria-label="Take the site offline" data-testid="launch-offline-confirm">
                Visitors will see a "not found" page until you launch again. Your work is kept.
                <button type="button" class="btn small" disabled={locked} data-testid="launch-offline-yes" onClick={() => void goOffline()}>Yes, take it offline</button>
                <button type="button" class="btn small ghost" disabled={locked} onClick={() => setConfirmOffline(false)}>Keep it live</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A short burst of paper for the first launch. Pure CSS (`.confetti` in base.css), switched off for people who asked for less motion. */
function Confetti() {
  return (
    <div class="confetti" aria-hidden="true" data-testid="launch-confetti">
      {Array.from({ length: 28 }, (_, i) => (
        <i key={i} style={{ '--i': String(i), '--x': `${(i * 37) % 100}%`, '--d': `${(i % 7) * 0.12}s`, '--h': String((i * 47) % 360) }} />
      ))}
    </div>
  );
}
