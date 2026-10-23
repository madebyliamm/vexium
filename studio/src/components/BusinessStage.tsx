import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api/http.ts';
import { getBusinessNumbers, type BusinessNumbers } from '../api/business.ts';
import { getLaunchProject, getPaymentsReady, publishDraft, type LaunchProject } from '../api/launch.ts';
import { readManifest, readReport } from '../lib/build-view.ts';
import {
  DEFAULT_PERIOD, PERIODS, VERDICT_TEXT, activityLines, businessErrorText, dailyChart, dataBanner, dayLabel, deviceRows, extraNotes, formatCount,
  pageRows, periodLabel, planRows, productRows, sourceRows, statCards, CHART_H, CHART_W, type Period, type Row,
} from '../lib/business-view.ts';
import { timeAgo } from '../lib/format.ts';
import { draftIsAhead, launchGate, productCount, publishErrorText, siteAddress } from '../lib/launch-view.ts';
import type { LatestArtifacts, Stage } from '../lib/stages.ts';

interface Props {
  projectId: string;
  artifacts: LatestArtifacts;
  /** A live deploy exists (the project row's published_version is set). */
  published: boolean;
  busy: boolean;
  /** Edit site → 'tweaks'; fix what blocks an update → 'launch'. */
  onMove: (stage: Stage) => void;
  /** Something changed on the server (the live site was updated): re-read the project. */
  onChanged: () => void;
}

/** A tab left open this long gets fresh numbers when the owner comes back to it. */
const STALE_MS = 2 * 60 * 1000;
const TONE_ICON = { good: '✓', info: 'i', watch: '!' } as const;

/**
 * The BUSINESS screen: how the live site is doing — visitors, sales, sign-ups, where people come from — straight from the server's
 * `business_state` (never estimated here), the plan's scenario next to what actually happened, and the two things an owner does next:
 * Edit site (→ TWEAKS) and Update live site (publishes the current draft). No AI in this chunk.
 */
