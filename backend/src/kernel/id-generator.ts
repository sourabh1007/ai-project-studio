import { randomUUID } from 'node:crypto';

/** Generates unique identifiers. Injectable for deterministic tests. */
export interface IdGenerator {
  next(): string;
}

export function createIdGenerator(
  source: () => string = randomUUID,
): IdGenerator {
  return {
    next: () => source(),
  };
}
