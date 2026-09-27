import { ValidationError } from '../kernel/error-types.js';

/** Accept only exact repository-relative paths, without normalization. */
export function isRepoRelativePath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    !/[:\\\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function assertExpectedHeadSha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('A non-empty string "expectedHeadSha" is required.');
  }
}

/** Inspect only captured rows, never infer a line from a hunk's advertised range. */
export function hasCapturedRightLine(diff: string, target: number): boolean {
  let rightLine = 0;
  let remaining = 0;
  for (const row of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (hunk) {
      rightLine = Number(hunk[1]);
      remaining = Number(hunk[2] ?? 1);
    } else if (remaining > 0) {
      if (row.startsWith('+') || row.startsWith(' ')) {
        if (rightLine === target) return true;
        rightLine += 1;
        remaining -= 1;
      } else if (!row.startsWith('-') && row !== '\\ No newline at end of file') {
        remaining = 0;
      }
    }
  }
  return false;
}
