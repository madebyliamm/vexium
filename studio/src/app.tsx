import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { Splash } from './components/Splash.tsx';
import { Topbar } from './components/Topbar.tsx';
import { resolveRoute, type Route } from './lib/router.ts';
import { redirectToSignIn, sessionStore, type UserInfo } from './lib/session.ts';
import { useStore } from './lib/use-store.ts';
import { useLocation } from './lib/use-route.ts';
import { Home } from './routes/Home.tsx';
import { NotFound } from './routes/NotFound.tsx';
import { Project } from './routes/Project.tsx';
import { System } from './routes/System.tsx';

type View = (ctx: { user: UserInfo; params: Record<string, string> }) => ComponentChildren;

const ROUTES: Route<View>[] = [
  { pattern: '/', view: ({ user }) => <Home user={user} /> },
  { pattern: '/p/:id', view: ({ params }) => <Project id={params.id ?? ''} /> },
  { pattern: '/system', view: ({ user }) => <System user={user} /> },
];

export function App() {
  const session = useStore(sessionStore);
  const location = useLocation();

  // The auth guard: nobody sees studio UI without a session. They're sent to /auth.html and come back to this URL.
  useEffect(() => {
    if (session.status === 'signed-out') redirectToSignIn();
  }, [session.status]);

  if (session.status !== 'signed-in') return <Splash />;

  const match = resolveRoute(ROUTES, location.path);
  return (
    <>
      <Topbar user={session.user} />
      {match ? match.route.view({ user: session.user, params: match.params }) : <NotFound />}
    </>
  );
}
