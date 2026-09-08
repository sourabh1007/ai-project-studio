import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LineAssembler } from '../../provider/process-kernel/stream-reader.js';
import type { AcpProcess } from './acp-client.js';

export interface AcpReadableStream {
  setEncoding?(encoding: BufferEncoding): void;
  on(event: 'data', handler: (chunk: Buffer | string) => void): void;
}

export interface AcpWritableStream {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  on(event: 'error', handler: (error: Error) => void): void;
}

export interface AcpChildProcess {
  pid?: number;
  stdout: AcpReadableStream;
  stderr: AcpReadableStream;
  stdin: AcpWritableStream;
  on(event: 'close', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  kill(): void;
}

export type AcpSpawn = (
  executable: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    stdio: 'pipe';
    shell: false;
  },
) => AcpChildProcess;

export interface AcpSpawnOptions {
  executable: string;
  baseArgs?: string[];
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  spawnImpl?: AcpSpawn;
}

const MAX_DIAGNOSTIC_LINES = 12;
const MAX_DIAGNOSTIC_LINE_CHARS = 200;
const MAX_STDERR_LINE_BUFFER_CHARS = 8_192;
const REDACTED = '[REDACTED]';

const defaultSpawn: AcpSpawn = (executable, args, options) =>
  spawn(executable, args, options) as ChildProcessWithoutNullStreams;

type DiagnosticEvent =
  | { kind: 'line'; line: string }
  | { kind: 'omitted'; count: number };

class BoundedDiagnosticAssembler {
  private buffer = '';
  private dropping = false;
  private dropped = 0;

  push(chunk: string): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== '\n') {
        continue;
      }
      this.appendFragment(chunk.slice(start, index), events, true);
      start = index + 1;
    }
    this.appendFragment(chunk.slice(start), events, false);
    return events;
  }

  flush(): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    if (this.dropping) {
      this.dropping = false;
      this.dropped += 1;
    } else if (this.buffer.length > 0) {
      events.push({ kind: 'line', line: this.buffer.replace(/\r$/, '') });
      this.buffer = '';
    }
    if (this.dropped > 0) {
      events.push({ kind: 'omitted', count: this.dropped });
      this.dropped = 0;
    }
    return events;
  }

  private appendFragment(
    fragment: string,
    events: DiagnosticEvent[],
    complete: boolean,
  ): void {
    if (this.dropping) {
      if (complete) {
        this.dropping = false;
        this.dropped += 1;
      }
      return;
    }
    if (this.buffer.length + fragment.length > MAX_STDERR_LINE_BUFFER_CHARS) {
      this.buffer = '';
      this.dropping = !complete;
      this.dropped += 1;
      return;
    }
    this.buffer += fragment;
    if (!complete) {
      return;
    }
    events.push({ kind: 'line', line: this.buffer.replace(/\r$/, '') });
    this.buffer = '';
  }
}

function sanitizeDiagnostic(line: string): string {
  return line
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(
      /\b(authorization|token|secret|password|passphrase|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\b\s*[:=]\s*.+$/i,
      (_match, key: string) => `${key}=${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, REDACTED)
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]+\b/g, REDACTED)
    .replace(/\s+/g, ' ')
    .trim();
}

export class AcpProcessAdapter implements AcpProcess {
  private readonly child: AcpChildProcess;
  private readonly stdout = new LineAssembler();
  private readonly stderr = new BoundedDiagnosticAssembler();
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandler: ((code: number | null) => void) | null = null;
  private readonly diagnostics: string[] = [];
  private droppedDiagnostics = 0;
  private exited = false;
  private terminatingForStdinFailure = false;

  constructor(options: AcpSpawnOptions) {
    const args = [
      ...(options.baseArgs ?? ['--acp', '--disable-builtin-mcps']),
      ...(options.extraArgs ?? []),
    ];
    this.child = (options.spawnImpl ?? defaultSpawn)(options.executable, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: 'pipe',
      shell: false,
    });

    this.child.stdout.setEncoding?.('utf8');
    this.child.stdout.on('data', (chunk) => {
      for (const line of this.stdout.push(String(chunk))) {
        this.lineHandler?.(line);
      }
    });

    this.child.stderr.setEncoding?.('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.captureDiagnosticEvents(this.stderr.push(String(chunk)));
    });

    this.child.stdin.on('error', (error) => {
      this.captureDiagnostic(error.message);
      this.terminateAfterStdinFailure();
    });

    const onDone = (code: number | null): void => {
      if (this.exited) {
        return;
      }
      this.exited = true;
      const trailingStdout = this.stdout.flush();
      if (trailingStdout !== undefined) {
        this.lineHandler?.(trailingStdout);
      }
      this.captureDiagnosticEvents(this.stderr.flush());
      this.exitHandler?.(code);
    };

    this.child.on('close', onDone);
    this.child.on('error', (error) => {
      this.captureDiagnostic(error.message);
      if (this.exited || this.child.pid !== undefined) {
        return;
      }
      onDone(null);
    });
  }

  write(line: string): void {
    this.child.stdin.write(line, (error) => {
      if (!error) {
        return;
      }
      this.captureDiagnostic(error.message);
      this.terminateAfterStdinFailure();
    });
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandler = handler;
  }

  diagnostic(): string | null {
    if (this.diagnostics.length === 0) {
      return this.droppedDiagnostics > 0
        ? `${this.droppedDiagnostics} stderr line(s) omitted`
        : null;
    }
    const joined = this.diagnostics.join(' | ');
    return this.droppedDiagnostics > 0
      ? `${joined} (+${this.droppedDiagnostics} more line(s))`
      : joined;
  }

  kill(): void {
    this.child.kill();
  }

  private terminateAfterStdinFailure(): void {
    if (this.exited || this.terminatingForStdinFailure) {
      return;
    }
    this.terminatingForStdinFailure = true;
    this.child.kill();
  }

  private captureDiagnosticEvents(events: DiagnosticEvent[]): void {
    for (const event of events) {
      if (event.kind === 'omitted') {
        this.droppedDiagnostics += event.count;
        continue;
      }
      this.captureDiagnostic(event.line);
    }
  }

  private captureDiagnostic(line: string): void {
    const sanitized = sanitizeDiagnostic(line);
    if (sanitized.length === 0) {
      return;
    }
    const clipped =
      sanitized.length <= MAX_DIAGNOSTIC_LINE_CHARS
        ? sanitized
        : `${sanitized.slice(0, MAX_DIAGNOSTIC_LINE_CHARS - 1)}…`;
    if (this.diagnostics.length < MAX_DIAGNOSTIC_LINES) {
      this.diagnostics.push(clipped);
      return;
    }
    this.droppedDiagnostics += 1;
  }
}
