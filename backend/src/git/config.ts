import { z } from 'zod';

export const GIT_NAMESPACE = 'git';
export const gitConfigSchema = z.object({
  executable: z.string().regex(/^[^\u0000-\u001f]+$/).trim().min(1).max(4096)
    .describe('Git executable or path. Shared by desktop provisioning and every IDE Git operation. CW_GIT_BIN takes precedence. Restart required.'),
});
export type GitConfig = z.infer<typeof gitConfigSchema>;
export const gitDefaults: GitConfig = { executable: 'git' };
