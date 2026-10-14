import { listMyProjects, type ProjectSummary } from '../api/data.ts';
import { LEGACY } from '../lib/config.ts';
import { timeAgo } from '../lib/format.ts';
import { link } from '../lib/router.ts';
import type { UserInfo } from '../lib/session.ts';
import { useAsync } from '../lib/use-async.ts';

function ProjectCard({ p }: { p: ProjectSummary }) {
  return (
    <a class="card project-card" href={link('/p/:id', { id: p.id })}>
      <div class="row">
        <span class="name">{p.name || 'Untitled'}</span>
        <span class="ico" aria-hidden="true">{p.emoji || '💻'}</span>
      </div>
      <div class="meta">
        {p.published_slug ? <span class="pill live">Live</span> : <span class="pill">Draft</span>}
        <span>{timeAgo(p.updated_at)}</span>
      </div>
    </a>
  );
}

export function Home({ user }: { user: UserInfo }) {
  const projects = useAsync(() => listMyProjects(user.id), [user.id]);
  return (
    <main class="page">
      <div class="page-head">
        <div>
          <h1>Projects</h1>
          <p class="sub">Everything you're building, in one place.</p>
        </div>
        <a class="btn ghost" href={LEGACY.home}>Go to dashboard</a>
      </div>
      {projects.status === 'loading' && (
        <div class="grid" aria-busy="true">
          <div class="sk" /><div class="sk" /><div class="sk" />
        </div>
      )}
      {projects.status === 'error' && <div class="error" role="alert">Couldn't load your projects: {projects.error}</div>}
      {projects.status === 'ready' && projects.data.length === 0 && (
        <div class="notice">No projects yet. Create one from your dashboard and it will show up here.</div>
      )}
      {projects.status === 'ready' && projects.data.length > 0 && (
        <div class="grid" data-testid="project-grid">
          {projects.data.map((p) => <ProjectCard key={p.id} p={p} />)}
        </div>
      )}
    </main>
  );
}
