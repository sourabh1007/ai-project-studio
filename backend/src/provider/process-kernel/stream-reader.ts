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
    const lines: string[] = [];
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      lines.push(line);
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
    }
    return lines;
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
