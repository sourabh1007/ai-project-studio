import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistentState } from './use-persistent-state.js';
import {
  isDirty,
  isDraftOrNull,
  makeDraft,
  resolveDraft,
  type Draft,
} from '../lib/draft-store.js';

export interface DraftController {
  /** The current editor text (draft if one was restored, else the base). */
  value: string;
  /** Update the working text; persists a draft locally unless it equals base. */
  setValue: (next: string) => void;
  /** Whether the working text diverges from the last-saved base value. */
  isDirty: boolean;
  /** True when a newer unsaved draft was restored over the base on load. */
  restored: boolean;
  /** Reset the editor to the base value and drop the persisted draft. */
  discard: () => void;
  /** Drop the persisted draft without changing the current text (post-save). */
  clear: () => void;
}

/**
 * Auto-saves an editor's unsaved text to local storage under `key` and restores
 * it across reloads/crashes (Phase 4f). It reconciles the persisted draft with
 * the last-saved `base` value: a draft is only surfaced (and flagged `restored`)
 * when it actually differs from the base. A background change to `base` (e.g. a
 * server refresh) is adopted only while the editor is untouched, so it never
 * clobbers in-progress edits.
 */
export function useDraft(key: string, base: string): DraftController {
  const [stored, setStored] = usePersistentState<Draft | null>(key, null, {
    validate: isDraftOrNull,
  });

  const initial = useRef(resolveDraft(stored, base));
  const [value, setValueState] = useState(initial.current.value);
  const [restored, setRestored] = useState(initial.current.restored);
  const prevBase = useRef(base);

  useEffect(() => {
    if (prevBase.current === base) {
      return;
    }
    // Follow the new base only if the editor still matches the old one (i.e. the
    // user has not started editing); otherwise preserve their in-progress text.
    setValueState((current) => (current === prevBase.current ? base : current));
    setRestored((wasRestored) => (value === prevBase.current ? false : wasRestored));
    prevBase.current = base;
  }, [base, value]);

  const setValue = useCallback(
    (next: string) => {
      setValueState(next);
      setRestored(false);
      setStored(
        next === base ? null : makeDraft(next, new Date().toISOString()),
      );
    },
    [base, setStored],
  );

  const discard = useCallback(() => {
    setValueState(base);
    setRestored(false);
    setStored(null);
  }, [base, setStored]);

  const clear = useCallback(() => {
    setRestored(false);
    setStored(null);
  }, [setStored]);

  return {
    value,
    setValue,
    isDirty: isDirty(value, base),
    restored,
    discard,
    clear,
  };
}
