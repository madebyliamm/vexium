import type { ReportView } from '../lib/build-view.ts';

/** The launch-check report as lists: problems, things worth a look, what is still the owner's to add, and (folded away) what passed.
 *  Shared by the FULL BUILD and LAUNCH screens; the data-testids are the e2e's handles on it. */
export function ReportLists({ view, openHeading = 'Still to do before you launch' }: { view: ReportView; openHeading?: string }) {
  return (
    <>
      {view.fails.length > 0 && (
        <ul class="checks fail" data-testid="report-fails">
          {view.fails.map((c) => <li key={c.id + (c.page ?? '')}><b>{c.label}</b>{c.page && <span class="check-page"> · {c.page}</span>}{c.detail && <span class="check-detail">{c.detail}</span>}</li>)}
        </ul>
      )}
      {view.warns.length > 0 && (
        <ul class="checks warn" data-testid="report-warns">
          {view.warns.map((c) => <li key={c.id + (c.page ?? '')}><b>{c.label}</b>{c.page && <span class="check-page"> · {c.page}</span>}{c.detail && <span class="check-detail">{c.detail}</span>}</li>)}
        </ul>
      )}
      {view.openItems.length > 0 && (
        <div data-testid="report-open">
          <p class="sub small"><b>{openHeading}</b></p>
          <ul class="checks open">{view.openItems.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      )}
      {view.passes.length > 0 && (
        <details data-testid="report-passes">
          <summary>{view.passes.length} {view.passes.length === 1 ? 'check' : 'checks'} passed</summary>
          <ul class="checks pass">{view.passes.map((c) => <li key={c.id + (c.page ?? '')}>{c.label}</li>)}</ul>
        </details>
      )}
    </>
  );
}
