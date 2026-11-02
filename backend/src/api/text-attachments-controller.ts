import { TextAttachmentError, type TextAttachments } from '../text-attachments/text-attachments-contract.js';
import type { Route } from './http-contract.js';

function failure(error: unknown) {
  if (!(error instanceof TextAttachmentError)) throw error;
  return { status: error.status, body: { error: { kind: 'text_attachment', code: error.code, message: error.message } } };
}

export function createTextAttachmentRoutes(attachments: TextAttachments): Route[] {
  return [{
    method: 'post',
    path: '/sessions/:sessionId/text-attachments',
    handler: async (req) => {
      try {
        return { status: 201, body: await attachments.create(req.params.sessionId, req.body, req.signal) };
      } catch (error) {
        return failure(error);
      }
    },
  }, {
    method: 'get',
    path: '/text-attachments',
    handler: async (req) => {
      try {
        return { status: 200, body: await attachments.list(req.signal) };
      } catch (error) {
        return failure(error);
      }
    },
  }, {
    method: 'delete',
    path: '/text-attachments/:attachmentId',
    handler: async (req) => {
      try {
        return { status: 200, body: await attachments.remove(req.params.attachmentId, req.signal) };
      } catch (error) {
        return failure(error);
      }
    },
  }];
}
