import { z } from 'zod';

/** Configuration schema for the credit (cost) engine. */
export const CREDIT_NAMESPACE = 'credit';

const tokenRateSchema = z.object({
  inputPerToken: z.number(),
  outputPerToken: z.number(),
});

export const creditConfigSchema = z.object({
  /** Which strategy converts usage into credits. */
  activeStrategy: z.enum(['provider-cost', 'token-rate', 'premium-request']),
  /** Display unit for computed credits. */
  unit: z.string().min(1),
  /** provider-cost: scales the provider-reported cost. */
  providerCost: z.object({ multiplier: z.number() }),
  /** token-rate: per-token rates by resolved model, with a default. */
  tokenRate: z.object({
    default: tokenRateSchema,
    perModel: z.record(z.string(), tokenRateSchema),
  }),
  /** premium-request: credits charged per request by resolved model. */
  premiumRequest: z.object({
    default: z.number(),
    perModel: z.record(z.string(), z.number()),
  }),
});

export type TokenRate = z.infer<typeof tokenRateSchema>;
export type CreditConfig = z.infer<typeof creditConfigSchema>;

export const creditDefaults: CreditConfig = {
  activeStrategy: 'provider-cost',
  unit: 'credits',
  providerCost: { multiplier: 1 },
  tokenRate: {
    default: { inputPerToken: 0, outputPerToken: 0 },
    perModel: {},
  },
  premiumRequest: {
    default: 1,
    perModel: {},
  },
};
