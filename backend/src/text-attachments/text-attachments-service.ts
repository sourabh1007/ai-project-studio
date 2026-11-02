import { isUtf8 } from 'node:buffer';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TextAttachmentsConfig } from './config.js';
import { TextAttachmentError, textAttachmentFailure, textAttachmentIdPattern, type TextAttachments, type TextAttachmentStorage, type TextAttachmentFailureReporter } from './text-attachments-contract.js';

export function createTextAttachments(deps: {
  sessions: Pick<SessionRepo, 'get'>;
  storage: TextAttachmentStorage;
  config: TextAttachmentsConfig;
  reportFailure: TextAttachmentFailureReporter;
}): TextAttachments {
  let busy = false;
  const runSafely = async <T>(run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof TextAttachmentError) throw error;
      deps.reportFailure(textAttachmentFailure('storage-unavailable', error));
      throw new TextAttachmentError('storage-unavailable', 503);
    }
  };
  const exclusive = async <T>(run: () => Promise<T>, signal?: AbortSignal) => {
    if (signal?.aborted) throw new TextAttachmentError('cancelled', 409);
    if (busy) throw new TextAttachmentError('busy', 429);
    busy = true;
    try {
      return await runSafely(run);
    } finally {
      busy = false;
    }
  };
  return {
    async create(sessionId, content, signal) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new TextAttachmentError('invalid-session', 400);
      if (!deps.sessions.get(sessionId)) throw new TextAttachmentError('unknown-session', 404);
      if (!(content instanceof Uint8Array) || content.byteLength === 0) throw new TextAttachmentError('invalid-text', 400);
      if (content.byteLength > deps.config.fileBytes) throw new TextAttachmentError('text-too-large', 413);
      if (!isUtf8(content)) throw new TextAttachmentError('invalid-utf8', 400);
      return exclusive(async () => {
        const usage = await deps.storage.usage();
        if (usage.files >= deps.config.files || usage.bytes + content.byteLength > deps.config.totalBytes) {
          throw new TextAttachmentError('quota', 507);
        }
        if (signal?.aborted) throw new TextAttachmentError('cancelled', 409);
        const result = await deps.storage.write(sessionId, content, signal);
        return { ...result, sessionId, bytes: content.byteLength };
      }, signal);
    },
    list(signal) {
      return exclusive(async () => ({ ...await deps.storage.list(), limits: { ...deps.config } }), signal);
    },
    async remove(attachmentId, signal) {
      if (!textAttachmentIdPattern.test(attachmentId)) throw new TextAttachmentError('invalid-attachment-id', 400);
      return exclusive(async () => {
        await deps.storage.remove(attachmentId, signal);
        return { attachmentId };
      }, signal);
    },
  };
}
