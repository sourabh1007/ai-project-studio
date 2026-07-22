import type { UsageEvent } from '../usage/usage-contract.js';

/** A pluggable rule converting a UsageEvent into a credit amount. */
export interface CreditStrategy {
  readonly id: string;
  compute(event: UsageEvent): number;
}

/** Result of costing a single usage event. */
export interface CreditResult {
  strategy: string;
  unit: string;
  credits: number;
}
