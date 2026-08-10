// ───────────────────────────────────────────────────────────────────────────
// AUTO-EXTRACTED (byte-exact) from supabase/functions/ai-chat/index.ts.
// Pure parser/stream/patch/usage logic shared with the edge function. Do not hand-edit —
// re-extract from the source so the Worker and the edge function never diverge.
// ───────────────────────────────────────────────────────────────────────────

// --- pricing + tokensToCents (13-34) ---
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6":          { input: 300,  output: 1500 }, // $3/$15 per MTok
  "claude-haiku-4-5-20251001":  { input: 80,   output: 400  }, // $0.80/$4 per MTok
};
const DEFAULT_PRICING = { input: 300, output: 1500 };

// Cache write costs 25% more than base input; cache read costs 10% of base input.
export function tokensToCents(
  input: number,
  output: number,
  model?: string,
  cacheWrite = 0,
  cacheRead = 0,
): number {
  const p = (model && MODEL_PRICING[model]) || DEFAULT_PRICING;
  return Math.round(
    (input      / 1_000_000) * p.input +
    (cacheWrite / 1_000_000) * p.input * 1.25 +
    (cacheRead  / 1_000_000) * p.input * 0.10 +
    (output     / 1_000_000) * p.output
  );
}

// --- safeBase64 (1367-1370) ---
function safeBase64(str: string): string {
  try { return btoa(unescape(encodeURIComponent(str))); }
  catch { return btoa(str); }
}

// --- patch system (1253-1365) ---
interface PatchOp {
  find?: string;
  replace?: string;
  insert_after?: string;
  content?: string;
  delete?: string;
}

function applyPatches(
  original: string,
  patches: PatchOp[],
): { result: string; added: number; removed: number; failed: number } {
  let result = original;
  let added = 0, removed = 0, failed = 0;

  // Four levels of match, each progressively more permissive
  const tryReplace = (haystack: string, needle: string, replacement: string): string | null => {
    // Level 1: exact
    if (haystack.includes(needle)) return haystack.replace(needle, replacement);
    // Level 2: normalise CRLF + collapse runs of spaces/tabs to single space
    const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
    const n1 = norm(haystack), n2 = norm(needle);
    if (n1.includes(n2)) return n1.replace(n2, replacement);
    // Level 3: trim every line (handles indentation changes from Cursor)
    const trimLines = (s: string) => s.split("\n").map(l => l.trim()).join("\n");
    const t1 = trimLines(haystack), t2 = trimLines(needle);
    if (t1.includes(t2)) return t1.replace(t2, replacement);
    // Level 4: collapse ALL whitespace — last resort, catches aggressive reformatting
    const flat = (s: string) => s.replace(/\s+/g, " ").trim();
    const f1 = flat(haystack), f2 = flat(needle);
    if (f1.includes(f2)) return f1.replace(f2, replacement);
    return null;
  };

  for (const patch of patches) {
    if (patch.find !== undefined && patch.replace !== undefined) {
      const replaced = tryReplace(result, patch.find, patch.replace);
      if (replaced !== null) {
        removed += patch.find.split("\n").length;
        added += patch.replace.split("\n").length;
        result = replaced;
      } else {
        failed++;
      }
    } else if (patch.insert_after !== undefined && patch.content !== undefined) {
      const anchor = patch.insert_after;
      if (result.includes(anchor)) {
        added += patch.content.split("\n").length;
        result = result.replace(anchor, anchor + patch.content);
      } else {
        // Try trimmed anchor
        const trimLines = (s: string) => s.split("\n").map(l => l.trim()).join("\n");
        const tResult = trimLines(result), tAnchor = trimLines(anchor);
        if (tResult.includes(tAnchor)) {
          result = tResult.replace(tAnchor, tAnchor + patch.content);
          added += patch.content.split("\n").length;
        } else { failed++; }
      }
    } else if (patch.delete !== undefined) {
      const replaced = tryReplace(result, patch.delete, "");
      if (replaced !== null) {
        removed += patch.delete.split("\n").length;
        result = replaced;
      } else { failed++; }
    }
  }
  return { result, added, removed, failed };
}

