/**
 * Parses the version string printed by `agency --version`. The CLI's exact
 * output format is not contractual, so this is deliberately lenient: it returns
 * the first semver-like token (e.g. `1.4.2`, `2.0.0-beta.1`) anywhere in the
 * output, falling back to the first non-empty trimmed line, and null when the
 * output carries nothing usable. Kept pure so the version-diff that drives the
 * "Agency was updated" notification is unit-testable.
 */
export function parseAgencyVersion(output: string): string | null {
  if (!output) {
    return null;
  }
  const semver = output.match(/\d+\.\d+\.\d+[A-Za-z0-9.+-]*/);
  if (semver) {
    return semver[0];
  }
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}
