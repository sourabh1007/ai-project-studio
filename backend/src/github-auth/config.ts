import { z } from 'zod';

export const GITHUB_CLI_NAMESPACE = 'githubCli';
export const githubCliConfigSchema = z.object({
  executable: z.string().regex(/^[^\u0000-\u001f]+$/).trim().min(1).max(4096)
    .describe('GitHub CLI executable or path. Shared by desktop provisioning, authentication, repositories and CI. CW_GH_BIN takes precedence. Restart required.'),
});
export type GithubCliConfig = z.infer<typeof githubCliConfigSchema>;
export const githubCliDefaults: GithubCliConfig = { executable: 'gh' };
