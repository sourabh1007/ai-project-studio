import { z } from 'zod';

export const DESKTOP_RUNTIME_NAMESPACE = 'desktopRuntime';
export const desktopRuntimeConfigSchema = z.object({
  nodeExecutable: z.string().regex(/^[^\u0000-\u001f]*$/).trim().max(4096)
    .describe('Desktop Node.js override. Empty uses the managed compatible runtime. Read before provisioning on desktop restart; CW_NODE_BIN takes precedence. The runtime must match native addon compatibility.'),
});
export type DesktopRuntimeConfig = z.infer<typeof desktopRuntimeConfigSchema>;
export const desktopRuntimeDefaults: DesktopRuntimeConfig = { nodeExecutable: '' };
