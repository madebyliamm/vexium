import { ACCENTS, DENSITIES, FONT_PAIRINGS, TONES, type VibeChange } from '../lib/style.ts';
import { THEMES, controlsView } from '../lib/example-view.ts';
import type { StyleSpec } from '../types/artifacts.ts';

interface Props {
  spec: StyleSpec;
  /** Controls are shut (the page is being built, or the style is locked). */
  disabled: boolean;
  onChange: (change: VibeChange) => void;
}

/** The five vibe controls. Each is a pure token swap (lib/style.ts withVibe) — choosing never calls the AI. */
export function VibeControls({ spec, disabled, onChange }: Props) {
  const v = controlsView(spec);
  return (
    <div class="vibe" data-testid="vibe-controls" aria-disabled={disabled}>
      <fieldset class="vibe-group" disabled={disabled}>
        <legend>Theme</legend>
        <div class="seg" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button type="button" key={t.id} class={'seg-btn' + (v.theme === t.id ? ' on' : '')} aria-pressed={v.theme === t.id} data-testid={`vibe-theme-${t.id}`} onClick={() => onChange({ theme: t.id })}>
              {t.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset class="vibe-group" disabled={disabled}>
        <legend>Colour</legend>
        <div class="swatches">
          {ACCENTS.map((a) => (
            <button
              type="button"
              key={a.id}
              class={'swatch' + (v.accentId === a.id ? ' on' : '')}
              style={{ background: a.hex }}
              title={a.label}
              aria-label={a.label}
              aria-pressed={v.accentId === a.id}
              data-testid={`vibe-accent-${a.id}`}
              onClick={() => onChange({ accent: a.hex })}
            />
          ))}
          <label class={'swatch custom' + (v.accentId === null ? ' on' : '')} title="Pick your own colour">
            <span class="sr-only">Your own colour</span>
            <input type="color" value={v.accent || '#7c3aed'} data-testid="vibe-accent-custom" onInput={(e) => onChange({ accent: (e.currentTarget as HTMLInputElement).value })} />
          </label>
        </div>
      </fieldset>

      <fieldset class="vibe-group" disabled={disabled}>
        <legend>Fonts</legend>
        <div class="choices">
          {FONT_PAIRINGS.map((p) => (
            <button type="button" key={p.id} class={'choice' + (v.pairing === p.id ? ' on' : '')} aria-pressed={v.pairing === p.id} data-testid={`vibe-pairing-${p.id}`} onClick={() => onChange({ pairing: p.id })}>
              <b>{p.label}</b>
              <span>{p.note}</span>
            </button>
          ))}
        </div>
        {v.pairing === null && <p class="sub small" data-testid="vibe-pairing-own">Now using the fonts your page came with.</p>}
      </fieldset>

      <fieldset class="vibe-group" disabled={disabled}>
        <legend>Spacing</legend>
        <div class="seg" role="group" aria-label="Spacing">
          {DENSITIES.map((d) => (
            <button type="button" key={d.id} class={'seg-btn' + (v.density === d.id ? ' on' : '')} aria-pressed={v.density === d.id} data-testid={`vibe-density-${d.id}`} onClick={() => onChange({ density: d.id })}>
              {d.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset class="vibe-group" disabled={disabled}>
        <legend>Tone</legend>
        <div class="chips">
          {TONES.map((t) => (
            <button type="button" key={t.id} class={'chip' + (v.tone === t.id ? ' on' : '')} aria-pressed={v.tone === t.id} data-testid={`vibe-tone-${t.id}`} onClick={() => onChange({ tone: t.id })}>
              {t.label}
            </button>
          ))}
        </div>
        {v.tone === null && <p class="sub small" data-testid="vibe-tone-own">Now using the tone your page came with.</p>}
      </fieldset>
    </div>
  );
}
