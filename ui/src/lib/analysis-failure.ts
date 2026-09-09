/**
 * Summarises why perspective analyses failed.
 *
 * The failure banner used to say only how many perspectives failed, which left
 * the reviewer to click each one to learn the cause — and when every
 * perspective shared a single cause (the backend went away mid-run) that was
 * ten clicks to read the same sentence. Report the shared cause up front.
 */
export function analysisFailureCause(
  errors: readonly (string | null | undefined)[],
): string | null {
  const distinct: string[] = [];
  for (const raw of errors) {
    const message = typeof raw === 'string' ? raw.trim() : '';
    if (message.length === 0) continue;
    if (!distinct.includes(message)) {
      distinct.push(message);
    }
  }
  if (distinct.length === 0) return null;
  if (distinct.length === 1) return distinct[0] as string;
  return `${distinct[0] as string} (and ${distinct.length - 1} other ${
    distinct.length - 1 === 1 ? 'cause' : 'causes'
  })`;
}
