import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SitePage } from '../lib/build-view.ts';
import { buildPreviewHtml, pageOfLink, PICK_MESSAGE, readPreviewMessage, UNPICK_MESSAGE, type PickedElement } from '../lib/preview.ts';
import { DEVICES, fitScale, type Device } from '../lib/tweaks-view.ts';

interface Props {
  projectId: string;
  pages: readonly SitePage[];
  /** Every page's HTML plus styles.css and site.js, by file name. */
  files: Record<string, string>;
  /** The page's own code reported an error. */
  onProblem?: (message: string) => void;
  /** A link led somewhere the preview can't show (a page that doesn't exist, or another site). */
  onMissingPage?: (page: string) => void;
  /** Pick mode: a click on the page chooses the element under it (and does nothing else) instead of following links and pressing buttons. */
  pick?: boolean;
  onPick?: (element: PickedElement) => void;
  /** The element that is chosen right now; null removes the mark from the page. */
  picked?: PickedElement | null;
  /** The page on show changed (a tab, or a link inside the site). */
  onPageChange?: (page: string) => void;
}

/**
 * The built site, page by page, in one sandboxed iframe (`allow-scripts` WITHOUT `allow-same-origin`, like the example preview).
 * A link between two of the site's pages switches the tab, so the owner can click through the site the way a visitor would.
 */
export function SitePreview({ projectId, pages, files, onProblem, onMissingPage, pick = false, onPick, picked, onPageChange }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [page, setPage] = useState(pages[0]?.file ?? 'index.html');
  const [device, setDevice] = useState<Device>('desktop');
  const names = pages.map((p) => p.file);
  const current = names.includes(page) ? page : (names[0] ?? 'index.html');
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const srcdoc = useMemo(() => buildPreviewHtml({ projectId, page: current, files }), [projectId, current, files]);

  /** The page only listens to the studio; its origin is null, so the target origin can only be '*'. */
  const tell = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, '*');

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = readPreviewMessage(e, frame.current?.contentWindow);
      if (!m) return;
      if (m.type === 'error') onProblem?.(m.message);
      else if (m.type === 'ready') tell({ type: PICK_MESSAGE, on: pickRef.current });
      else if (m.type === 'pick') onPick?.({ page: m.page, selector: m.selector, tag: m.tag, text: m.text, html: m.html });
      else if (m.type === 'navigate') {
        const to = pageOfLink(m.to);
        if (!to) return;
        if (names.includes(to)) setPage(to);
        else onMissingPage?.(to);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [names.join('|'), onProblem, onMissingPage, onPick]);

  useEffect(() => tell({ type: PICK_MESSAGE, on: pick }), [pick]);
  useEffect(() => {
    if (picked === null) tell({ type: UNPICK_MESSAGE });
  }, [picked]);
  useEffect(() => onPageChange?.(current), [current]);

  // A tablet or phone frame shows the page at its true width (so its media queries answer as on the device) and is scaled down to fit.
  const outer = DEVICES.find((d) => d.id === device)?.outer ?? null;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setFit(fitScale(el.clientWidth, outer));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [outer]);

  return (
    <div class="preview" data-testid="site-preview">
      <div class="preview-bar spread">
        <div class="tabs" role="tablist" aria-label="Pages of your site">
          {pages.map((p) => (
            <button
              key={p.file}
              type="button"
              role="tab"
              class={'tab' + (p.file === current ? ' on' : '')}
              aria-selected={p.file === current}
              data-testid="site-tab"
              data-page={p.file}
              onClick={() => setPage(p.file)}
            >
              {p.title}
            </button>
          ))}
        </div>
        <div class="seg" role="group" aria-label="Preview size">
          {DEVICES.map((d) => (
            <button key={d.id} type="button" class={'seg-btn' + (device === d.id ? ' on' : '')} aria-pressed={device === d.id} data-testid={`preview-${d.id}`} onClick={() => setDevice(d.id)}>{d.label}</button>
          ))}
        </div>
      </div>
      <div ref={stage} class={'preview-stage ' + device + (pick ? ' picking' : '')} data-device={device} data-picking={pick}>
        <div class="device" style={fit < 1 ? { zoom: fit } : undefined} data-fit={fit}>
          <iframe
            ref={frame}
            title={`Preview of ${pages.find((p) => p.file === current)?.title ?? 'your site'}`}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            srcDoc={srcdoc}
            data-testid="site-frame"
            data-page={current}
          />
        </div>
      </div>
    </div>
  );
}
