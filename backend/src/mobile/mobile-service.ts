import { ConflictError, NotFoundError, ProviderError, ValidationError } from '../kernel/error-types.js';
import type { NewTaskFileChange, NewTaskRun, NewTaskService } from '../new-task/new-task-contract.js';
import { derivePrBody, deriveTitle } from '../new-task/new-task-service.js';
import type { MobileConfig } from './config.js';
import { mobileHash } from './mobile-access.js';
import type { MobileApproval, MobileChat, MobileChatRecord, MobileChatRepo } from './mobile-contract.js';

export interface MobileServiceDeps {
  config: MobileConfig;
  repo: MobileChatRepo;
  task: NewTaskService;
  getRun(id: string): NewTaskRun | null;
  saveRun(run: NewTaskRun): void;
  createTask(repoId: string, problem: string): { featureId: string; attachmentId: string };
  repositories(): Array<{ id: string; name: string; remoteUrl?: string; defaultBranch?: string }>;
  revision(chat: MobileChatRecord, signal?: AbortSignal): Promise<{ head: string; branch: string; baseBranch: string; remoteUrl: string; files: NewTaskFileChange[] }>;
  publish(chat: MobileChatRecord, approval: MobileApproval, signal: AbortSignal): Promise<NewTaskRun>;
  createTerminal(chat: MobileChatRecord, signal: AbortSignal): Promise<string>;
  endTerminal(id: string): Promise<void>;
  terminalRunning(id: string): boolean;
  own(run: (signal: AbortSignal) => Promise<void>, featureId: string): Promise<void>;
  now(): string;
  id(): string;
  report(error: unknown): void;
  importRepository(name: string): Promise<{ id: string; name: string; remoteUrl: string; defaultBranch: string }>;
}

const busy = new Set(['planning', 'discussing', 'implementing', 'publishing']);

