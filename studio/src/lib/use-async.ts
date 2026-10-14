import { useEffect, useState } from 'preact/hooks';

export type Async<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: T };

/** Run an async loader when `deps` change; ignores results that arrive after a newer run started or after unmount. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): Async<T> & { reload: () => void } {
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load().then(
      (data) => live && setState({ status: 'ready', data }),
      (e: unknown) => live && setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}
