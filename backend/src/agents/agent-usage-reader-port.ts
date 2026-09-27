/**
 * Read port over recorded metasession usage, aggregated by the stable
 * `usageLabel` an agent tags its runs with. Backed by the `meta_operations`
 * ledger, which already records one row per logical AI operation with a usage
 * snapshot — so no new per-run ledger is needed to show an agent's average
 * credit cost.
 */
export interface AgentUsageReader {
  /**
   * Total credits, total nano-AIU and the number of usage-recorded attempts
   * tagged with `label` (including its perspective labels and charged failures).
   */
  aggregateByLabel(label: string): {
    credits: number | null;
    nanoAiu: number | null;
    runs: number;
  };
}
