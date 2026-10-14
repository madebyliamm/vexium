// Incremental Server-Sent-Events parser. The build Worker and ai-chat emit `event: x\ndata: {json}\n\n`. Network chunks
// can end anywhere (mid-line, between the \r and \n of a CRLF), so state is kept between pushes. The result must not
// depend on how the bytes were chunked — test/sse.test.ts checks that against every split point.

export interface SseMessage {
  event: string;
  data: string;
}

function parseBlock(block: string): SseMessage | null {
  let event = '';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue; // blank line / comment (keep-alive)
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!event && !data.length) return null;
  return { event: event || 'message', data: data.join('\n') };
}

export class SseParser {
  private buffer = '';

  /** Feed decoded text; returns the messages completed by it. */
  push(chunk: string): SseMessage[] {
    let text = this.buffer + chunk;
    // A trailing \r may be the first half of \r\n — hold it back until the next chunk decides.
    let held = '';
    if (text.endsWith('\r')) {
      held = '\r';
      text = text.slice(0, -1);
    }
    text = text.replace(/\r\n?/g, '\n');
    const blocks = text.split('\n\n');
    this.buffer = (blocks.pop() ?? '') + held;
    const out: SseMessage[] = [];
    for (const block of blocks) {
      const message = parseBlock(block);
      if (message) out.push(message);
    }
    return out;
  }

  /** Stream ended: a final block without its terminating blank line still counts. */
  flush(): SseMessage[] {
    const rest = this.buffer.replace(/\r\n?/g, '\n');
    this.buffer = '';
    const message = rest.trim() ? parseBlock(rest) : null;
    return message ? [message] : [];
  }
}
