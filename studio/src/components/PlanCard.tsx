import { useEffect, useState } from 'preact/hooks';
import type { Plan, PricingItem } from '../types/artifacts.ts';
import {
  CHECKLIST_TYPES, PRICING_MODELS, addChecklistItem, addPage, addPriceItem, centsToInput, cleanFileName, formatMoney, inputToCents, parseNameList,
  removeChecklistItem, removePage, removePriceItem, scenarioMonthlyCents, setAuth, setBackendList, setNotes, setPricingModel, setScenario, setText,
  startScenario, toggleChecklistItem, updatePage, updatePriceItem,
} from '../lib/plan-view.ts';

interface Props {
  plan: Plan;
  /** A run is changing the plan: show it, don't let it be edited. */
  locked: boolean;
  onEdit: (next: Plan) => void;
}

/** A price typed as "12.99". Keeps what is being typed (so "12." survives) and only reports amounts that make sense. */
function MoneyInput({ cents, label, testid, onCents }: { cents: number; label: string; testid?: string; onCents: (c: number) => void }) {
  const [text, setTextValue] = useState(() => centsToInput(cents));
  const valid = inputToCents(text) !== null;
  useEffect(() => {
    if (inputToCents(text) !== cents) setTextValue(centsToInput(cents));
  }, [cents]);
  return (
    <input
      inputMode="decimal"
      value={text}
      aria-label={label}
      aria-invalid={!valid}
      data-testid={testid}
      onInput={(e) => {
        const v = (e.currentTarget as HTMLInputElement).value;
        setTextValue(v);
        const c = inputToCents(v);
        if (c !== null) onCents(c);
      }}
      onBlur={() => setTextValue(centsToInput(cents))}
    />
  );
}

/** A comma-separated list of names ("contact, newsletter"). */
function ListInput({ value, label, placeholder, testid, onChange }: { value: string[]; label: string; placeholder: string; testid?: string; onChange: (v: string[]) => void }) {
  const [text, setTextValue] = useState(() => value.join(', '));
  useEffect(() => {
    if (parseNameList(text).join('\u0000') !== value.join('\u0000')) setTextValue(value.join(', '));
  }, [value.join('\u0000')]);
  return (
    <input
      value={text}
      aria-label={label}
      placeholder={placeholder}
      data-testid={testid}
      onInput={(e) => {
        const v = (e.currentTarget as HTMLInputElement).value;
        setTextValue(v);
        onChange(parseNameList(v));
      }}
    />
  );
}

function PriceRow({ item, index, onChange, onRemove }: { item: PricingItem; index: number; onChange: (patch: Partial<PricingItem>) => void; onRemove: () => void }) {
  const n = index + 1;
  return (
    <li class="row price-row" data-testid="price-row">
      <input value={item.name} placeholder="What it is (e.g. Monthly bag)" aria-label={`Price ${n} name`} data-testid="price-name" onInput={(e) => onChange({ name: (e.currentTarget as HTMLInputElement).value })} />
      <MoneyInput cents={item.price_cents} label={`Price ${n} amount`} testid="price-amount" onCents={(c) => onChange({ price_cents: c })} />
      <select
        value={item.interval ?? 'once'}
        aria-label={`Price ${n} is charged`}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          onChange({ interval: v === 'month' || v === 'year' ? v : undefined });
        }}
      >
        <option value="once">once</option>
        <option value="month">per month</option>
        <option value="year">per year</option>
      </select>
      <button type="button" class="icon-btn" aria-label={`Remove price ${n}`} onClick={onRemove}>×</button>
    </li>
  );
}

