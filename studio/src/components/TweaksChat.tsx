import { useEffect, useRef } from 'preact/hooks';
import { canRetry, splitLiveReply, type ChatLine } from '../lib/plan-view.ts';
import type { PickedElement } from '../lib/preview.ts';
import { TWEAK_GREETING, TWEAK_MAX, ideasFor, pointedLabel } from '../lib/tweaks-view.ts';

interface Props {
  lines: ChatLine[];
  loaded: boolean;
  /** The reply that is arriving right now (this tab's run), or null. `making`: the AI has started writing the change itself. */
  live: { text: string; making: boolean } | null;
  /** A run started elsewhere (before a refresh / another tab) is still going. */
  resumed: boolean;
  error: string | null;
  picked: PickedElement | null;
  pickOn: boolean;
  /** Something has to be settled before a change can be made (a stale plan or style): the box and the pointer are off. */
  blocked: boolean;
  onPickToggle: () => void;
  onClearPicked: () => void;
  text: string;
  onText: (text: string) => void;
  onSend: () => void;
  onRetry: () => void;
  onStop: () => void;
}

/** The TWEAKS conversation: point at something on the page, say what to change, watch the answer arrive. */
export function TweaksChat({ lines, loaded, live, resumed, error, picked, pickOn, blocked, onPickToggle, onClearPicked, text, onText, onSend, onRetry, onStop }: Props) {
  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const running = live !== null || resumed;
  const off = running || blocked;
  const liveView = live ? splitLiveReply(live.text) : null;

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, live?.text, live?.making, error]);

  const submit = () => {
    if (!off && text.trim()) onSend();
  };
  const idea = (s: string) => {
    onText(s);
    box.current?.focus();
  };

  return (
    <section class="card chat tweaks-chat" aria-label="Change your site" data-testid="tweaks-chat">
      <h2>Change your site</h2>
      <div class="chat-log" ref={log} role="log" aria-live="polite" aria-busy={running} data-testid="chat-log">
        {!loaded && lines.length === 0 && <div class="sk chat-sk" aria-hidden="true" />}
        {loaded && lines.length === 0 && !live && <div class="bubble assistant" data-testid="tweaks-greeting">{TWEAK_GREETING}</div>}
        {lines.map((l) => (
          <div key={l.id} class={'bubble ' + l.role} data-testid="chat-line" data-role={l.role}>{l.content}</div>
        ))}
        {liveView && (
          <>
            {liveView.chat && <div class="bubble assistant" data-testid="chat-live">{liveView.chat}</div>}
            <div class="working" data-testid="tweaks-working"><span class="spinner inline" aria-hidden="true" /> {live?.making ? 'Making the change…' : 'Thinking…'}</div>
          </>
        )}
        {resumed && !live && <div class="working" data-testid="tweaks-resumed"><span class="spinner inline" aria-hidden="true" /> Still making your change…</div>}
        {error && <div class="error chat-error" role="alert" data-testid="chat-error">{error}</div>}
        {!running && canRetry(lines) && (
          <div class="retry">
            <span class="sub">No answer to this yet.</span>
            <button type="button" class="btn small" data-testid="chat-retry" onClick={onRetry}>Try again</button>
          </div>
        )}
      </div>

      <div class="pointing" data-testid="tweaks-pointing">
        {picked ? (
          <span class="pointed" data-testid="tweaks-pointed" data-tag={picked.tag} data-page={picked.page}>
            <span class="pointed-label">Changing: <b>{pointedLabel(picked)}</b></span>
            <button type="button" class="pointed-x" aria-label="Stop pointing at this" data-testid="tweaks-unpick" disabled={running} onClick={onClearPicked}>✕</button>
          </span>
        ) : (
          <span class="sub small" data-testid="tweaks-nothing-picked">{pickOn ? 'Click the thing you want to change on the page…' : 'Nothing picked — your request applies to the whole site.'}</span>
        )}
        <button type="button" class={'btn small ' + (pickOn ? '' : 'ghost')} aria-pressed={pickOn} disabled={off} data-testid="tweaks-pick" onClick={onPickToggle}>
          {pickOn ? 'Cancel' : picked ? 'Pick something else' : 'Point at something'}
        </button>
      </div>

      {!off && (
        <div class="chips" aria-label="Ideas" data-testid="tweaks-ideas">
          {ideasFor(picked).map((s) => <button key={s} type="button" class="chip" data-testid="tweaks-idea" onClick={() => idea(s)}>{s}</button>)}
        </div>
      )}

      <div class="composer">
        <textarea
          ref={box}
          rows={3}
          value={text}
          disabled={off}
          maxLength={TWEAK_MAX}
          placeholder={picked ? 'What should change about this?' : 'What should change?'}
          aria-label="What should change"
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
            <button type="button" class="btn" disabled={off || !text.trim()} data-testid="chat-send" onClick={submit}>Make the change</button>
          )}
        </div>
      </div>
    </section>
  );
}
