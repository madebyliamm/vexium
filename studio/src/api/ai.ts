// Typed client for the two AI backends:
//   • build Worker (AI_BUILD_URL) — long streaming builds/edits, SSE
//   • ai-chat edge function (AI_EDGE_URL) — JSON modes (brief, spec, suggest, …); stage endpoints arrive in Step 7
// The event/field names below mirror cf-worker/core.ts + worker.ts and what editor.html sends today — change them there first.
import { AI_BUILD_URL } from '../lib/config.ts';
import { authedFetch, errorFromResponse, type AuthDeps } from './http.ts';
import { SseParser, type SseMessage } from './sse.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | unknown[];
}

/** Body of a streaming build/edit call (same shape editor.html sends). */
export interface BuildRequest {
  messages: ChatMessage[];
  /** Files as the model should see them (large files may be trimmed; shared files styles.css/site.js/manifest.json in full). */
  files: Record<string, string>;
  /** Untrimmed files, only used server-side to apply `<patch>` edits. Never send on a continuation. */
  full_files?: Record<string, string>;
  brief?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  auto_fix?: boolean;
  stream: true;
  main_file: string;
  active_file?: string;
  project_has_real_files?: boolean;
  project_id?: string;
  continuation_mode?: boolean;
  fresh_build_session?: boolean;
  build_category?: string;
}

export type BuildEvent =
  | { type: 'start' }
  | { type: 'build_meta'; category: string }
  | { type: 'delta'; text: string }
  | { type: 'file_start'; name: string; mode?: string }
  | { type: 'file_delta'; text: string }
  /** A finished file. `content` is already decoded to a string. */
  | { type: 'file'; name: string; content: string }
  /** A file cut off mid-way (stream ended / max tokens). `content` is decoded. */
  | { type: 'partial_file'; name: string; content: string }
  | { type: 'patch_failed'; name: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'delete'; name: string }
  | { type: 'message'; message: string }
  | { type: 'suggestions'; items: unknown[] }
  | { type: 'max_tokens_hit' }
  | { type: 'done'; count: number }
  | { type: 'error'; error: string }
  /** An event this client doesn't know yet — surfaced, not dropped, so new server events are visible. */
  | { type: 'unknown'; event: string; data: unknown };

export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function fileContent(d: Record<string, unknown>): string {
  const content = str(d.content);
  return d.encoding === 'base64' ? decodeBase64Utf8(content) : content;
}

/** One SSE message → one typed event. */
export function toBuildEvent(m: SseMessage): BuildEvent {
  let d: Record<string, unknown> = {};
  try {
    const parsed: unknown = m.data ? JSON.parse(m.data) : {};
    if (parsed && typeof parsed === 'object') d = parsed as Record<string, unknown>;
  } catch {
    return { type: 'unknown', event: m.event, data: m.data };
  }
  switch (m.event) {
    case 'start':
      return { type: 'start' };
    case 'build_meta':
      return { type: 'build_meta', category: str(d.category) };
    case 'delta':
      return { type: 'delta', text: str(d.text) };
    case 'file_start':
    case 'output_file_start': // legacy alias still handled by the editor
    case 'patch_start': {
      const mode = str(d.mode);
      return { type: 'file_start', name: str(d.name), ...(mode ? { mode } : {}) };
    }
    case 'file_delta':
      return { type: 'file_delta', text: str(d.text) };
    case 'file':
      return { type: 'file', name: str(d.name), content: fileContent(d) };
    case 'partial_file':
      return { type: 'partial_file', name: str(d.name), content: fileContent(d) };
    case 'patch_failed':
      return { type: 'patch_failed', name: str(d.name) };
    case 'rename':
      return { type: 'rename', from: str(d.from), to: str(d.to) };
    case 'delete':
      return { type: 'delete', name: str(d.name) };
    case 'message':
      return { type: 'message', message: str(d.message) };
    case 'suggestions':
      return { type: 'suggestions', items: Array.isArray(d.items) ? d.items : [] };
    case 'max_tokens_hit':
      return { type: 'max_tokens_hit' };
    case 'done':
      return { type: 'done', count: typeof d.count === 'number' ? d.count : 0 };
    case 'error':
      return { type: 'error', error: str(d.error) || 'Build failed' };
    default:
      return { type: 'unknown', event: m.event, data: d };
  }
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Override the endpoint (tests; or AI_EDGE_URL to bypass the Worker). */
  url?: string;
}

