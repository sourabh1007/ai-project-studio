import type { NewTaskFileChange, NewTaskRun } from '../new-task/new-task-contract.js';

export type MobileStatus = 'planning' | 'plan-ready' | 'discussing' | 'implementing' |
  'review-changes' | 'publishing' | 'pr-created' | 'failed' | 'interrupted';
export interface MobileMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: string;
}
export interface MobileApproval {
  id: string;
  repoId: string;
  remoteUrl: string;
  head: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  expiresAt: string;
}
export interface MobileChatRecord {
  version: number;
  id: string;
  repoId: string;
  featureId: string;
  attachmentId: string;
  title: string;
  status: MobileStatus;
  messages: MobileMessage[];
  proposal: string | null;
  files: NewTaskFileChange[];
  approval: MobileApproval | null;
  consumedApprovalId: string | null;
  terminalSessionId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface MobileChat extends MobileChatRecord {
  run: NewTaskRun | null;
  planHash: string | null;
  terminalRunning: boolean;
}
export interface MobileChatRepo {
  get(id: string): MobileChatRecord | null;
  list(): MobileChatRecord[];
  save(chat: MobileChatRecord): void;
}
