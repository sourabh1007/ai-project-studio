import { z } from 'zod';

/** Configuration schema for the usage (OpenTelemetry ingest) module. */
export const USAGE_NAMESPACE = 'usage';

const attributeKeysSchema = z.object({
  operation: z.string().min(1),
  provider: z.string().min(1),
  requestModel: z.string().min(1),
  responseModel: z.string().min(1),
  inputTokens: z.string().min(1),
  outputTokens: z.string().min(1),
  reasoningOutputTokens: z.string().min(1),
  cost: z.string().min(1),
  nanoAiu: z.string().min(1),
  serviceRequestId: z.string().min(1),
});

const resourceKeysSchema = z.object({
  featureId: z.string().min(1),
  sessionId: z.string().min(1),
});

export const usageConfigSchema = z.object({
  /** Span operation names that count as billable inference calls. */
  includeOperations: z.array(z.string().min(1)),
  /** Span attribute key names carrying usage data (provider-versioned). */
  attributeKeys: attributeKeysSchema,
  /** Resource attribute key names carrying feature/session attribution. */
  resourceKeys: resourceKeysSchema,
  /**
   * Cadence (ms) for polling the CLI's own usage store while a session runs.
   * Drives the live credit/token/model meter for interactive terminal sessions.
   */
  livePollIntervalMs: z.number().int().positive(),
});

export type UsageAttributeKeys = z.infer<typeof attributeKeysSchema>;
export type UsageResourceKeys = z.infer<typeof resourceKeysSchema>;
export type UsageConfig = z.infer<typeof usageConfigSchema>;

export const usageDefaults: UsageConfig = {
  includeOperations: ['chat'],
  attributeKeys: {
    operation: 'gen_ai.operation.name',
    provider: 'gen_ai.provider.name',
    requestModel: 'gen_ai.request.model',
    responseModel: 'gen_ai.response.model',
    inputTokens: 'gen_ai.usage.input_tokens',
    outputTokens: 'gen_ai.usage.output_tokens',
    reasoningOutputTokens: 'gen_ai.usage.reasoning.output_tokens',
    cost: 'github.copilot.cost',
    nanoAiu: 'github.copilot.nano_aiu',
    serviceRequestId: 'github.copilot.service_request_id',
  },
  resourceKeys: {
    featureId: 'feature.id',
    sessionId: 'session.id',
  },
  livePollIntervalMs: 1500,
};
