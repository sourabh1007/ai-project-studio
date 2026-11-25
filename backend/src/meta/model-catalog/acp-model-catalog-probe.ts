import { AcpClient } from '../acp/acp-client.js';
import { AcpProcessAdapter, type AcpSpawnOptions } from '../acp/acp-process-adapter.js';
import type {
  MetaModelOption,
  ModelCatalogProbe,
} from './model-catalog-contract.js';
import { parseAvailableModels } from './model-catalog-parser.js';
import type { ProcessAdmission } from '../../kernel/process-admission.js';

export interface AcpModelCatalogProbeOptions {
  /** Absolute path to the copilot executable driving the ACP process. */
  executable: string;
  resolveCommand?: AcpSpawnOptions['resolveCommand'];
  extraArgs?: string[];
  /** Timeout (ms) for the one-time ACP `initialize` handshake. */
  initializeTimeoutMs: number;
  /** Timeout (ms) for the `session/new` request that carries the catalog. */
  turnTimeoutMs: number;
  /** Working directory for the throwaway session. */
  cwd?: string;
  admission?: ProcessAdmission;
  acquireExecution?: () => { release(): void };
  registerPhysical?: (process: { kill(): void; done: Promise<void> }) => void;
}

/**
 * Fetches the model catalog by driving a short-lived `copilot --acp` session:
 * the CLI advertises its available models (ids, names, pricing hints) in the
 * `session/new` result, so a single handshake + session creation is enough —
 * no prompt is ever sent. The process is killed immediately afterwards.
 *
 * This is an IO/native boundary (like `acp-process-adapter.ts` and the
 * plan-usage PTY probe) and is excluded from unit-test coverage; the pure
 * parser and cached service that consume it are fully unit-tested.
 */
export function createAcpModelCatalogProbe(
  options: AcpModelCatalogProbeOptions,
): ModelCatalogProbe {
  return {
    async fetch(): Promise<MetaModelOption[] | null> {
      const execution = options.acquireExecution?.();
      let permit: Awaited<ReturnType<ProcessAdmission['acquireCold']>> | undefined;
      let client: AcpClient;
      try {
        permit = await options.admission?.acquireCold(AbortSignal.timeout(options.initializeTimeoutMs));
        client = new AcpClient(
          new AcpProcessAdapter({ executable: options.executable, extraArgs: options.extraArgs, resolveCommand: options.resolveCommand }),
          {
            initializeTimeoutMs: options.initializeTimeoutMs,
            turnTimeoutMs: options.turnTimeoutMs,
          },
        );
      } catch (error) {
        permit?.release();
        execution?.release();
        throw error;
      }
      client.onExit(() => {
        permit?.release();
        execution?.release();
      });
      const done = new Promise<void>((resolve) => { client.onExit(resolve); });
      options.registerPhysical?.({ kill: () => client.kill(), done });
      try {
        await client.initialize();
        const result = await client.newSession(options.cwd);
        return parseAvailableModels(result);
      } catch {
        return null;
      } finally {
        client.kill();
      }
    },
  };
}
