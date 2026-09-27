import { z } from 'zod';

export const SESSION_WORKTREE_NAMESPACE = 'sessionWorktree';
export const sessionWorktreeConfigSchema = z.object({
  gitTimeoutMs: z.number().int().positive(),
  checkoutTimeoutMs: z.number().int().positive(),
  checkoutWorkers: z.number().int().positive(),
});
export type SessionWorktreeConfig = z.infer<typeof sessionWorktreeConfigSchema>;
export const sessionWorktreeDefaults: SessionWorktreeConfig = {
  gitTimeoutMs: 20_000,
  checkoutTimeoutMs: 600_000,
  checkoutWorkers: 2,
};
