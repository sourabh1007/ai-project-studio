import type {
  HealEvent,
  Healer,
  HealTargetInfo,
  SelfHealService,
} from './self-heal-contract.js';

export interface SelfHealDeps {
  /** The registered healers, keyed by their `info.id`. */
  healers: Healer[];
}

/**
 * Create the self-heal orchestrator. For each `heal(id)` call it verifies the
 * problem, skips healing if already resolved, otherwise runs the healer and
 * re-verifies — emitting phase/log/terminal events throughout. It never throws:
 * a healer that rejects is reported as an `error` event.
 */
export function createSelfHealService(deps: SelfHealDeps): SelfHealService {
  const byId = new Map<string, Healer>();
  for (const healer of deps.healers) {
    byId.set(healer.info.id, healer);
  }

  const list = (): HealTargetInfo[] =>
    deps.healers.map((healer) => healer.info);

  const heal = async (
    targetId: string,
    onEvent: (event: HealEvent) => void,
  ): Promise<boolean> => {
    const healer = byId.get(targetId);
    if (!healer) {
      onEvent({ kind: 'phase', phase: 'error' });
      onEvent({ kind: 'error', message: `Unknown heal target: ${targetId}` });
      return false;
    }

    onEvent({ kind: 'phase', phase: 'checking' });
    let alreadyOk: boolean;
    try {
      alreadyOk = await healer.verify();
    } catch (error) {
      onEvent({ kind: 'phase', phase: 'error' });
      onEvent({ kind: 'error', message: describeError(error) });
      return false;
    }
    if (alreadyOk) {
      onEvent({ kind: 'phase', phase: 'done' });
      onEvent({
        kind: 'done',
        healed: true,
        message: `${healer.info.title} is already working.`,
      });
      return true;
    }

    onEvent({ kind: 'phase', phase: 'healing' });
    try {
      await healer.heal((line) => onEvent({ kind: 'log', line }));
    } catch (error) {
      onEvent({ kind: 'phase', phase: 'error' });
      onEvent({ kind: 'error', message: describeError(error) });
      return false;
    }

    onEvent({ kind: 'phase', phase: 'checking' });
    let healed: boolean;
    try {
      healed = await healer.verify();
    } catch (error) {
      onEvent({ kind: 'phase', phase: 'error' });
      onEvent({ kind: 'error', message: describeError(error) });
      return false;
    }
    if (healed) {
      onEvent({ kind: 'phase', phase: 'done' });
      onEvent({
        kind: 'done',
        healed: true,
        message: `${healer.info.title} is now working.`,
      });
      return true;
    }

    onEvent({ kind: 'phase', phase: 'error' });
    onEvent({
      kind: 'error',
      message: `${healer.info.title} could not be repaired automatically.`,
    });
    return false;
  };

  return { list, heal };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
