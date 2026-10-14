import { useEffect, useState } from 'preact/hooks';
import type { Store } from './store.ts';

/** Subscribe a component to a store (optionally to a slice of it; re-renders only when the slice changes). */
export function useStore<T, S = T>(store: Store<T>, select: (value: T) => S = (value) => value as unknown as S): S {
  const [slice, setSlice] = useState<S>(() => select(store.get()));
  useEffect(() => {
    // The value may have changed between the first render and this effect.
    setSlice(() => select(store.get()));
    return store.subscribe((value) => setSlice(() => select(value)));
  }, [store]); // `select` is expected to be a stable, pure function of the store value
  return slice;
}