export function createMobileService(deps: MobileServiceDeps) {
  const jobs = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const imports = new Set<string>();
  const reads = new Set<string>();
  const save = (chat: MobileChatRecord): void => {
    chat.version++;
    chat.updatedAt = deps.now();
    deps.repo.save(chat);
  };
  const requireChat = (id: string): MobileChatRecord => {
    const chat = deps.repo.get(id);
    if (!chat) throw new NotFoundError('Mobile conversation not found.');
    return chat;
  };
  const message = (chat: MobileChatRecord, role: 'user' | 'assistant' | 'system', text: string, id = deps.id()): void => {
    if (chat.messages.length >= 256 || chat.messages.reduce((size, item) => size + item.text.length, 0) >= 400000) {
      throw new ConflictError('The conversation audit limit is reached. Start a new task; the existing checkout is preserved.');
    }
    chat.messages.push({ id, role, text: text.slice(0, 32000), at: deps.now() });
  };
  const idle = (chat: MobileChatRecord): void => {
    if (jobs.has(chat.id) || reads.has(chat.id)) throw new ConflictError('This conversation has work in progress.');
    if (chat.terminalSessionId) {
      throw new ConflictError('End the terminal before changing the plan, implementing, or publishing.');
    }
    if (jobs.size + imports.size + reads.size >= deps.config.maxJobs) throw new ConflictError('The mobile worker limit is reached. Wait for another task.');
  };
  const view = (chat: MobileChatRecord, includeRun = true): MobileChat => {
    if (busy.has(chat.status) && !jobs.has(chat.id)) {
      chat = requireChat(chat.id);
      chat.status = 'interrupted';
      chat.error = 'The host stopped before this operation settled. Nothing was retried automatically; review the current state before continuing.';
      save(chat);
    }
    const run = includeRun ? deps.getRun(chat.attachmentId) : null;
    return {
      ...chat, run, planHash: run?.plan ? mobileHash(run.plan) : null,
      terminalRunning: chat.terminalSessionId !== null && deps.terminalRunning(chat.terminalSessionId),
    };
  };
  const start = (
    chat: MobileChatRecord,
    status: MobileChatRecord['status'],
    run: (signal: AbortSignal) => Promise<void>,
  ): MobileChat => {
    idle(chat);
    const controller = new AbortController();
    chat.status = status;
    chat.error = null;
    save(chat);
    jobs.set(chat.id, controller);
    const timer = setTimeout(() => controller.abort(), deps.config.jobTimeoutMs);
    timer.unref();
    const operation = deps.own(async (hostSignal) => {
      const signal = AbortSignal.any([controller.signal, hostSignal]);
      signal.throwIfAborted();
      await run(signal);
      signal.throwIfAborted();
      save(chat);
    }, chat.featureId).catch((error: unknown) => {
      deps.report(error);
      chat.status = controller.signal.aborted ? 'interrupted' : 'failed';
      chat.error = error instanceof Error ? error.message : String(error);
      save(chat);
    }).finally(() => {
      clearTimeout(timer);
      jobs.delete(chat.id);
      pending.delete(operation);
    });
    pending.add(operation);
    return view(chat);
  };
  const requirePlan = (chat: MobileChatRecord): NewTaskRun & { plan: string; branch: string } => {
    const run = deps.getRun(chat.attachmentId);
    if (!run?.plan || !run.branch || run.status === 'pr-created') {
      throw new ValidationError('A reviewed, unpublished plan is required.');
    }
    return { ...run, plan: run.plan, branch: run.branch };
  };
  const reviewable = (chat: MobileChatRecord): void => {
    if (!['review-changes', 'failed', 'interrupted'].includes(chat.status) || chat.files.length === 0) {
      throw new ConflictError('Complete an implementation before reviewing publication.');
    }
  };
  return {
    bootstrap() {
      return { repositories: deps.repositories(), chats: deps.repo.list().map((chat) => view(chat, false)) };
    },
    get: (id: string) => view(requireChat(id)),
    create(input: { id: string; repoId: string; problem: string }): MobileChat {
      const existing = deps.repo.get(input.id);
      if (existing) {
        if (existing.repoId !== input.repoId || existing.messages[0].text !== input.problem) {
          throw new ConflictError('This request ID belongs to another conversation.');
        }
        return view(existing);
      }
      if (jobs.size + imports.size + reads.size >= deps.config.maxJobs || deps.repo.list().length >= deps.config.maxChats) {
        throw new ConflictError('The mobile task or worker limit is reached.');
      }
      if (!deps.repositories().some((repo) => repo.id === input.repoId)) {
        throw new ValidationError('Choose a GitHub repository already checked out on this host.');
      }
      const task = deps.createTask(input.repoId, input.problem);
      const now = deps.now();
      const chat: MobileChatRecord = {
        ...task, version: 0, id: input.id, repoId: input.repoId, title: deriveTitle(input.problem),
        status: 'planning', messages: [], proposal: null, files: [], approval: null,
        consumedApprovalId: null, terminalSessionId: null, error: null, createdAt: now, updatedAt: now,
      };
      message(chat, 'user', input.problem, input.id);
      deps.task.saveInputs(chat.attachmentId, chat.featureId, {
        problem: input.problem,
        context: deps.config.agentContext,
      });
      save(chat);
      return start(chat, 'planning', async (signal) => {
        const run = await deps.task.plan(chat.attachmentId, signal);
        signal.throwIfAborted();
        if (!run.plan || run.status !== 'planned') throw new ProviderError('The planner did not produce a complete plan.');
        chat.status = 'plan-ready';
        message(chat, 'assistant', run.plan);
      });
    },
    async importRepository(name: string) {
      const key = name.toLowerCase();
      if (imports.has(key) || imports.size + jobs.size + reads.size >= deps.config.maxJobs) {
        throw new ConflictError('A clone is already running or the mobile worker limit is reached. Refresh before retrying.');
      }
      imports.add(key);
      try { return await deps.importRepository(name); }
      finally { imports.delete(key); }
    },
    retryPlan(id: string): MobileChat {
      const chat = requireChat(id);
      idle(chat);
      const run = deps.getRun(chat.attachmentId);
      if (!['failed', 'interrupted'].includes(chat.status) || !run || run.plan || chat.files.length) {
        throw new ConflictError('Only an interrupted initial plan can be retried. Existing implementation changes are preserved.');
      }
      message(chat, 'system', 'Explicitly requested a new planning attempt. Implementation remains unapproved.');
      return start(chat, 'planning', async (signal) => {
        const planned = await deps.task.plan(chat.attachmentId, signal);
        signal.throwIfAborted();
        if (!planned.plan || planned.status !== 'planned') throw new ProviderError('The planner did not produce a complete plan.');
        chat.status = 'plan-ready';
        message(chat, 'assistant', planned.plan);
      });
    },
    discuss(id: string, input: { id: string; text: string }): MobileChat {
      const chat = requireChat(id);
      const existing = chat.messages.find((entry) => entry.id === input.id);
      if (existing) {
        if (existing.role !== 'user' || existing.text !== input.text) {
          throw new ConflictError('This message ID already belongs to another message.');
        }
        return view(chat);
      }
      idle(chat);
      if (chat.messages.length >= 180) throw new ConflictError('This conversation is full. Start a new task to continue.');
      if (chat.messages.reduce((size, entry) => size + entry.text.length, 0) > 200000) {
        throw new ConflictError('This conversation reached its history limit. Start a new task.');
      }
      const history = chat.messages.filter((entry) => entry.role !== 'system')
        .map((entry) => ({ role: entry.role as 'user' | 'assistant', content: entry.text }));
      message(chat, 'user', input.text, input.id);
      const previous = chat.status;
      return start(chat, 'discussing', async (signal) => {
        const result = await deps.task.refine(chat.attachmentId, history, input.text, signal);
        signal.throwIfAborted();
        chat.proposal = result.proposal;
        chat.status = previous;
        message(chat, 'assistant', result.reply);
      });
    },
    applyPlan(id: string, plan: string): MobileChat {
      const chat = requireChat(id);
      idle(chat);
      if (!chat.proposal || plan !== chat.proposal) throw new ConflictError('The proposed plan changed. Refresh before accepting it.');
      deps.task.applyRefinedPlan(chat.attachmentId, plan);
      chat.status = 'plan-ready';
      chat.proposal = null;
      chat.approval = null;
      chat.files = [];
      message(chat, 'system', 'Accepted the revised plan. Implementation still requires approval.');
      save(chat);
      return view(chat);
    },
    implement(id: string, planHash: string): MobileChat {
      const chat = requireChat(id);
      if ((chat.status === 'implementing' || chat.status === 'review-changes') && view(chat).planHash === planHash) return view(chat);
      idle(chat);
      const run = requirePlan(chat);
      if (!['plan-ready', 'failed', 'interrupted'].includes(chat.status) ||
          mobileHash(run.plan) !== planHash) {
        throw new ConflictError('The plan changed. Review it again before approving implementation.');
      }
      chat.approval = null;
      chat.files = [];
      message(chat, 'system', `Approved local implementation of plan ${planHash}. Publication is not approved.`);
      return start(chat, 'implementing', async (signal) => {
        let failure: string | null = null;
        let completed = false;
        await deps.task.implement(chat.attachmentId, {
          activity: () => undefined,
          agent: (agent) => {
            const current = deps.getRun(chat.attachmentId);
            if (current) deps.saveRun({ ...current, agents: [...current.agents.filter((item) => item.id !== agent.id), agent] });
          },
          done: (_run, files) => {
            completed = true;
            chat.files = files ?? [];
          },
          failed: (error) => { failure = error; },
        }, signal, { deferPublication: true });
        signal.throwIfAborted();
        if (!completed) throw new ProviderError(failure ?? 'Implementation ended without a result.');
        chat.status = 'review-changes';
        message(chat, 'assistant', 'Local implementation is ready. Review the changed files and test evidence, then request a publication preview. Nothing was published by the Studio workflow.');
      });
    },
    async preview(id: string, signal?: AbortSignal): Promise<MobileChat> {
      const chat = requireChat(id);
      idle(chat);
      reviewable(chat);
      const run = requirePlan(chat);
      reads.add(id);
      try {
        const { files, ...revision } = await deps.revision(chat, signal);
        const latest = requireChat(id);
        if (latest.version !== chat.version) throw new ConflictError('Conversation changed during review. Refresh and review again.');
        chat.files = files;
        chat.approval = {
          ...revision, repoId: chat.repoId, id: deps.id(), title: run.title?.trim() || deriveTitle(run.problem),
          body: derivePrBody(run), expiresAt: new Date(Date.parse(deps.now()) + deps.config.approvalTtlMs).toISOString(),
        };
        save(chat);
        return view(chat);
      } finally { reads.delete(id); }
    },
    publish(id: string, approvalId: string): MobileChat {
      const chat = requireChat(id);
      if (chat.consumedApprovalId === approvalId) return view(chat);
      idle(chat);
      reviewable(chat);
      const approval = chat.approval;
      if (!approval || approval.id !== approvalId || Date.parse(approval.expiresAt) <= Date.parse(deps.now())) {
        throw new ConflictError('Publication approval is missing, stale, or expired. Review a new preview.');
      }
      chat.consumedApprovalId = approvalId;
      message(chat, 'system', `Approved publication of exactly ${approval.head} to ${approval.branch}, base ${approval.baseBranch}.`);
      return start(chat, 'publishing', async (signal) => {
        const revision = await deps.revision(chat, signal);
        if (revision.head !== approval.head || revision.branch !== approval.branch ||
            revision.baseBranch !== approval.baseBranch || revision.remoteUrl !== approval.remoteUrl ||
            approval.repoId !== chat.repoId) {
          throw new ConflictError('The branch changed after review. Nothing was published; request a new preview.');
        }
        signal.throwIfAborted();
        const run = await deps.publish(chat, approval, signal);
        chat.status = 'pr-created';
        message(chat, 'assistant', `Pull request created: ${run.prUrl}`);
      });
    },
    cancel(id: string): MobileChat {
      const chat = requireChat(id);
      if (chat.status === 'publishing') throw new ConflictError('Publication may already have reached GitHub. Wait and inspect the result; cancellation cannot undo a push.');
      jobs.get(id)?.abort();
      return view(chat);
    },
    async terminal(id: string, confirmed: boolean): Promise<MobileChat> {
      const chat = requireChat(id);
      if (!confirmed) throw new ValidationError('Explicit full-host terminal consent is required.');
      if (chat.terminalSessionId) return view(chat);
      idle(chat);
      requirePlan(chat);
      const controller = new AbortController();
      jobs.set(chat.id, controller);
      const timer = setTimeout(() => controller.abort(), deps.config.jobTimeoutMs);
      timer.unref();
      try {
        chat.terminalSessionId = await deps.createTerminal(chat, controller.signal);
        chat.approval = null;
        message(chat, 'system', 'Authorized a direct host terminal. Commands entered here are owner actions, outside the agent publication workflow.');
        save(chat);
        return view(chat);
      } finally {
        clearTimeout(timer);
        jobs.delete(chat.id);
      }
    },
    async closeTerminal(id: string): Promise<MobileChat> {
      const chat = requireChat(id);
      if (jobs.has(id)) throw new ConflictError('Wait for terminal setup or the active operation before ending the terminal.');
      if (chat.terminalSessionId) await deps.endTerminal(chat.terminalSessionId);
      chat.terminalSessionId = null;
      save(chat);
      return view(chat);
    },
    terminalAllowed(sessionId: string): boolean {
      return deps.repo.list().some((chat) =>
        chat.terminalSessionId === sessionId && !busy.has(chat.status) && !jobs.has(chat.id));
    },
    async diff(id: string, path: string) {
      const chat = requireChat(id);
      if (jobs.has(id) || reads.has(id) || jobs.size + reads.size + imports.size >= deps.config.maxJobs) {
        throw new ConflictError('The mobile worker is busy. Retry this file after the current operation settles.');
      }
      reads.add(id);
      try { return await deps.task.fileDiff(chat.attachmentId, path); }
      finally { reads.delete(id); }
    },
    waitForIdle: async (): Promise<void> => { await Promise.all(pending); },
  };
}
export type MobileService = ReturnType<typeof createMobileService>;