function parsePatchOps(body: string): PatchOp[] {
  const ops: PatchOp[] = [];
  const tags: { open: string; close: string; key: keyof PatchOp }[] = [
    { open: "<find>", close: "</find>", key: "find" },
    { open: "<replace>", close: "</replace>", key: "replace" },
    { open: "<insert_after>", close: "</insert_after>", key: "insert_after" },
    { open: "<content>", close: "</content>", key: "content" },
    { open: "<delete>", close: "</delete>", key: "delete" },
  ];

  let cur: PatchOp = {};
  let pos = 0;

  while (pos < body.length) {
    let earliest: { idx: number; tag: typeof tags[0] } | null = null;
    for (const tag of tags) {
      const idx = body.indexOf(tag.open, pos);
      if (idx !== -1 && (earliest === null || idx < earliest.idx)) {
        earliest = { idx, tag };
      }
    }
    if (!earliest) break;

    const { idx, tag } = earliest;
    const start = idx + tag.open.length;
    const endIdx = body.indexOf(tag.close, start);
    if (endIdx === -1) break;

    const val = body.slice(start, endIdx);

    if (tag.key === "find" || tag.key === "insert_after" || tag.key === "delete") {
      cur = { [tag.key]: val };
      ops.push(cur);
    } else if (tag.key === "replace" || tag.key === "content") {
      if (ops.length > 0) {
        ops[ops.length - 1][tag.key] = val;
      }
    }

    pos = endIdx + tag.close.length;
  }

  return ops;
}

// --- stream parser (1375-1578) ---
type ParsePhase = "message" | "in_file" | "in_patch_body" | "in_critique";

interface ParseState {
  phase: ParsePhase;
  buf: string;
  msgText: string;
  curFileName: string;
  curFileContent: string;
  curCritique: string;
  curPlan: string;
  curPatchOp: PatchOp;
  patches: PatchOp[];
  existingFiles: Record<string, string>;
  _carry?: string;
  _patchBuf?: string;
}

interface ParseEvent {
  type: "delta" | "file_start" | "file_delta" | "file_done" | "patch_done" | "critique" | "start" | "rename" | "delete";
  text?: string;
  name?: string;
  from?: string;
  to?: string;
  content?: string;
  encoding?: string;
  patches?: unknown[];
  data?: unknown;
}

interface DelimiterMatch { type: string; name?: string; index: number; end: number; }

function makeParse(existingFiles: Record<string, string>): ParseState {
  return {
    phase: "message", buf: "", msgText: "",
    curFileName: "", curFileContent: "", curCritique: "", curPlan: "",
    curPatchOp: {}, patches: [],
    existingFiles,
  };
}

function findDelimiter(text: string, from: number): DelimiterMatch | null {
  let best: DelimiterMatch | null = null;

  const fileRe = /<file\s+name="([^"]+)"\s*>/g;
  fileRe.lastIndex = from;
  const fm = fileRe.exec(text);
  if (fm && (best === null || fm.index < best.index)) {
    best = { type: "file_open", name: fm[1], index: fm.index, end: fm.index + fm[0].length };
  }

  const patchRe = /<patch name="([^"]+)">/g;
  patchRe.lastIndex = from;
  const pm = patchRe.exec(text);
  if (pm && (best === null || pm.index < best.index)) {
    best = { type: "patch_open", name: pm[1], index: pm.index, end: pm.index + pm[0].length };
  }

  const ci = text.indexOf("<critique>", from);
  if (ci !== -1 && (best === null || ci < best.index)) {
    best = { type: "critique_open", index: ci, end: ci + "<critique>".length };
  }

  // Self-closing file ops: <rename from="a" to="b"/> and <delete name="a"/>
  const renameRe = /<rename from="([^"]+)" to="([^"]+)"\/>/g;
  renameRe.lastIndex = from;
  const rm = renameRe.exec(text);
  if (rm && (best === null || rm.index < best.index)) {
    best = { type: "rename_op", name: rm[1], index: rm.index, end: rm.index + rm[0].length, _to: rm[2] } as any;
  }

  const deleteRe = /<delete name="([^"]+)"\/>/g;
  deleteRe.lastIndex = from;
  const dm = deleteRe.exec(text);
  if (dm && (best === null || dm.index < best.index)) {
    best = { type: "delete_op", name: dm[1], index: dm.index, end: dm.index + dm[0].length };
  }

  return best;
}