function Scenario({ plan, onEdit }: { plan: Plan; onEdit: (next: Plan) => void }) {
  const s = plan.scenario;
  const start = startScenario(plan);
  if (!s) {
    return (
      <div class="whatif-empty">
        <p class="sub">Curious what a price could add up to? Try your own numbers — it is a calculator, not a prediction.</p>
        <button type="button" class="btn small ghost" disabled={!start} data-testid="scenario-start" onClick={() => start && onEdit(setScenario(plan, start))}>
          Try a revenue what-if
        </button>
        {!start && <span class="sub"> Add a price above first.</span>}
      </div>
    );
  }
  const monthly = scenarioMonthlyCents(s);
  const num = (v: string): number | null => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? n : null;
  };
  return (
    <div class="whatif" data-testid="scenario">
      <p class="sub">These numbers are guesses you can change — not a promise of what you will earn.</p>
      <div class="whatif-grid">
        <label>
          <span>Price</span>
          <MoneyInput cents={s.price_cents} label="What-if price" testid="scenario-price" onCents={(c) => onEdit(setScenario(plan, { price_cents: c }))} />
        </label>
        <label>
          <span>Visitors per month</span>
          <input type="number" min={0} step={50} value={s.monthly_visitors} data-testid="scenario-visitors" onInput={(e) => { const n = num((e.currentTarget as HTMLInputElement).value); if (n !== null) onEdit(setScenario(plan, { monthly_visitors: n })); }} />
        </label>
        <label>
          <span>Buy or sign up (%)</span>
          <input type="number" min={0} max={100} step={0.5} value={s.conversion_pct} data-testid="scenario-conversion" onInput={(e) => { const n = num((e.currentTarget as HTMLInputElement).value); if (n !== null) onEdit(setScenario(plan, { conversion_pct: n })); }} />
        </label>
      </div>
      <p class="whatif-result" data-testid="scenario-result">
        {s.monthly_visitors.toLocaleString('en-US')} visitors × {s.conversion_pct}% × {formatMoney(s.price_cents)} = <strong>{formatMoney(monthly)}</strong> a month
      </p>
      <button type="button" class="btn small ghost" onClick={() => onEdit(setScenario(plan, null))}>Remove the what-if</button>
    </div>
  );
}

function AddChecklist({ onAdd }: { onAdd: (label: string) => void }) {
  const [label, setLabel] = useState('');
  const add = () => {
    if (!label.trim()) return;
    onAdd(label);
    setLabel('');
  };
  return (
    <div class="row add-row">
      <input
        value={label}
        placeholder="Something only you can provide…"
        aria-label="New checklist item"
        data-testid="checklist-new"
        onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            add();
          }
        }}
      />
      <button type="button" class="btn small ghost" disabled={!label.trim()} data-testid="checklist-add" onClick={add}>Add</button>
    </div>
  );
}

