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
