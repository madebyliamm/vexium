// A realistic BUILT site for the TWEAKS tests: the plan, the locked style the EXAMPLE stage would have saved, and the files and manifest
// FULL BUILD would have committed (the assembler's own output), plus an uploaded image.
import { emptyPlan, type Plan, type StyleSpec } from '../functions/_shared/artifacts.ts';
import { applyPut, type ArtifactKind, type LatestArtifacts } from '../functions/_shared/stages.ts';
import { applyStyleSpec, deriveStyleSpec } from '../functions/_shared/style.ts';
import { manifestFor } from '../functions/ai-chat/build-handler.ts';
import { planBuild } from '../functions/ai-chat/build-plan.ts';
import { assembleSite } from '../functions/ai-chat/site-derive.ts';
import { CONTACT, EXAMPLE_CSS, HOME, SHOP, STYLE } from './site_fixtures.ts';

export const PLAN: Plan = {
  ...emptyPlan('Wick & Co'),
  one_liner: 'Hand-poured candles',
  pages: [{ file: 'index.html', title: 'Home', purpose: 'Introduce the candles' }, { file: 'shop.html', title: 'Shop', purpose: 'Buy a candle' }, { file: 'contact.html', title: 'Contact', purpose: 'Get in touch' }],
  pricing: { model: 'one_time', items: [{ name: 'Candle', price_cents: 2400 }] },
  backend: { collections: [], products: ['candle'], forms: ['contact'], auth: false },
  launch_checklist: [{ id: 'photos', label: 'Real product photos', type: 'photo', done: false }],
};
export const PAGES: Record<string, string> = { 'index.html': HOME, 'shop.html': SHOP, 'contact.html': CONTACT };

/** The style as the EXAMPLE stage saves it: read back out of the stylesheet (so it carries every token the stylesheet has), then locked. */
export const FULL_STYLE: StyleSpec = { ...deriveStyleSpec(applyStyleSpec(EXAMPLE_CSS, STYLE), { tone: STYLE.vibe.tone }).spec, locked: true };
export const styleOf = (css: string, locked = true): StyleSpec => ({ ...deriveStyleSpec(css, { tone: STYLE.vibe.tone }).spec, locked });

/** A real built site: what FULL BUILD would have committed (the assembler's output), plus an uploaded image. */
export function builtSite(pages: Record<string, string> = PAGES): { files: Record<string, string>; manifest: Record<string, unknown> } {
  const spec = planBuild(PLAN);
  const a = assembleSite({ plan: PLAN, spec, style: FULL_STYLE, projectFiles: { 'styles.css': EXAMPLE_CSS }, pages });
  return { files: { ...a.files, 'logo.png': 'binary' }, manifest: manifestFor(PLAN, spec, a.backendSummary, 0) as unknown as Record<string, unknown> };
}
export const latestOf = (manifest: Record<string, unknown>, locked = true): LatestArtifacts =>
  [['plan', PLAN], ['style_spec', { ...FULL_STYLE, locked }], ['manifest', manifest]].reduce((l, [k, d]) => applyPut(l, k as ArtifactKind, d as Record<string, unknown>).latest, {} as LatestArtifacts);

