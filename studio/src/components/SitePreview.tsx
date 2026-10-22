import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SitePage } from '../lib/build-view.ts';
import { buildPreviewHtml, pageOfLink, readPreviewMessage } from '../lib/preview.ts';

interface Props {
  projectId: string;
  pages: readonly SitePage[];
  /** Every page's HTML plus styles.css and site.js, by file name. */
  files: Record<string, string>;
  /** The page's own code reported an error. */
  onProblem?: (message: string) => void;
  /** A link led somewhere the preview can't show (a page that doesn't exist, or another site). */
  onMissingPage?: (page: string) => void;
}

/**
 * The built site, page by page, in one sandboxed iframe (`allow-scripts` WITHOUT `allow-same-origin`, like the example preview).
 * A link between two of the site's pages switches the tab, so the owner can click through the site the way a visitor would.
 */
export function SitePreview({ projectId, pages, files, onProblem, onMissingPage }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [page, setPage] = useState(pages[0]?.file ?? 'index.html');
  const [phone, setPhone] = useState(false);
  const names = pages.map((p) => p.file);
  const current = names.includes(page) ? page : (names[0] ?? 'index.html');

  const srcdoc = useMemo(() => buildPreviewHtml({ projectId, page: current, files }), [projectId, current, files]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = readPreviewMessage(e, frame.current?.contentWindow);
      if (!m) return;
      if (m.type === 'error') onProblem?.(m.message);
      else if (m.type === 'navigate') {
        const to = pageOfLink(m.to);
        if (!to) return;
        if (names.includes(to)) setPage(to);
        else onMissingPage?.(to);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [names.join('|'), onProblem, onMissingPage]);

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
          <button type="button" class={'seg-btn' + (!phone ? ' on' : '')} aria-pressed={!phone} data-testid="preview-desktop" onClick={() => setPhone(false)}>Desktop</button>
          <button type="button" class={'seg-btn' + (phone ? ' on' : '')} aria-pressed={phone} data-testid="preview-phone" onClick={() => setPhone(true)}>Phone</button>
        </div>
      </div>
      <div class={'preview-stage' + (phone ? ' phone' : '')}>
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
  );
}
