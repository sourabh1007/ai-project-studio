import type { MetaRequest, MetaRunResult, MetaRunner } from '../meta-runner.js';
import type { AcpTurnResult } from './acp-client.js';

/** Longest a single streamed activity line may be before it is elided. */
const MAX_ACTIVITY_CHARS = 160;

function clip(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= MAX_ACTIVITY_CHARS
    ? text
    : `${text.slice(0, MAX_ACTIVITY_CHARS - 1)}…`;
}

/** The subset of the warm pool this adapter drives. */
export interface AcpTurnPool {
  run(
    request: {
      prompt: string;
      cwd?: string;
      onActivity?: (text: string) => void;
    },
    context?: { purpose?: string; label?: string },
  ): Promise<AcpTurnResult>;
}

export interface AcpMetaRunnerDeps {
  pool: AcpTurnPool;
  /**
   * Mints the session id reported to callers for a warm turn. The ACP path does
   * not write the OTel usage file keyed by session id, so this id is used only
   * for the review's `metaSessionId` bookkeeping (usage reads back as null).
   */
  newSessionId: () => string;
  /**
   * Routing purpose this runner's pool serves. Recorded against each warm turn
   * as the "where in the IDE" signal for the session's usage history. A
   * request that carries its own {@link MetaRequest.purpose} overrides it.
   */
  purpose?: string;
}

/**
 * Adapts the warm {@link AcpTurnPool} to the {@link MetaRunner.runDetailed}
 * contract so PR review steps can lease a live `copilot --acp` session instead
 * of cold-spawning a CLI per step. The full step prompt is sent inline over
 * stdio (ACP has no argv length limit), so the caller no longer needs the
 * temp-file attachment used by the cold path.
 *
 * Streamed assistant text is buffered into whole lines and forwarded to
 * `onActivity` so the review page keeps showing live progress; any trailing
 * partial line is flushed when the turn completes.
 */
export function createAcpMetaRunner(
  deps: AcpMetaRunnerDeps,
): Pick<MetaRunner, 'runDetailed'> {
  return {
    async runDetailed(request: MetaRequest): Promise<MetaRunResult> {
      const sessionId = deps.newSessionId();
      request.onStart?.(sessionId);

      let buffer = '';
      const emit = request.onActivity;
      const onActivity = emit
        ? (chunk: string): void => {
            buffer += chunk;
            let index = buffer.indexOf('\n');
            while (index !== -1) {
              const line = clip(buffer.slice(0, index));
              if (line.length > 0) {
                emit(`💬 ${line}`);
              }
              buffer = buffer.slice(index + 1);
              index = buffer.indexOf('\n');
            }
          }
        : undefined;

      const result = await deps.pool.run(
        {
          prompt: request.prompt,
          cwd: request.cwd,
          onActivity,
        },
        { purpose: request.purpose ?? deps.purpose, label: request.label },
      );

      if (emit) {
        const trailing = clip(buffer);
        if (trailing.length > 0) {
          emit(`💬 ${trailing}`);
        }
      }

      return { text: result.text, sessionId };
    },
  };
}
