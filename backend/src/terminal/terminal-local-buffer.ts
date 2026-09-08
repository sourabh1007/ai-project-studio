import { createAnsiParser, type AnsiParser, type AnsiParserState } from './ansi.js';

export interface TerminalLocalBuffer {
  append(chunk: string): void;
  text(): string;
  finalize(): void;
}

export interface TerminalReplayBuffer extends TerminalLocalBuffer {
  lateJoinState(): AnsiParserState | null;
  pendingHighSurrogate(): string | null;
}

interface TextBlock {
  text: string;
  offset: number;
  bytes: number;
  next: TextBlock | null;
}

const BLOCK_UNITS = 4096;

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function nextUtf8Unit(input: string, index: number): string {
  return input.slice(index, index + (
    isHighSurrogate(input.charCodeAt(index)) &&
    index + 1 < input.length &&
    isLowSurrogate(input.charCodeAt(index + 1)) ? 2 : 1
  ));
}

function createBlockBuffer(maxBytes: number, headParser?: AnsiParser) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Terminal retention bytes must be a nonnegative safe integer');
  }
  let head: TextBlock | null = null;
  let tail: TextBlock | null = null;
  let totalBytes = 0;
  let pendingHigh: string | null = null;
  let cached = '';
  let dirty = false;

  const mustTrim = () =>
    totalBytes > maxBytes || (headParser !== undefined && !headParser.atTextBoundary());

  const trim = () => {
    while (head && mustTrim()) {
      const block = head;
      if (!headParser && block.bytes <= totalBytes - maxBytes) {
        totalBytes -= block.bytes;
        head = block.next;
      } else {
        while (block.offset < block.text.length && mustTrim()) {
          const unit = nextUtf8Unit(block.text, block.offset);
          const bytes = Buffer.byteLength(unit, 'utf8');
          headParser?.write(unit);
          block.offset += unit.length;
          block.bytes -= bytes;
          totalBytes -= bytes;
        }
        if (block.offset === block.text.length) head = block.next;
      }
    }
    if (!head) tail = null;
  };

  const appendBlock = (text: string, bytes: number) => {
    // Never extend a window-sized string or repeatedly slice its prefix.
    // Small appends coalesce only within a bounded, not-yet-consumed block.
    if (tail && tail.text.length + text.length <= BLOCK_UNITS &&
        (tail !== head || tail.offset === 0)) {
      tail.text += text;
      tail.bytes += bytes;
    } else {
      const block: TextBlock = { text, bytes, offset: 0, next: null };
      if (tail) tail.next = block;
      else head = block;
      tail = block;
    }
    totalBytes += bytes;
    dirty = true;
    trim();
  };

  const append = (chunk: string) => {
    if (!chunk) return;
    let parts: string[] = [];
    let units = 0;
    let bytes = 0;
    const flush = () => {
      if (parts.length === 0) return;
      appendBlock(parts.join(''), bytes);
      parts = [];
      units = 0;
      bytes = 0;
    };
    const push = (unit: string) => {
      if (units + unit.length > BLOCK_UNITS) flush();
      parts.push(unit);
      units += unit.length;
      bytes += Buffer.byteLength(unit, 'utf8');
    };
    let index = 0;
    if (pendingHigh !== null) {
      if (isLowSurrogate(chunk.charCodeAt(0))) {
        push(pendingHigh + chunk[0]);
        index = 1;
      } else {
        push('\ufffd');
      }
      pendingHigh = null;
    }
    while (index < chunk.length) {
      if (isHighSurrogate(chunk.charCodeAt(index)) && index + 1 === chunk.length) {
        pendingHigh = chunk[index];
        break;
      }
      const unit = nextUtf8Unit(chunk, index);
      const code = unit.charCodeAt(0);
      push(unit.length === 1 && (isHighSurrogate(code) || isLowSurrogate(code))
        ? '\ufffd' : unit);
      index += unit.length;
    }
    flush();
  };

  return {
    append,
    text() {
      if (dirty) {
        const parts: string[] = [];
        for (let block = head; block; block = block.next) {
          parts.push(block.text.slice(block.offset));
        }
        cached = parts.join('');
        dirty = false;
      }
      return cached;
    },
    finalize() {
      if (pendingHigh !== null) {
        pendingHigh = null;
        append('\ufffd');
      }
    },
    pendingHighSurrogate: () => pendingHigh,
  };
}

/**
 * UTF-8-bounded text in fixed-size blocks. One trailing high surrogate is held
 * outside the retained window until completion; malformed units become U+FFFD.
 */
export function createUtf8TailBuffer(maxBytes: number): TerminalLocalBuffer {
  return createBlockBuffer(maxBytes);
}

/**
 * The parser tracks the discarded prefix, not a periodically rescanned tail.
 * Trimming continues to a text boundary, or discards an unfinished control
 * string while retaining only its current parser state for late joiners.
 */
export function createAnsiSafeUtf8TailBuffer(maxBytes: number): TerminalReplayBuffer {
  const headParser = createAnsiParser();
  return {
    ...createBlockBuffer(maxBytes, headParser),
    lateJoinState: () => headParser.atTextBoundary() ? null : headParser.snapshot(),
  };
}
