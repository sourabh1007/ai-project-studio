import type { ApiClient } from '../../lib/api.js';
import type { Feature } from '../../lib/types.js';
import { mapWithConcurrency } from '../../lib/review-board-progress.js';
import type { SelectedPull } from './pr-review-picker.js';

export const PR_CHECKOUT_CONCURRENCY = 2;

export function bulkReviewName(date = new Date()): string {
  return `Bulk PR Review — ${date.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })}`;
}

export async function checkoutPulls(
  api: Pick<ApiClient, 'createPrFeatureStreamed'>,
  repoId: string,
  parentId: string,
  pulls: SelectedPull[],
  report: (message: string) => void,
  onImported?: (item: {
    feature: Feature;
    number: number;
    title: string;
    alreadyImported: boolean;
  }) => void,
): Promise<
  { feature: Feature; number: number; title: string; alreadyImported: boolean }[]
> {
  const states = pulls.map(() => 'Queued');
  const results = new Map<number, { feature: Feature; alreadyImported: boolean }>();
  const failures: string[] = [];
  let finished = 0;
  const publish = () => report([
    `${finished}/${pulls.length} finished · up to ${PR_CHECKOUT_CONCURRENCY} checkouts in parallel`,
    ...pulls.map((pull, index) => `#${pull.number} — ${states[index]}`),
  ].join('\n'));
  publish();
  await mapWithConcurrency(pulls.map((pull, index) => ({ pull, index })), PR_CHECKOUT_CONCURRENCY, async ({ pull, index }) => {
    states[index] = 'Starting checkout…';
    publish();
    try {
      const { feature, alreadyImported } = await api.createPrFeatureStreamed(repoId, pull.number, (status) => {
        states[index] = status.message;
        publish();
      }, parentId);
      results.set(pull.number, { feature, alreadyImported });
      onImported?.({ feature, ...pull, alreadyImported });
      states[index] = alreadyImported
        ? 'Already imported — skipped'
        : onImported ? 'Imported · review queued' : 'Ready';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      states[index] = `Failed: ${message}`;
      failures.push(`#${pull.number}: ${message}`);
    } finally {
      finished += 1;
      publish();
    }
  });
  // Drain every worker before allowing a retry; completed imports stay saved.
  if (failures.length) {
    throw new Error(`Some checkouts failed. Successful reviews are saved; retry to finish.\n${failures.join('\n')}`);
  }
  return pulls.map((pull) => {
    const result = results.get(pull.number)!;
    return { ...pull, feature: result.feature, alreadyImported: result.alreadyImported };
  });
}
