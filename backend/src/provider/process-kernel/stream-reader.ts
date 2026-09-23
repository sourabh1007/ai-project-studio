/**
 * Assembles arbitrary byte/string chunks into complete newline-delimited lines.
 * CLI stdout arrives in fragments; this buffers partial lines until a newline
 * is seen. `flush()` returns any trailing text not terminated by a newline.
 */
export class LineAssembler {
  private buffer = '';

  /** Feeds a chunk and returns any complete lines it produced. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    // Split once (O(n)) rather than repeatedly slicing the head of a growing
    // buffer (which is O(n²) in the number of lines). Under a large coalesced
    // stdout chunk from a busy warm session — thousands of JSON-RPC lines in a
    // single `data` event — the quadratic form blocked the event loop for
    // seconds, starving cheap HTTP reads like `/health` and `/config` and
    // making the whole app look unavailable while sessions were working.
    const parts = this.buffer.split('\n');
    // The final element is the still-incomplete trailing line (empty when the
    // chunk ended exactly on a newline); keep it buffered for the next push.
    // `split` always yields at least one element, so `pop` never returns
    // undefined here.
    this.buffer = parts.pop()!;
    return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  }

  /** Returns and clears any buffered trailing text (no newline seen). */
  flush(): string | undefined {
    if (this.buffer.length === 0) {
      return undefined;
    }
    const remaining = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    return remaining;
  }
}
