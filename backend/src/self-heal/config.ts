import { z } from 'zod';
import { executableSchema } from '../provider/command-options.js';

export const SELF_HEAL_NAMESPACE = 'selfHeal';
export const selfHealConfigSchema = z.object({
  wingetExecutable: executableSchema,
  brewExecutable: executableSchema,
});
export type SelfHealConfig = z.infer<typeof selfHealConfigSchema>;
export const selfHealDefaults: SelfHealConfig = {
  wingetExecutable: 'winget',
  brewExecutable: 'brew',
};
