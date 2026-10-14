// A tiny observable store: no dependency, framework-free (so it is unit-testable), consumed by useStore().

export type Listener<T> = (value: T, previous: T) => void;

export interface Store<T> {
  get(): T;
  /** Replace the value, or derive it from the previous one. Listeners run only when the value actually changed. */
  set(next: T | ((previous: T) => T)): void;
  subscribe(listener: Listener<T>): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<Listener<T>>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      const previous = value;
      value = resolved;
      // Copy so a listener that unsubscribes (or subscribes) while we iterate can't skip or double-fire another.
      for (const listener of [...listeners]) listener(value, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
