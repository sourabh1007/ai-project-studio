import type { TextAttachmentsConfig } from './config.js';

export const textAttachmentIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface TextAttachment {
  sessionId: string;
  attachmentId: string;
  path: string;
  name: string;
  bytes: number;
}

export interface TextAttachmentMetadata {
  attachmentId: string;
  name: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

export interface TextAttachmentListing {
  items: TextAttachmentMetadata[];
  totalBytes: number;
  files: number;
}

export interface TextAttachmentStorage {
  usage(): Promise<{ files: number; bytes: number }>;
  list(): Promise<TextAttachmentListing>;
  remove(attachmentId: string, signal?: AbortSignal): Promise<void>;
  write(sessionId: string, content: Uint8Array, signal?: AbortSignal): Promise<Pick<TextAttachment, 'path' | 'name' | 'attachmentId'>>;
}

export interface TextAttachmentFailure {
  code: 'storage-unavailable' | 'cleanup-unconfirmed';
  errorName: string;
}

export type TextAttachmentFailureReporter = (failure: TextAttachmentFailure) => void;

export function textAttachmentFailure(code: TextAttachmentFailure['code'], error: unknown): TextAttachmentFailure {
  const errorName = error instanceof Error && ['Error', 'TypeError', 'RangeError', 'AbortError'].includes(error.name)
    ? error.name : 'Error';
  return { code, errorName };
}

export class TextAttachmentError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super('Text attachment could not be saved.');
  }
}

export interface TextAttachments {
  create(sessionId: string, content: unknown, signal?: AbortSignal): Promise<TextAttachment>;
  list(signal?: AbortSignal): Promise<TextAttachmentListing & { limits: TextAttachmentsConfig }>;
  remove(attachmentId: string, signal?: AbortSignal): Promise<{ attachmentId: string }>;
}
