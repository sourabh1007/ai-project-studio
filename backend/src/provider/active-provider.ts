import { ConflictError, ValidationError } from '../kernel/error-types.js';

export interface ProviderExecutionBlocker {
  kind: string;
  id: string;
  label: string;
}

export interface ProviderSelectionSnapshot {
  providerId: string | null;
  selectionRequired: boolean;
  revision: number;
  blockers: ProviderExecutionBlocker[];
  remember: boolean;
}

export interface ProviderExecutionLease {
  providerId: string;
  release(): void;
}

export interface ProviderExecutionPolicy {
  get(): ProviderSelectionSnapshot;
  isEligible(providerId: string): boolean;
  assertActive(providerId: string): void;
  acquire(providerId?: string, owner?: ProviderExecutionBlocker): ProviderExecutionLease;
  select(providerId: string, remember?: boolean): ProviderSelectionSnapshot;
  switchTo(providerId: string, remember: boolean, expectedRevision: number, drain: () => Promise<void>): Promise<ProviderSelectionSnapshot>;
}

export interface ActiveProviderPolicyDeps {
  enabledProviderIds(): readonly string[];
  isEligible(providerId: string): boolean;
  initialProviderId: string | null;
  initialRemember?: boolean;
  /** Display/setup fallback only; never authorizes execution without a choice. */
  defaultProviderId?: string;
  externalBlockers?(): ProviderExecutionBlocker[];
  /** Must synchronously persist or throw, before the in-memory choice changes. */
  saveSelected(providerId: string | null): void;
  /** Restore old-provider workers only after a confirmed drain and unlocked failed commit. */
  onSwitchFailed?(): void;
}

export function createActiveProviderPolicy(deps: ActiveProviderPolicyDeps): ProviderExecutionPolicy {
  const eligible = (id: string) => deps.enabledProviderIds().includes(id) && deps.isEligible(id);
  let selected = deps.initialProviderId !== null && eligible(deps.initialProviderId) ? deps.initialProviderId : null;
  let remembered = deps.initialRemember ?? selected !== null;
  let revision = 0;
  let selecting = false;
  let sequence = 0;
  const leases = new Map<number, ProviderExecutionBlocker>();
  const get = (): ProviderSelectionSnapshot => ({
    providerId: selected !== null && eligible(selected) ? selected : null,
    selectionRequired: selected === null || !eligible(selected),
    revision,
    remember: remembered,
    blockers: [...leases.values(), ...(deps.externalBlockers?.() ?? [])].map((item) => ({ ...item })),
  });
  const assertActive = (id: string) => {
    const snapshot = get();
    if (selecting) throw new ConflictError('Provider selection is being persisted', snapshot);
    if (snapshot.selectionRequired) {
      throw new ConflictError('Choose an active CLI provider before starting work', {
        ...snapshot, code: 'provider_selection_required',
      });
    }
    if (snapshot.providerId !== id || !eligible(id)) {
      throw new ConflictError(`Provider '${id}' is not the active CLI provider`, {
        ...snapshot, code: 'provider_inactive',
      });
    }
  };
  const validate = (id: string) => {
    if (selecting) throw new ConflictError('Provider selection is being persisted', get());
    if (!eligible(id)) throw new ValidationError(`Provider '${id}' is not enabled and eligible`);
  };
  const commit = (id: string, remember: boolean): ProviderSelectionSnapshot => {
    const snapshot = get();
    if (selected !== id && snapshot.blockers.length > 0) {
      throw new ConflictError('Stop all CLI work before switching providers', {
        ...snapshot, code: 'provider_switch_blocked',
      });
    }
    if (selected === id && remembered === remember) return snapshot;
    deps.saveSelected(remember ? id : null);
    selected = id;
    remembered = remember;
    revision += 1;
    return get();
  };
  return {
    get,
    isEligible: eligible,
    assertActive,
    acquire(providerId, owner) {
      const id = providerId ?? get().providerId;
      assertActive(id ?? '');
      const key = ++sequence;
      leases.set(key, owner ?? { kind: 'execution', id: String(key), label: 'CLI execution' });
      return { providerId: id!, release: () => { leases.delete(key); } };
    },
    select(id, remember = true) {
      validate(id);
      selecting = true;
      try {
        return commit(id, remember);
      } finally {
        selecting = false;
      }
    },
    async switchTo(id, remember, expectedRevision, drain) {
      validate(id);
      if (expectedRevision !== revision) throw new ConflictError('CLI selection changed. Refresh and retry.', get());
      selecting = true;
      let drained = false;
      let committed = false;
      try {
        if (selected !== id) {
          await drain();
          drained = true;
        }
        if (!eligible(id)) throw new ValidationError(`Provider '${id}' is not enabled and eligible`);
        const snapshot = commit(id, remember);
        committed = true;
        return snapshot;
      } finally {
        selecting = false;
        if (drained && !committed && get().blockers.length === 0) deps.onSwitchFailed?.();
      }
    },
  };
}