/** The plan as an editable card. Every change is a new draft handed to `onEdit`; saving is the parent's job. */
export function PlanCard({ plan, locked, onEdit }: Props) {
  return (
    <fieldset class="plan-fields" disabled={locked} data-testid="plan-fields">
      <label class="field">
        <span>Name</span>
        <input value={plan.name} maxLength={120} data-testid="plan-name" onInput={(e) => onEdit(setText(plan, 'name', (e.currentTarget as HTMLInputElement).value))} />
      </label>
      <label class="field">
        <span>In one line</span>
        <input value={plan.one_liner} placeholder="What it is, in a sentence" data-testid="plan-oneliner" onInput={(e) => onEdit(setText(plan, 'one_liner', (e.currentTarget as HTMLInputElement).value))} />
      </label>
      <label class="field">
        <span>Who it is for</span>
        <textarea rows={2} value={plan.audience} data-testid="plan-audience" onInput={(e) => onEdit(setText(plan, 'audience', (e.currentTarget as HTMLTextAreaElement).value))} />
      </label>
      <label class="field">
        <span>What you offer</span>
        <textarea rows={2} value={plan.offer} data-testid="plan-offer" onInput={(e) => onEdit(setText(plan, 'offer', (e.currentTarget as HTMLTextAreaElement).value))} />
      </label>

      <div class="field">
        <span>Pricing</span>
        <select value={plan.pricing.model} aria-label="How you charge" data-testid="pricing-model" onChange={(e) => onEdit(setPricingModel(plan, (e.currentTarget as HTMLSelectElement).value as Plan['pricing']['model']))}>
          {PRICING_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {plan.pricing.items.length > 0 && (
          <ul class="rows" aria-label="Prices">
            {plan.pricing.items.map((item, i) => (
              <PriceRow key={i} item={item} index={i} onChange={(patch) => onEdit(updatePriceItem(plan, i, patch))} onRemove={() => onEdit(removePriceItem(plan, i))} />
            ))}
          </ul>
        )}
        <button type="button" class="btn small ghost add" data-testid="price-add" onClick={() => onEdit(addPriceItem(plan))}>Add a price</button>
      </div>

      <div class="field">
        <span>Pages</span>
        <ul class="rows" aria-label="Pages">
          {plan.pages.map((p, i) => (
            <li key={i} class="row page-row" data-testid="page-row">
              <input value={p.title} placeholder="Title" aria-label={`Page ${i + 1} title`} data-testid="page-title" onInput={(e) => onEdit(updatePage(plan, i, { title: (e.currentTarget as HTMLInputElement).value }))} />
              <input
                value={p.file}
                placeholder="file.html"
                aria-label={`Page ${i + 1} file name`}
                data-testid="page-file"
                onInput={(e) => onEdit(updatePage(plan, i, { file: (e.currentTarget as HTMLInputElement).value }))}
                onBlur={(e) => {
                  const clean = cleanFileName((e.currentTarget as HTMLInputElement).value);
                  if (clean && clean !== p.file) onEdit(updatePage(plan, i, { file: clean }));
                }}
              />
              <input class="grow" value={p.purpose} placeholder="What it is for" aria-label={`Page ${i + 1} purpose`} onInput={(e) => onEdit(updatePage(plan, i, { purpose: (e.currentTarget as HTMLInputElement).value }))} />
              <button type="button" class="icon-btn" aria-label={`Remove page ${i + 1}`} onClick={() => onEdit(removePage(plan, i))}>×</button>
            </li>
          ))}
        </ul>
        <button type="button" class="btn small ghost add" data-testid="page-add" onClick={() => onEdit(addPage(plan))}>Add a page</button>
      </div>

      <div class="field">
        <span>What the site needs behind it</span>
        <div class="backend">
          <label><span>Forms</span><ListInput value={plan.backend.forms} label="Forms" placeholder="contact, newsletter" testid="backend-forms" onChange={(v) => onEdit(setBackendList(plan, 'forms', v))} /></label>
          <label><span>Things for sale</span><ListInput value={plan.backend.products} label="Things for sale" placeholder="names you will sell" testid="backend-products" onChange={(v) => onEdit(setBackendList(plan, 'products', v))} /></label>
          <label><span>Data to store</span><ListInput value={plan.backend.collections} label="Data to store" placeholder="e.g. bookings" testid="backend-collections" onChange={(v) => onEdit(setBackendList(plan, 'collections', v))} /></label>
        </div>
        <label class="check">
          <input type="checkbox" checked={plan.backend.auth} data-testid="backend-auth" onChange={(e) => onEdit(setAuth(plan, (e.currentTarget as HTMLInputElement).checked))} />
          <span>Visitors need to sign in</span>
        </label>
      </div>

      <div class="field">
        <span>Only you can supply</span>
        <p class="sub">Photos, prices, your story, legal text… The site is never filled with made-up versions of these.</p>
        {plan.launch_checklist.length > 0 && (
          <ul class="rows" aria-label="Launch checklist">
            {plan.launch_checklist.map((c) => (
              <li key={c.id} class="row check-row" data-testid="checklist-row">
                <label class="check">
                  <input type="checkbox" checked={c.done} aria-label={`${c.label} — done`} onChange={() => onEdit(toggleChecklistItem(plan, c.id))} />
                  <span class={c.done ? 'done' : ''}>{c.label}</span>
                </label>
                <span class="pill">{CHECKLIST_TYPES.find((t) => t.value === c.type)?.label ?? 'Other'}</span>
                <button type="button" class="icon-btn" aria-label={`Remove ${c.label}`} onClick={() => onEdit(removeChecklistItem(plan, c.id))}>×</button>
              </li>
            ))}
          </ul>
        )}
        <AddChecklist onAdd={(label) => onEdit(addChecklistItem(plan, label))} />
      </div>

      <div class="field">
        <span>Revenue what-if</span>
        <Scenario plan={plan} onEdit={onEdit} />
      </div>

      <label class="field">
        <span>Notes</span>
        <textarea rows={2} value={plan.notes ?? ''} maxLength={2000} placeholder="What was assumed, what to double-check" data-testid="plan-notes" onInput={(e) => onEdit(setNotes(plan, (e.currentTarget as HTMLTextAreaElement).value))} />
      </label>
    </fieldset>
  );
}
