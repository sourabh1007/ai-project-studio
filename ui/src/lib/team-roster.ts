/**
 * Pure, DOM-free model for the user's PR-review "team" roster — the explicit
 * list of teammates whose open pull requests the Team tab shows. Keeping the
 * whole thing pure (parse, normalize, add/remove, membership test, persistence
 * against a {@link KeyValueStore}) means it is unit-tested to 100% without a
 * DOM, and the exact same logic runs in the React hook and any preview.
 *
 * The roster is a flat list of author display names (as they appear on the
 * pull requests), matched case-insensitively so "Ada Lovelace" and
 * "ada lovelace" are the same teammate. It is stored globally (one "my team"
 * for the user) rather than per-repository, so it survives restarts and follows
 * the reviewer across every repo they open.
 */

import {
  readPersisted,
  writePersisted,
  type KeyValueStore,
} from './persisted-state.js';

/** localStorage key holding the user's saved team roster (a JSON string[]). */
export const TEAM_ROSTER_STORAGE_KEY = 'prReviewTeamMembers';

/** Upper bound on roster size, guarding against runaway/corrupt persistence. */
export const MAX_TEAM_MEMBERS = 200;

/** A type guard for a JSON array of strings. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Normalize a raw roster: trim each entry, drop blanks, remove case-insensitive
 * duplicates (keeping the first spelling seen), sort case-insensitively, and cap
 * the length. The result is stable so equal rosters serialize identically.
 */
export function normalizeTeamRoster(value: unknown): string[] {
  const raw = isStringArray(value) ? value : [];
  const seen = new Set<string>();
  const members: string[] = [];
  for (const entry of raw) {
    const name = entry.trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    members.push(name);
  }
  members.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return members.slice(0, MAX_TEAM_MEMBERS);
}

/** Add a teammate (no-op when blank or already present), returning a new roster. */
export function addTeamMember(roster: readonly string[], name: string): string[] {
  return normalizeTeamRoster([...roster, name]);
}

/** Remove a teammate by case-insensitive name, returning a new roster. */
export function removeTeamMember(
  roster: readonly string[],
  name: string,
): string[] {
  const target = name.trim().toLowerCase();
  return normalizeTeamRoster(
    roster.filter((member) => member.toLowerCase() !== target),
  );
}

/** Whether an author (PR author display name) is on the roster. */
export function isTeamMember(
  roster: readonly string[],
  author: string | null | undefined,
): boolean {
  if (!author) {
    return false;
  }
  const target = author.trim().toLowerCase();
  if (!target) {
    return false;
  }
  return roster.some((member) => member.toLowerCase() === target);
}

/** Read and normalize the saved roster, falling back to an empty roster. */
export function loadTeamRoster(store: KeyValueStore): string[] {
  return normalizeTeamRoster(
    readPersisted(store, TEAM_ROSTER_STORAGE_KEY, isStringArray, []),
  );
}

/** Persist a roster (normalized first); returns whether the write succeeded. */
export function saveTeamRoster(
  store: KeyValueStore,
  roster: readonly string[],
): boolean {
  return writePersisted(
    store,
    TEAM_ROSTER_STORAGE_KEY,
    normalizeTeamRoster(roster as string[]),
  );
}