/** POST a build and yield typed events as they arrive. Throws ApiError for HTTP failures before the stream starts. */
export async function* streamBuild(request: BuildRequest, deps: AuthDeps, options: StreamOptions = {}): AsyncGenerator<BuildEvent> {
  const res = await authedFetch(
    options.url ?? AI_BUILD_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    deps,
  );
  if (!res.ok) throw await errorFromResponse(res);
  if (!res.body) throw new Error('The server sent no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const m of parser.push(decoder.decode(value, { stream: true }))) yield toBuildEvent(m);
    }
    for (const m of parser.push(decoder.decode())) yield toBuildEvent(m);
    for (const m of parser.flush()) yield toBuildEvent(m);
  } finally {
    // Consumer stopped early (break / abort): release the connection.
    reader.cancel().catch(() => {});
  }
}

/** What a build produced, folded from its events. */
export interface BuildResult {
  /** Finished files by name (a later file/rename/delete in the same build wins). */
  files: Record<string, string>;
  /** Files cut off mid-way. Present only if the stream ended inside a file. */
  partial: Record<string, string>;
  deleted: string[];
  renamed: { from: string; to: string }[];
  patchFailed: string[];
  /** The final chat message (`message` event). */
  message: string;
  /** Chat text streamed so far (`delta` events) — what to show live; `message` replaces it when the build ends. */
  chat: string;
  category: string;
  suggestions: unknown[];
  /** The server said `done`. false = the stream was cut off (see `error` / `maxTokensHit`). */
  completed: boolean;
  maxTokensHit: boolean;
  error: string | null;
}

export function emptyBuildResult(): BuildResult {
  return {
    files: {},
    partial: {},
    deleted: [],
    renamed: [],
    patchFailed: [],
    message: '',
    chat: '',
    category: '',
    suggestions: [],
    completed: false,
    maxTokensHit: false,
    error: null,
  };
}

export function applyBuildEvent(result: BuildResult, event: BuildEvent): void {
  switch (event.type) {
    case 'build_meta':
      result.category = event.category;
      break;
    case 'delta':
      result.chat += event.text;
      break;
    case 'file':
      result.files[event.name] = event.content;
      delete result.partial[event.name];
      break;
    case 'partial_file':
      result.partial[event.name] = event.content;
      break;
    case 'patch_failed':
      result.patchFailed.push(event.name);
      break;
    case 'rename': {
      const moved = result.files[event.from];
      if (moved !== undefined) {
        result.files[event.to] = moved;
        delete result.files[event.from];
      }
      result.renamed.push({ from: event.from, to: event.to });
      break;
    }
    case 'delete':
      delete result.files[event.name];
      result.deleted.push(event.name);
      break;
    case 'message':
      result.message = event.message;
      break;
    case 'suggestions':
      result.suggestions = event.items;
      break;
    case 'max_tokens_hit':
      result.maxTokensHit = true;
      break;
    case 'done':
      result.completed = true;
      break;
    case 'error':
      result.error = event.error;
      break;
    default:
      break;
  }
}

/** Drain a build stream into a BuildResult, calling `onEvent` for live UI along the way. */
export async function collectBuild(stream: AsyncIterable<BuildEvent>, onEvent?: (event: BuildEvent, result: BuildResult) => void): Promise<BuildResult> {
  const result = emptyBuildResult();
  for await (const event of stream) {
    applyBuildEvent(result, event);
    onEvent?.(event, result);
  }
  return result;
}