export function BusinessStage({ projectId, artifacts, published, busy, onMove, onChanged }: Props) {
  const alive = useRef(true);
  const seq = useRef(0);
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [numbers, setNumbers] = useState<BusinessNumbers | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ text: string; notLive: boolean } | null>(null);
  const [info, setInfo] = useState<LaunchProject | null>(null);
  const [payments, setPayments] = useState<boolean | null | 'loading'>('loading');
  const [updating, setUpdating] = useState(false);
  const [updatedTo, setUpdatedTo] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const manifestRow = artifacts.manifest ?? null;
  const manifest = manifestRow ? readManifest(manifestRow.data) : null;
  const reportRow = artifacts.launch_checks ?? null;
  const report = reportRow ? readReport(reportRow.data) : null;
  const reportOutdated = !!report && (reportRow?.stale === true || (manifestRow !== null && report.manifest_version !== manifestRow.version));
  const products = manifestRow ? productCount(manifestRow.data) : 0;

  const load = useCallback(async (days: Period, refresh: boolean) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const n = await getBusinessNumbers(projectId, days, refresh);
      if (alive.current && mine === seq.current) { setNumbers(n); setLoadError(null); }
    } catch (e) {
      if (alive.current && mine === seq.current) {
        setLoadError({ text: businessErrorText(e), notLive: e instanceof ApiError && e.status === 409 });
        setNumbers((prev) => (prev && prev.state.period_days === days ? prev : null));
      }
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, [projectId]);

  const loadInfo = useCallback(async () => {
    try {
      const p = await getLaunchProject(projectId);
      if (alive.current) setInfo(p);
    } catch {
      /* the numbers work without it; only Update live site waits for it */
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    void loadInfo();
    return () => { alive.current = false; };
  }, [loadInfo]);

  useEffect(() => { void load(period, false); }, [period, load]);

  // Coming back to an old tab: show today's numbers, not last hour's.
  const computedAt = numbers?.state.computed_at;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !computedAt) return;
      if (Date.now() - Date.parse(computedAt) > STALE_MS) void load(period, false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [computedAt, period, load]);

  // A shop can only be updated while Stripe is connected (the same rule as launching).
  useEffect(() => {
    if (products <= 0) { setPayments(null); return; }
    void getPaymentsReady().then((ok) => { if (alive.current) setPayments(ok); });
  }, [products]);

  const liveSlug = info?.slug ?? '';
  const address = info ? siteAddress({ username: info.username, slug: liveSlug, customDomain: info.customDomain }) : null;
  const gate = launchGate({
    report, reportOutdated, built: manifest !== null, products, slug: liveSlug,
    paymentsConnected: payments === 'loading' ? null : payments, paymentsChecking: payments === 'loading',
  });
  const draftAhead = draftIsAhead({ updatedAt: info?.updatedAt ?? null, publishedAt: info?.publishedAt ?? null });
  const canUpdate = !!info && !!liveSlug && gate.canPublish && !updating && !busy;

  const update = async () => {
    if (!info || !liveSlug) return;
    setUpdating(true);
    setUpdateError(null);
    setUpdatedTo(null);
    try {
      const out = await publishDraft(projectId, liveSlug);
      if (alive.current) setUpdatedTo(out.version);
    } catch (e) {
      if (alive.current) setUpdateError(publishErrorText(e));
    }
    await loadInfo();
    if (alive.current) { setUpdating(false); onChanged(); }
  };

  const state = numbers?.state ?? null;
  const banner = state ? dataBanner(state) : null;
  const cards = state ? statCards(state, { sells: products > 0 }) : [];
  const chart = state ? dailyChart(state.daily) : null;
  const insights = state?.insights ?? [];
  const plan = state ? planRows(state.vs_plan, state.currency ?? 'usd') : [];
  const lists: { id: string; title: string; rows: Row[] }[] = state
    ? [
        { id: 'sources', title: 'Where visitors come from', rows: sourceRows(state) },
        { id: 'pages', title: 'Most visited pages', rows: pageRows(state) },
        { id: 'products', title: 'What sells', rows: productRows(state) },
        { id: 'devices', title: 'Phones and computers', rows: deviceRows(state) },
      ].filter((l) => l.rows.length > 0)
    : [];
  const activity = state ? activityLines(state) : [];
  const notes = state ? extraNotes(state) : [];
  const hovered = chart && hover !== null ? chart.bars[hover] ?? null : null;

  return (
    <div class="biz" data-testid="business-stage" data-level={state?.data_level ?? 'loading'}>
      <section class="biz-bar card" aria-label="Your live site">
        <div class="biz-bar-main">
          <span class={'pill ' + (published ? 'ok' : 'warn')} data-testid="biz-live-pill">{published ? 'Live' : 'Offline'}</span>
          {address ? (
            <a class="live-url" href={address.href} target="_blank" rel="noopener noreferrer" data-testid="biz-url">{address.display}</a>
          ) : (
            <span class="sub">{info ? 'Your site’s address' : 'Getting your address…'}</span>
          )}
        </div>
        <div class="biz-bar-actions">
          <button type="button" class="btn ghost" disabled={busy || updating} data-testid="biz-edit" onClick={() => onMove('tweaks')}>Edit site</button>
          <button type="button" class={'btn' + (draftAhead ? '' : ' ghost')} disabled={!canUpdate} data-testid="biz-update" onClick={() => void update()}>
            {updating ? 'Updating…' : 'Update live site'}
          </button>
        </div>
        {draftAhead && !updating && updatedTo === null && (
          <p class="sub small biz-bar-note" data-testid="biz-changed">You’ve made changes that visitors can’t see yet.</p>
        )}
        {updatedTo !== null && <p class="sub small biz-bar-note ok-text" role="status" data-testid="biz-updated">Version {updatedTo} is live.</p>}
        {draftAhead && !gate.canPublish && !updating && (
          <div class="biz-bar-note" data-testid="biz-blocked">
            <ul class="why-list">{gate.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            <button type="button" class="link-btn" disabled={busy} data-testid="biz-open-launch" onClick={() => onMove('launch')}>Open Launch to sort this out</button>
          </div>
        )}
        {updateError && <div class="error biz-bar-note" role="alert" data-testid="biz-update-error">{updateError}</div>}
      </section>

      <div class="biz-controls">
        <div class="seg" role="group" aria-label="Time range">
          {PERIODS.map((p) => (
            <button key={p} type="button" class={'seg-btn' + (p === period ? ' on' : '')} aria-pressed={p === period} disabled={loading && p !== period} data-testid={`biz-period-${p}`} onClick={() => setPeriod(p)}>
              {periodLabel(p)}
            </button>
          ))}
        </div>
        <div class="biz-refresh">
          {state && <span class="sub small" data-testid="biz-updated-at">Updated {timeAgo(state.computed_at) || 'just now'}</span>}
          <button type="button" class="btn small ghost" disabled={loading} data-testid="biz-refresh" onClick={() => void load(period, true)}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </div>

      {loadError && (
        <div class="error" role="alert" data-testid="biz-error">
          {loadError.text}
          {loadError.notLive && <> <button type="button" class="link-btn" disabled={busy} onClick={() => onMove('launch')}>Go to Launch</button></>}
        </div>
      )}
      {!state && loading && <div class="notice" role="status" data-testid="biz-loading"><span class="spinner inline" aria-hidden="true" /> Getting your numbers…</div>}

      {state && (
        <div class={'biz-body' + (loading ? ' is-loading' : '')} data-testid="biz-body" data-period={state.period_days}>
          {banner && (
            <div class={'notice biz-banner ' + banner.level} role="status" data-testid="biz-banner" data-level={banner.level}>
              <div><b>{banner.title}.</b> {banner.body}</div>
            </div>
          )}

          <ul class="stat-grid" aria-label="Headline numbers" data-testid="biz-stats">
            {cards.map((c) => (
              <li key={c.id} class="stat card" data-testid="biz-stat" data-id={c.id}>
                <span class="stat-label">{c.label}</span>
                <span class="stat-value" data-testid={`biz-stat-${c.id}`}>{c.value}</span>
                {c.change ? (
                  <span class={'stat-change ' + c.change.direction} aria-label={c.change.label} data-testid="biz-change">{c.change.text}</span>
                ) : c.hint ? (
                  <span class="stat-hint">{c.hint}</span>
                ) : <span class="stat-hint" />}
                {c.change && c.hint && <span class="stat-hint">{c.hint}</span>}
              </li>
            ))}
          </ul>

          <section class="card chart-card" aria-label="Visitors each day" data-testid="biz-chart">
            <div class="chart-head">
              <h3>Visitors each day</h3>
              {chart?.peak && <span class="sub small" data-testid="biz-peak">Busiest day: {dayLabel(chart.peak.day)} ({formatCount(chart.peak.value)})</span>}
            </div>
            {chart ? (
              <>
                <div class="chart" onPointerLeave={() => setHover(null)}>
                  <span class="chart-y top">{formatCount(chart.top)}</span>
                  <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={`Bar chart of visitors for each of the last ${chart.bars.length} days, from ${chart.first} to ${chart.last}`}>
                    <line class="grid" x1="0" x2={CHART_W} y1="6" y2="6" />
                    <line class="grid" x1="0" x2={CHART_W} y1={chart.midY} y2={chart.midY} />
                    <line class="base" x1="0" x2={CHART_W} y1={chart.baseY} y2={chart.baseY} />
                    {chart.bars.map((b, i) => (
                      <g key={b.day}>
                        {b.path && <path class={'bar' + (hover === i ? ' on' : '')} d={b.path} />}
                        <rect
                          class="hit" x={b.slotX} y="0" width={b.slotW} height={CHART_H} aria-label={b.label} tabIndex={chart.bars.length <= 31 ? 0 : -1}
                          data-testid="biz-bar" data-value={b.value}
                          onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                        />
                      </g>
                    ))}
                  </svg>
                  {hovered && hover !== null && (
                    <div class="chart-tip" role="status" style={{ left: `${Math.min(88, Math.max(12, ((hovered.slotX + hovered.slotW / 2) / CHART_W) * 100))}%` }} data-testid="biz-tip">
                      <b>{formatCount(hovered.value)}</b> {hovered.value === 1 ? 'visitor' : 'visitors'}<span>{hovered.label.split(' — ')[0]}</span>
                    </div>
                  )}
                </div>
                <div class="chart-x"><span>{chart.first}</span><span>{chart.last}</span></div>
                <details class="redo">
                  <summary>View as a table</summary>
                  <table class="biz-table" data-testid="biz-table">
                    <thead><tr><th scope="col">Day</th><th scope="col">Visitors</th><th scope="col">Page views</th></tr></thead>
                    <tbody>
                      {[...(state.daily ?? [])].reverse().map((d) => (
                        <tr key={d.day}><th scope="row">{d.day}</th><td>{formatCount(d.visitors)}</td><td>{formatCount(d.views)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </>
            ) : (
              <p class="sub" data-testid="biz-chart-empty">No visits in the {periodLabel(period).toLowerCase()} yet. Share your link and they’ll show up here.</p>
            )}
          </section>

          {insights.length > 0 && (
            <section class="card" aria-label="What stands out" data-testid="biz-insights">
              <h3>What stands out</h3>
              <ul class="insights">
                {insights.map((i) => (
                  <li key={i.id} class={'insight ' + i.tone} data-testid="biz-insight" data-id={i.id}>
                    <span class="insight-icon" aria-hidden="true">{TONE_ICON[i.tone]}</span>
                    <span>{i.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plan.length > 0 && (
            <section class="card" aria-label="Your plan and what happened" data-testid="biz-plan">
              <h3>Your plan vs. what happened</h3>
              <p class="sub small">Your plan’s numbers were a scenario, not a promise. “Now” is the last 30 days, scaled to a month.</p>
              <table class="biz-table plan-table">
                <thead><tr><th scope="col" /><th scope="col">Plan</th><th scope="col">Now</th><th scope="col" /></tr></thead>
                <tbody>
                  {plan.map((r) => (
                    <tr key={r.id} data-testid="biz-plan-row" data-id={r.id} data-verdict={r.verdict ?? ''}>
                      <th scope="row">{r.label}</th>
                      <td>{r.planned}</td>
                      <td><b>{r.actual}</b></td>
                      <td>{r.verdict && <span class={'pill ' + (r.verdict === 'behind' ? 'warn' : 'ok')}>{VERDICT_TEXT[r.verdict]}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {lists.length > 0 && (
            <div class="biz-grid">
              {lists.map((l) => (
                <section key={l.id} class="card" aria-label={l.title} data-testid={`biz-list-${l.id}`}>
                  <h3>{l.title}</h3>
                  <ul class="rowbars">
                    {l.rows.map((r) => (
                      <li key={r.key} data-testid="biz-row">
                        <div class="rowbar-line"><span class="rowbar-name">{r.name}</span><span class="rowbar-value">{r.value}{r.note && <span class="rowbar-note"> · {r.note}</span>}</span></div>
                        <div class="rowbar-track" aria-hidden="true"><i style={{ width: `${r.width}%` }} /></div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          {activity.length > 0 && (
            <section class="card" aria-label="Recent activity" data-testid="biz-activity">
              <h3>Recent activity</h3>
              <ul class="activity">
                {activity.map((a) => (
                  <li key={a.key} data-testid="biz-activity-row"><span class="activity-icon" aria-hidden="true">{a.icon}</span><span class="activity-text">{a.text}</span><span class="sub small">{a.when}</span></li>
                ))}
              </ul>
            </section>
          )}

          {notes.length > 0 && (
            <ul class="biz-notes sub small" data-testid="biz-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}
