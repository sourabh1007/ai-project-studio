import type { ProcessHandle } from '../process-kernel/process-spawner.js';
import { claudeRecord, claudeResultText, parseClaudeLine } from './claude-protocol.js';

/** Converts native JSONL at the adapter boundary, never changing shared meta parsing. */
export function normalizeClaudeSession(native: ProcessHandle): ProcessHandle {
  const stdout: ((line: string) => void)[] = [];
  const stderr: ((line: string) => void)[] = [];
  const exits: ((code: number | null) => void)[] = [];
  let failed = false;
  const emit = (callbacks: ((line: string) => void)[], line: string) => {
    for (const callback of callbacks) callback(line);
  };
  const assistant = (content: string) => {
    emit(stdout, JSON.stringify({ type: 'assistant.message', data: { content } }));
  };
  const exitCode = (code: number | null) => failed && code === 0 ? 1 : code;

  native.onStdoutLine((line) => {
    const record = parseClaudeLine(line);
    if (record?.type === 'result') {
      const error = record.is_error === true ||
        (typeof record.subtype === 'string' && record.subtype !== 'success');
      if (error) {
        failed = true;
        const details = Array.isArray(record.errors)
          ? record.errors.filter((value): value is string => typeof value === 'string').join('; ')
          : typeof record.result === 'string' ? record.result : '';
        emit(stdout, JSON.stringify({
          type: 'session.error', data: { message: details || 'Claude Code reported a failed result' },
        }));
        emit(stderr, line);
      } else if (!failed) {
        const content = claudeResultText(line);
        if (content !== null) assistant(content);
        emit(stdout, JSON.stringify({ type: 'result', data: {} }));
      }
    } else if (record?.type === 'assistant' && !record.parent_tool_use_id) {
      const message = claudeRecord(record.message);
      const content = message?.content;
      const parts: string[] = [];
      if (typeof content === 'string') parts.push(content);
      if (Array.isArray(content)) {
        for (const value of content) {
          const block = claudeRecord(value);
          if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        }
      }
      if (parts.length > 0 && !failed) assistant(parts.join('\n'));
      else emit(stderr, line);
    } else {
      emit(stderr, line);
    }
  });
  native.onStderrLine((line) => emit(stderr, line));
  native.onExit((code) => {
    for (const callback of exits) callback(exitCode(code));
  });
  return {
    onStdoutLine: (callback) => { stdout.push(callback); },
    onStderrLine: (callback) => { stderr.push(callback); },
    onExit: (callback) => { exits.push(callback); },
    kill: () => native.kill(),
    done: native.done.then(exitCode),
    snapshot: () => native.snapshot(),
  };
}
