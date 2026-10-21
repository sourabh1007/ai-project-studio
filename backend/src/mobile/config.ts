import { z } from 'zod';

export const MOBILE_NAMESPACE = 'mobile';
export const mobileConfigSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  publicOrigin: z.string(),
  accessKeyHash: z.string(),
  maxJobs: z.number().int().min(1).max(8),
  maxChats: z.number().int().min(1).max(1000),
  jobTimeoutMs: z.number().int().min(1000).max(3600000),
  approvalTtlMs: z.number().int().positive(),
  sessionTtlMs: z.number().int().positive(),
  maxSessions: z.number().int().min(1).max(32),
  loginAttemptsPerMinute: z.number().int().min(1).max(60),
  repositoryRoot: z.string(),
  agentContext: z.string().min(1),
});
export type MobileConfig = z.infer<typeof mobileConfigSchema>;
export const mobileDefaults: MobileConfig = {
  enabled: false,
  port: 4320,
  publicOrigin: '',
  accessKeyHash: '',
  maxJobs: 2,
  maxChats: 100,
  jobTimeoutMs: 1800000,
  approvalTtlMs: 600000,
  sessionTtlMs: 28800000,
  maxSessions: 8,
  loginAttemptsPerMinute: 10,
  repositoryRoot: '',
  agentContext: 'Mobile approval workflow: plan only until the owner approves implementation. Do not push, publish, or open a PR. All publication requires a separate owner approval in Studio. This is trusted host execution, not an untrusted-code sandbox.',
};
