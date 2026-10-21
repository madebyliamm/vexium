import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { filesToMap, type ExampleFiles } from '../lib/example-view.ts';
import { CSS_MESSAGE, buildPreviewHtml, pageOfLink, readPreviewMessage } from '../lib/preview.ts';

interface Props {
  projectId: string;
  /** The page's files. The page is rebuilt when its HTML or script changes. */
  files: ExampleFiles;
  /** The stylesheet to show (the saved one with the draft vibe applied). Changing it re-skins the page in place — no reload. */
  css: string;
  /** The page's own code reported an error. */
  onProblem?: (message: string) => void;
  /** A link to another page was clicked (those pages are built later). */
  onOtherPage?: (page: string) => void;
}

/**
 * The live preview: the example page in a sandboxed iframe. `allow-scripts` WITHOUT `allow-same-origin` — the model's JavaScript
 * runs in a null origin, so it can never read the studio's session or call the studio's APIs as the user.
 */
export function Preview({ projectId, files, css, onProblem, onOtherPage }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const cssNow = useRef(css);
  cssNow.current = css;
  const loaded = useRef(false);
  const [phone, setPhone] = useState(false);

  // The document is rebuilt only when the page itself changes; style changes go in through the message below.
  const srcdoc = useMemo(
    () => buildPreviewHtml({ projectId, page: 'index.html', files: filesToMap(files), css: cssNow.current }),
    [projectId, files.html, files.js],
  );

  const push = () => frame.current?.contentWindow?.postMessage({ type: CSS_MESSAGE, css: cssNow.current }, '*');

  useEffect(() => {
    if (loaded.current) push();
  }, [css]);

  useEffect(() => {
    loaded.current = false;
  }, [srcdoc]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = readPreviewMessage(e, frame.current?.contentWindow);
      if (!m) return;
      if (m.type === 'error') onProblem?.(m.message);
      else if (m.type === 'navigate') {
        const page = pageOfLink(m.to);
        if (page) onOtherPage?.(page);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onProblem, onOtherPage]);

  return (
    <div class="preview" data-testid="preview">
      <div class="preview-bar">
        <div class="seg" role="group" aria-label="Preview size">
          <button type="button" class={'seg-btn' + (!phone ? ' on' : '')} aria-pressed={!phone} data-testid="preview-desktop" onClick={() => setPhone(false)}>Desktop</button>
          <button type="button" class={'seg-btn' + (phone ? ' on' : '')} aria-pressed={phone} data-testid="preview-phone" onClick={() => setPhone(true)}>Phone</button>
        </div>
      </div>
      <div class={'preview-stage' + (phone ? ' phone' : '')}>
        <iframe
          ref={frame}
          title="Preview of your landing page"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          srcDoc={srcdoc}
          data-testid="preview-frame"
          onLoad={() => {
            loaded.current = true;
            push(); // the draft may have changed while the page was loading
          }}
        />
      </div>
    </div>
  );
}
