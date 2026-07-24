import { z } from 'zod';

/** Configuration schema for the skills module. */
export const SKILLS_NAMESPACE = 'skills';

export const skillsConfigSchema = z.object({
  /** Maximum length of a skill name. */
  maxNameLength: z.number().int().positive(),
  /** Maximum length of a skill's instruction text. */
  maxInstructionsLength: z.number().int().positive(),
  /** Version stamped onto exported skill files and required on import. */
  exportSchemaVersion: z.number().int().positive(),
  /** Header prepended above the composed instruction block. */
  injectionHeader: z.string().min(1),
  /** Per-skill block template. Placeholders: {{name}}, {{instructions}}. */
  skillTemplate: z.string().min(1),
  /** Separator inserted between rendered skill blocks. */
  skillSeparator: z.string(),
  /** Separator inserted between the instruction block and the user prompt. */
  promptSeparator: z.string(),
  /** Suffix appended to a skill name when an imported name collides. */
  importConflictSuffix: z.string().min(1),
});

export type SkillsConfig = z.infer<typeof skillsConfigSchema>;

export const skillsDefaults: SkillsConfig = {
  maxNameLength: 80,
  maxInstructionsLength: 8000,
  exportSchemaVersion: 1,
  injectionHeader: [
    'The following project skills apply to this work.',
    'Follow their instructions carefully:',
  ].join('\n'),
  skillTemplate: ['## {{name}}', '{{instructions}}'].join('\n'),
  skillSeparator: '\n\n',
  promptSeparator: '\n\n---\n\n',
  importConflictSuffix: ' (imported)',
};
