import { useEffect, useRef } from 'preact/hooks';
import { GREETING, canRetry, splitLiveReply, type ChatLine } from '../lib/plan-view.ts';

interface Props {
  lines: ChatLine[];
  loaded: boolean;
  /** The reply that is arriving right now (this tab's run), or null. */
  live: { text: string } | null;
  /** A run started elsewhere (before a refresh / another tab) is still going: the plan will change when it ends. */
  resumed: boolean;
  error: string | null;
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  onRetry: () => void;
  onStop: () => void;
}

/** The PLAN conversation: the saved history, the reply streaming in, and the box to answer in. */
export function PlanChat({ lines, loaded, live, resumed, error, text, onText, onSend, onRetry, onStop }: Props) {
  const log = useRef<HTMLDivElement>(null);
  const running = live !== null || resumed;
  const liveView = live ? splitLiveReply(live.text) : null;

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, live?.text, error]);

  const submit = () => {
    if (!running && text.trim()) onSend();
  };

  return (
    <section class="card chat" aria-label="Talk it through" data-testid="plan-chat">
      <h2>Talk it through</h2>
      <div class="chat-log" ref={log} role="log" aria-live="polite" aria-busy={running} data-testid="chat-log">
        {!loaded && lines.length === 0 && <div class="sk chat-sk" aria-hidden="true" />}
        {loaded && lines.length === 0 && !live && (
          <div class="bubble assistant" data-testid="chat-greeting">{GREETING}</div>
        )}
        {lines.map((l) => (
          <div key={l.id} class={'bubble ' + l.role} data-testid="chat-line" data-role={l.role}>{l.content}</div>
        ))}
        {liveView && (
          <>
            {liveView.chat && <div class="bubble assistant" data-testid="chat-live">{liveView.chat}</div>}
            <div class="working" data-testid="plan-updating"><span class="spinner inline" aria-hidden="true" /> {liveView.updating ? 'Updating your plan…' : 'Thinking…'}</div>
          </>
        )}
        {resumed && !live && (
          <div class="working" data-testid="plan-resumed"><span class="spinner inline" aria-hidden="true" /> Still working on your plan…</div>
        )}
        {error && <div class="error chat-error" role="alert" data-testid="chat-error">{error}</div>}
        {!running && canRetry(lines) && (
          <div class="retry">
            <span class="sub">No answer to this yet.</span>
            <button type="button" class="btn small" data-testid="chat-retry" onClick={onRetry}>Try again</button>
          </div>
        )}
      </div>
      <div class="composer">
        <textarea
          rows={3}
          value={text}
          disabled={running}
          maxLength={4000}
          placeholder={lines.length === 0 ? 'e.g. A site for my dog-walking business in Austin' : 'Answer, or ask for a change…'}
          aria-label="Your message"
          data-testid="chat-input"
          onInput={(e) => onText((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div class="composer-actions">
          {live ? (
            <button type="button" class="btn ghost" data-testid="chat-stop" onClick={onStop}>Stop</button>
          ) : (
            <button type="button" class="btn" disabled={running || !text.trim()} data-testid="chat-send" onClick={submit}>Send</button>
          )}
        </div>
      </div>
    </section>
  );
}