function processStreamBlock(chunk: string, state: ParseState): ParseEvent[] {
  const events: ParseEvent[] = [];
  (state as any)._carry = ((state as any)._carry || "") + chunk;
  let text: string = (state as any)._carry;
  (state as any)._carry = "";
  let pos = 0;

  while (pos <= text.length) {
    if (state.phase === "message") {
      const next = findDelimiter(text, pos);
      if (next === null) {
        const safe = Math.max(pos, text.length - 40);
        const emit = text.slice(pos, safe);
        if (emit) {
          if (!state.msgText) events.push({ type: "start" });
          state.msgText += emit;
          events.push({ type: "delta", text: emit });
        }
        (state as any)._carry = text.slice(safe);
        break;
      }
      const before = text.slice(pos, next.index);
      if (before) {
        if (!state.msgText) events.push({ type: "start" });
        state.msgText += before;
        events.push({ type: "delta", text: before });
      }
      if (next.type === "file_open") {
        state.curFileName = next.name!;
        state.curFileContent = "";
        state.phase = "in_file";
        events.push({ type: "file_start", name: next.name });
        pos = next.end;
      } else if (next.type === "patch_open") {
        state.curFileName = next.name!;
        state.patches = [];
        state.curPatchOp = {};
        (state as any)._patchBuf = "";
        state.phase = "in_patch_body" as ParsePhase;
        pos = next.end;
      } else if (next.type === "critique_open") {
        state.curCritique = "";
        state.phase = "in_critique";
        pos = next.end;
      } else if (next.type === "rename_op") {
        events.push({ type: "rename", from: next.name, to: (next as any)._to });
        pos = next.end;
      } else if (next.type === "delete_op") {
        events.push({ type: "delete", name: next.name });
        pos = next.end;
      } else {
        pos = next.end;
      }
    }

    else if (state.phase === "in_file") {
      // Only </file> closes a file. Backtick fences inside HTML/CSS/JS are valid
      // content (template literals, code comments) and must NOT trigger a close.
      const xmlCloseMatch = /< *\/ *file *>/.exec(text.slice(pos));
      const closeIdx = xmlCloseMatch ? pos + xmlCloseMatch.index : -1;
      const closeLen = xmlCloseMatch ? xmlCloseMatch[0].length : 0;

      if (closeIdx === -1) {
        const content = text.slice(pos);
        state.curFileContent += content;
        events.push({ type: "file_delta", text: content });
        (state as any)._carry = "";
        break;
      }
      const content = text.slice(pos, closeIdx);
      state.curFileContent += content;
      if (content) events.push({ type: "file_delta", text: content });
      const encoded = safeBase64(state.curFileContent);
      events.push({ type: "file_done", name: state.curFileName, content: encoded, encoding: "base64" });
      state.curFileName = "";
      state.curFileContent = "";
      state.phase = "message";
      pos = closeIdx + closeLen;
    }

    else if ((state.phase as string) === "in_patch_body") {
      const closeIdx = text.indexOf("</patch>", pos);
      if (closeIdx === -1) {
        (state as any)._patchBuf += text.slice(pos);
        break;
      }
      (state as any)._patchBuf += text.slice(pos, closeIdx);
      const ops = parsePatchOps((state as any)._patchBuf as string);
      const original = state.existingFiles[state.curFileName] || "";
      const { result, failed } = applyPatches(original, ops);
      // If ALL patches failed, emit patch_failed so frontend can retry as full rewrite
      if (ops.length > 0 && failed === ops.length) {
        events.push({ type: "patch_done", name: state.curFileName, content: null as any, encoding: "failed" });
      } else {
        const encoded = safeBase64(result);
        // Update existingFiles so any subsequent patches for the same file
        // build on top of this result rather than re-applying to the original.
        state.existingFiles[state.curFileName] = result;
        events.push({ type: "patch_done", name: state.curFileName, content: encoded, encoding: "base64" });
      }
      state.patches = [];
      state.curPatchOp = {};
      (state as any)._patchBuf = "";
      state.phase = "message";
      pos = closeIdx + "</patch>".length;
    }

    else if (state.phase === "in_critique") {
      const closeIdx = text.indexOf("</critique>", pos);
      if (closeIdx === -1) { state.curCritique += text.slice(pos); break; }
      state.curCritique += text.slice(pos, closeIdx);
      try {
        const parsed = JSON.parse(state.curCritique.trim());
        events.push({ type: "critique", data: parsed });
      } catch { /* malformed */ }
      state.phase = "message";
      pos = closeIdx + "</critique>".length;
    }

    else { pos++; }
  }

  return events;
}

