import { useState } from 'preact/hooks';
import { createProject } from '../api/data.ts';
import { navigate } from '../lib/use-route.ts';
import { NOT_SURE_MESSAGE } from '../lib/plan-view.ts';
import { setPendingMessage } from '../lib/pending.ts';
import { link } from '../lib/router.ts';

/** Start a project from an idea: creates it (at the PLAN stage) and opens it with the first message already on its way. */
export function NewProject({ userId }: { userId: string }) {
  const [idea, setIdea] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (firstMessage: string) => {
    if (creating || !firstMessage.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const id = await createProject(userId);
      setPendingMessage(id, firstMessage.trim());
      navigate(link('/p/:id', { id }).slice(1));
    } catch (e) {
      setError(`Couldn't start the project: ${e instanceof Error ? e.message : String(e)}`);
      setCreating(false);
    }
  };

  return (
    <section class="card start" aria-labelledby="start-title" data-testid="new-project">
      <h2 id="start-title">Start something new</h2>
      <p class="sub">Tell me what you want to make — even one sentence is enough. I'll draft a plan you can change.</p>
      <textarea
        rows={2}
        value={idea}
        maxLength={4000}
        disabled={creating}
        placeholder="e.g. A site for my dog-walking business in Austin"
        aria-label="Your idea"
        data-testid="idea-input"
        onInput={(e) => setIdea((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void start(idea);
          }
        }}
      />
      <div class="start-actions">
        <button type="button" class="btn" disabled={creating || !idea.trim()} data-testid="idea-go" onClick={() => void start(idea)}>
          {creating ? 'Starting…' : 'Draft my plan'}
        </button>
        <button type="button" class="link-btn" disabled={creating} data-testid="idea-unsure" onClick={() => void start(NOT_SURE_MESSAGE)}>
          Not sure yet — talk it through
        </button>
      </div>
      {error && <div class="error" role="alert" data-testid="new-project-error">{error}</div>}
    </section>
  );
}
