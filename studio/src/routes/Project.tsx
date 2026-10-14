import { getProject } from '../api/data.ts';
import { Splash } from '../components/Splash.tsx';
import { LEGACY } from '../lib/config.ts';
import { useAsync } from '../lib/use-async.ts';

/** The business-creator journey, in order. Stage screens arrive with the stage engine; this page is their frame. */
const STAGES = ['Plan', 'Example', 'Full build', 'Tweaks', 'Launch', 'Business'] as const;

export function Project({ id }: { id: string }) {
  const project = useAsync(() => getProject(id), [id]);
  if (project.status === 'loading') return <Splash />;
  if (project.status === 'error') {
    return <main class="page"><div class="error" role="alert">Couldn't load this project: {project.error}</div></main>;
  }
  if (!project.data) {
    return (
      <main class="page">
        <div class="crumbs"><a href="#/">Projects</a></div>
        <h1>Project not found</h1>
        <p class="sub">It may have been deleted, or you don't have access to it.</p>
      </main>
    );
  }
  const p = project.data;
  return (
    <main class="page">
      <div class="crumbs"><a href="#/">Projects</a> / {p.name || 'Untitled'}</div>
      <div class="page-head">
        <h1>{p.emoji || '💻'} {p.name || 'Untitled'}</h1>
        <a class="btn" href={LEGACY.editor(p.id)}>Open in editor</a>
      </div>
      <div class="stack">
        <ol class="stages" aria-label="Stages" style="list-style:none">
          {STAGES.map((label, i) => (
            <li key={label} class={'stage' + (i === 0 ? ' active' : '')} aria-current={i === 0 ? 'step' : undefined}>
              <span class="n">{i + 1}</span>{label}
            </li>
          ))}
        </ol>
        <div class="card">
          <h2>The guided builder is coming to this page</h2>
          <p class="sub" style="margin-top:8px">Until then, keep building in the editor — everything you make there carries over.</p>
        </div>
      </div>
    </main>
  );
}
