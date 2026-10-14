import { useEffect, useState } from 'preact/hooks';
import { parseHash, type Location } from './router.ts';

/** Current hash location; re-renders on navigation. */
export function useLocation(): Location {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    onChange(); // the hash may have changed between render and effect
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parseHash(hash);
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('/') ? path : '/' + path;
}
