// The files of the example page over Supabase: read the four it is made of, write the ones a style change touches.
// Writes go through the SECURITY DEFINER RPC set_project_files (it merges by name and checks access) — never a whole-row update,
// so a style change can't overwrite pages written elsewhere. Pure logic lives in lib/example-view.ts (unit-tested); this file is I/O.
import { sb } from '../lib/supabase.ts';
import { pickFiles, type ExampleFiles } from '../lib/example-view.ts';

/** index.html, styles.css, site.js and manifest.json of a project (empty strings for the ones that don't exist). null = no such project. */
export async function getExampleFiles(projectId: string): Promise<ExampleFiles | null> {
  const { data, error } = await sb
    .from('projects')
    // The key is quoted: PostgREST rejects a bare key with a dot in it ("index.html").
    .select('html:files->>"index.html",css:files->>"styles.css",js:files->>"site.js",manifest:files->>"manifest.json"')
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const r = data as unknown as Record<string, unknown>;
  return pickFiles({ 'index.html': r.html, 'styles.css': r.css, 'site.js': r.js, 'manifest.json': r.manifest });
}

/** Merge these files into the project (other files are untouched). */
export async function setProjectFiles(projectId: string, files: Record<string, string>): Promise<void> {
  if (Object.keys(files).length === 0) return;
  const { error } = await sb.rpc('set_project_files', { p_project: projectId, p_files: files });
  if (error) throw new Error(error.message);
}