// --- streamBuild (1583-1751) ---
export async function streamBuild(
  anthropicRes: Response,
  existingFiles: Record<string, string>,
  emit: (event: string, data: unknown) => Promise<void>,
  // Live usage mirror — updated as tokens arrive so the caller can bill what was generated even if
  // the client disconnects (clicks Stop) before the stream finishes. Without this, usage was only
  // known after the function returned, so an early Stop cost the user nothing.
  usageOut?: { in: number; out: number; cacheWrite: number; cacheRead: number },
  // When the client disconnects, this aborts — we cancel the Anthropic read so generation (and
  // billing) stops at roughly the point the user pressed Stop instead of running to completion.
  signal?: AbortSignal,
): Promise<{ files: Record<string, string>; message: string; critique: Record<string, unknown> | null; tokensIn: number; tokensOut: number; tokensCacheWrite: number; tokensCacheRead: number }> {
  const reader = anthropicRes.body!.getReader();
  const decoder = new TextDecoder();
  let antBuf = "";
  const state = makeParse(existingFiles);
  let startEmitted = false;
  const collectedFiles: Record<string, string> = {};
  let finalMessage = "";
  let finalCritique: Record<string, unknown> | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheWrite = 0;
  let tokensCacheRead = 0;
  let outChars = 0; // total output text streamed — used to estimate tokens if Stop hits before Anthropic reports its final count

  try {
    while (true) {
      // Client disconnected (Stop): stop reading so Anthropic stops generating/billing. The usage
      // accumulated so far (plus the char-based estimate below) is still recorded by the caller.
      if (signal?.aborted) { try { await reader.cancel(); } catch { /* already closing */ } break; }
      const { done, value } = await reader.read();
      if (done) break;
      antBuf += decoder.decode(value, { stream: true });
      const lines = antBuf.split("\n");
      antBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(raw); } catch { continue; }

        if (parsed.type === "message_start") {
          const usage = (parsed.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
          if (usage) {
            tokensIn         += usage.input_tokens                 || 0;
            tokensCacheWrite += usage.cache_creation_input_tokens  || 0;
            tokensCacheRead  += usage.cache_read_input_tokens      || 0;
            // output_tokens in usage is CUMULATIVE for the response — take the max, never sum
            // (summing repeated cumulative values would massively over-count).
            tokensOut         = Math.max(tokensOut, usage.output_tokens || 0);
          }
          if (usageOut) { usageOut.in = tokensIn; usageOut.cacheWrite = tokensCacheWrite; usageOut.cacheRead = tokensCacheRead; usageOut.out = tokensOut; }
        }

        if (parsed.type === "message_delta") {
          const usage = parsed.usage as Record<string, number> | undefined;
          if (usage) tokensOut = Math.max(tokensOut, usage.output_tokens || 0); // cumulative — take latest, don't sum
          if (usageOut) usageOut.out = tokensOut;
          // Detect token limit hit — signal client so it can continue automatically
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason === "max_tokens") {
            await emit("max_tokens_hit", {});
          }
        }

        if (parsed.type === "content_block_delta") {
          const delta = parsed.delta as Record<string, unknown>;
          if (delta?.type === "text_delta") {
            const text = delta.text as string;
            outChars += text.length; // track output volume for the Stop-before-final-usage estimate
            // Update the live output estimate every chunk (Anthropic only reports real output_tokens
            // in the FINAL message_delta, so without this an interrupted stream would bill ~0 output).
            if (usageOut) usageOut.out = Math.max(usageOut.out, Math.ceil(outChars / 4));
            const events = processStreamBlock(text, state);

            for (const ev of events) {
              if (ev.type === "start" && !startEmitted) {
                await emit("start", {});
                startEmitted = true;
              } else if (ev.type === "delta") {
                if (!startEmitted) { await emit("start", {}); startEmitted = true; }
                await emit("delta", { text: ev.text });
              } else if (ev.type === "file_start") {
                await emit("file_start", { name: ev.name });
              } else if (ev.type === "file_delta") {
                await emit("file_delta", { text: ev.text });
              } else if (ev.type === "file_done") {
                let outContent = ev.content!;
                let decoded = "";
                if (ev.name && outContent) {
                  try { decoded = decodeURIComponent(escape(atob(outContent))); } catch { decoded = atob(outContent); }
                  // Safety net: if the AI reproduced the truncation marker, the file was cut off.
                  // Restore the original tail so nothing is lost.
                  const truncMarker = "<!-- [COMPLETE FILE";
                  const original = existingFiles[ev.name];
                  if (original && decoded.includes(truncMarker)) {
                    const markerIdx = decoded.indexOf(truncMarker);
                    decoded = decoded.slice(0, markerIdx) + original.slice(markerIdx);
                    outContent = safeBase64(decoded);
                  }
                }
                await emit("file", { name: ev.name, content: outContent, encoding: "base64" });
                if (ev.name && decoded) {
                  collectedFiles[ev.name] = decoded;
                }
              } else if (ev.type === "patch_done") {
                if (ev.encoding === "failed") {
                  // All patches failed to match — tell frontend to retry as full rewrite
                  await emit("patch_failed", { name: ev.name });
                } else {
                  await emit("file_start", { name: ev.name, mode: "patch" });
                  await emit("file", { name: ev.name, content: ev.content, encoding: "base64" });
                  if (ev.name && ev.content) {
                    try { collectedFiles[ev.name] = decodeURIComponent(escape(atob(ev.content))); } catch { collectedFiles[ev.name!] = atob(ev.content!); }
                  }
                }
              } else if (ev.type === "critique") {
                // Critique removed from the product — the parser still swallows any stray <critique>
                // block so it never leaks into the chat, but we no longer emit or use it.
              } else if (ev.type === "rename") {
                await emit("rename", { from: ev.from, to: ev.to });
              } else if (ev.type === "delete") {
                await emit("delete", { name: ev.name });
              }
            }
          }
        }

        if (parsed.type === "message_stop") {
          // Flush any text held in the carry buffer (last 80 chars held back to
          // detect split XML tags). If never flushed, short conversational
          // responses get cut off mid-sentence.
          const carry = (state as any)._carry || "";
          if (carry) {
            state.msgText += carry;
            if (carry.trim()) await emit("delta", { text: carry });
            (state as any)._carry = "";
          }
          finalMessage = state.msgText.trim();
          await emit("message", { message: finalMessage });
          await emit("done", { count: Object.keys(collectedFiles).length });
        }
      }
    }
  } catch (err) {
    await emit("error", { error: String(err) });
  }

  // If the stream ended while mid-file (connection drop, timeout, Supabase kill),
  // emit whatever was accumulated so the client can save it and continue.
  if ((state.phase as string) === "in_file" && state.curFileName && state.curFileContent.length > 0) {
    try {
      const partialEncoded = safeBase64(state.curFileContent);
      await emit("partial_file", { name: state.curFileName, content: partialEncoded, encoding: "base64" });
    } catch { /* stream may already be closing */ }
  }

  // If Stop hit before Anthropic reported its final cumulative output_tokens, fall back to a
  // char-based estimate (~4 chars/token) so an interrupted build still bills for what it produced
  // instead of nothing. On normal completion the reported count is >= this, so max() is a no-op.
  const estOut = Math.ceil(outChars / 4);
  if (estOut > tokensOut) tokensOut = estOut;
  if (usageOut) usageOut.out = Math.max(usageOut.out, tokensOut);

  return { files: collectedFiles, message: finalMessage, critique: finalCritique, tokensIn, tokensOut, tokensCacheWrite, tokensCacheRead };
}
