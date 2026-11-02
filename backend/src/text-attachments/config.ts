import { z } from 'zod';

export const TEXT_ATTACHMENTS_NAMESPACE = 'textAttachments';
export const textAttachmentsConfigSchema = z.object({
  fileBytes: z.number().int().min(1).max(4 * 1024 * 1024),
  totalBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  files: z.number().int().min(1).max(64),
});
export type TextAttachmentsConfig = z.infer<typeof textAttachmentsConfigSchema>;
export const textAttachmentsDefaults: TextAttachmentsConfig = {
  fileBytes: 4 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  files: 64,
};
