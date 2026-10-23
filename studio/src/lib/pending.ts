// The first message of a brand-new project, handed from the Home screen ("Draft my plan") to the PLAN screen that sends it.
// In memory on purpose: a page refresh in between simply shows the empty chat — nothing is lost, the text was never sent.
import { createStore } from './store.ts';

export interface PendingMessage {
  projectId: string;
  text: string;
}

const pending = createStore<PendingMessage | null>(null);

export function setPendingMessage(projectId: string, text: string): void {
  pending.set({ projectId, text });
}

/** Take the message waiting for this project (once). Another project's message stays where it is. */
export function takePendingMessage(projectId: string): string | null {
  const p = pending.get();
  if (!p || p.projectId !== projectId) return null;
  pending.set(null);
  return p.text;
}

// ── a change the business partner suggested ("Apply" on the BUSINESS screen) ────────────────────────────────────────────────────
// Handed to the TWEAKS screen, which sends it as the owner's own message the moment its chat is ready. In memory, taken once, and it
// expires: an instruction the owner never saw go out must not fire minutes later.

export interface PendingTweak {
  projectId: string;
  text: string;
  at: number;
}

/** Long enough to cross one screen change, short enough that a forgotten one is dropped. */
export const TWEAK_MAX_AGE_MS = 2 * 60 * 1000;

const pendingTweak = createStore<PendingTweak | null>(null);

export function setPendingTweak(projectId: string, text: string, now: number = Date.now()): void {
  pendingTweak.set({ projectId, text, at: now });
}

/** Take the instruction waiting for this project (once). Another project's, and an expired one, are not handed out. */
export function takePendingTweak(projectId: string, now: number = Date.now()): string | null {
  const p = pendingTweak.get();
  if (!p || p.projectId !== projectId) return null;
  pendingTweak.set(null);
  return now - p.at <= TWEAK_MAX_AGE_MS ? p.text : null;
}
