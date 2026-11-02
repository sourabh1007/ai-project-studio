import { ApiError, type ApiClient } from './api.js';
import type { Feature } from './types.js';
import { isDefiniteRejection } from './operation-keys.js';

/** Imports that may run at once, across every repository and dialog. */
export const PR_IMPORT_CONCURRENCY = 2;
/** Queued + running + unresolved imports the store accepts before refusing more. */
export const PR_IMPORT_MAX_ACTIVE = 30;

export type PrImportStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled';

export interface PrImportJob {
  id: string;
  /** `${repoId}:${number}` — at most one live job per pull request. */
  key: string;
  repoId: string;
  repoName: string;
  batchId: string;
  /** Pull requests selected together; 1 means a single (un-grouped) import. */
  batchSize: number;
  number: number;
  title: string;
  parentFeatureId: string | null;
  parentGroupId: string | null;
  status: PrImportStatus;
  /** Latest human-readable phase (running) or outcome. */
  message: string;
  error: string | null;
  feature: Feature | null;
  /** The pull request had been imported before this job ran. */
  alreadyImported: boolean;
  attempt: number;
  createdAt: number;
  /** Last time the server reported progress; drives the "no update" hint. */
  updatedAt: number;
}

export interface PrImportBatch {
  id: string;
  repoId: string;
  repoName: string;
  /** The "Bulk PR Review" parent feature once created (multi-PR batches). */
  parent: Feature | null;
}

export type PrImportEvent = {
  type: 'imported';
  job: PrImportJob;
  batch: PrImportBatch;
};

export type PrImportApi = Pick<
  ApiClient,
  'createPrFeatureStreamed' | 'createFeature' | 'getFeature' | 'listFeatures'
>;

/** The slice of `Storage` the store persists through (injectable for tests). */
export interface PrImportStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PR_IMPORT_STORAGE_KEY = 'ai-project-studio.pr-imports.v1';

/** Per-batch bookkeeping for the multi-PR "Bulk PR Review" parent feature. */
interface BatchMeta {
  name: string;
  /** Unique reference embedded in the parent's description to find it again. */
  token: string;
  parentId: string | null;
  /** A create request was sent and its outcome has not been confirmed. */
  uncertain: boolean;
}

interface PersistedState {
  jobs: Omit<PrImportJob, 'feature' | 'error' | 'message' | 'alreadyImported'>[];
  batches: (Pick<PrImportBatch, 'id' | 'repoId' | 'repoName'> & BatchMeta)[];
}

export interface PrImportRequest {
  repo: { id: string; name: string };
  pulls: { number: number; title: string }[];
  parentFeatureId?: string | null;
  parentGroupId?: string | null;
  /** Name/description for the parent feature of a multi-PR batch. */
  batchName: string;
}

export interface PrImportEnqueueResult {
  accepted: string[];
  skipped: { number: number; reason: 'duplicate' | 'in-progress' | 'imported' | 'queue-full' }[];
}

const PARENT_UNKNOWN_MESSAGE =
  'Connection lost while creating the review group. “Check again” looks for the group before creating another, so it will not be duplicated.';
const RELOAD_MESSAGE =
  'The app was closed while this import was in progress. “Check again” verifies it without creating a duplicate.';
const NOT_STARTED_MESSAGE = 'Not started before the app was closed. Retry to import.';
const UNKNOWN_MESSAGE =
  'Connection lost — the import may still be running on the server. Use “Check again”; it will not create a duplicate.';

/** The server's message when it definitively rejected a request, else null (outcome unknown). */
function definiteMessage(error: unknown): string | null {
  return error instanceof ApiError && error.status !== 0 ? error.message : null;
}

const TERMINAL: readonly PrImportStatus[] = ['succeeded', 'failed', 'unknown', 'cancelled'];
const LIVE: readonly PrImportStatus[] = ['queued', 'running', 'unknown'];

export const isFinishedImport = (status: PrImportStatus): boolean =>
  status === 'succeeded' || status === 'cancelled' || status === 'failed';

/**
 * App-lifetime queue of pull-request imports. It lives outside React so closing
 * the picker, collapsing the tree or switching views never drops an import; UI
 * subscribes with `useSyncExternalStore`. Work is bounded to
 * {@link PR_IMPORT_CONCURRENCY} concurrent checkouts. The backend keeps
 * importing after a client disconnects, so a dropped stream is reported as
 * `unknown` and only re-checked on request — never retried automatically.
 */
export class PrImportStore {
  private jobs: PrImportJob[] = [];
  private snapshot: readonly PrImportJob[] = [];
  private readonly batches = new Map<string, PrImportBatch>();
  private readonly batchMeta = new Map<string, BatchMeta>();
  private defaultApi: PrImportApi | null = null;
  private readonly parentPromises = new Map<string, Promise<Feature>>();
  private readonly apis = new Map<string, PrImportApi>();
  private readonly delivered = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: PrImportEvent) => void>();
  private recovering = new Set<string>();
  private sequence = 0;
  private running = 0;
  private epoch = 0;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly storage: PrImportStorage | null = null,
    private readonly newToken: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.hydrate();
  }

  /** API used for imports restored after a reload (no enqueue call carried one). */
  bindApi(api: PrImportApi): void {
    this.defaultApi = api;
    this.pump();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly PrImportJob[] => this.snapshot;

  getBatch(batchId: string): PrImportBatch | undefined {
    return this.batches.get(batchId);
  }

  /**
   * Receives each successful import exactly once. Imports that finished while
   * nobody listened (view unmounted) are replayed to the first listener.
   */
  subscribeEvents(listener: (event: PrImportEvent) => void): () => void {
    this.eventListeners.add(listener);
    this.drainUndelivered();
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  enqueue(api: PrImportApi, request: PrImportRequest): PrImportEnqueueResult {
    const result: PrImportEnqueueResult = { accepted: [], skipped: [] };
    const seen = new Set<number>();
    const fresh: { number: number; title: string }[] = [];
    let active = this.jobs.filter((job) => LIVE.includes(job.status)).length;
    for (const pull of request.pulls) {
      const key = `${request.repo.id}:${pull.number}`;
      const existing = this.jobs.find((job) => job.key === key);
      if (seen.has(pull.number)) {
        result.skipped.push({ number: pull.number, reason: 'duplicate' });
      } else if (existing && LIVE.includes(existing.status)) {
        result.skipped.push({ number: pull.number, reason: 'in-progress' });
      } else if (existing?.status === 'succeeded') {
        result.skipped.push({ number: pull.number, reason: 'imported' });
      } else if (active >= PR_IMPORT_MAX_ACTIVE) {
        result.skipped.push({ number: pull.number, reason: 'queue-full' });
      } else {
        fresh.push(pull);
        active += 1;
      }
      seen.add(pull.number);
    }
    if (fresh.length === 0) return result;

    const batchId = `batch-${(this.sequence += 1)}`;
    this.batches.set(batchId, {
      id: batchId,
      repoId: request.repo.id,
      repoName: request.repo.name,
      parent: null,
    });
    this.batchMeta.set(batchId, {
      name: request.batchName,
      token: this.newToken(),
      parentId: null,
      uncertain: false,
    });
    const now = this.clock();
    const created = fresh.map((pull): PrImportJob => {
      const key = `${request.repo.id}:${pull.number}`;
      // A failed/cancelled predecessor is replaced rather than stacked.
      const replaced = this.jobs.find((job) => job.key === key);
      if (replaced) this.forget(replaced);
      this.jobs = this.jobs.filter((job) => job.key !== key);
      return {
        id: `import-${(this.sequence += 1)}`,
        key,
        repoId: request.repo.id,
        repoName: request.repo.name,
        batchId,
        batchSize: fresh.length,
        number: pull.number,
        title: pull.title,
        parentFeatureId: request.parentFeatureId ?? null,
        parentGroupId: request.parentGroupId ?? null,
        status: 'queued',
        message: 'Queued',
        error: null,
        feature: null,
        alreadyImported: false,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      };
    });
    for (const job of created) {
      this.apis.set(job.id, api);
      result.accepted.push(job.id);
    }
    this.jobs = [...this.jobs, ...created];
    this.publish();
    this.pump();
    return result;
  }

  /** Queued imports only: a running checkout cannot be interrupted server-side. */
  cancel(id: string): void {
    this.update(id, (job) =>
      job.status === 'queued'
        ? { ...job, status: 'cancelled', message: 'Cancelled' }
        : job,
    );
  }

  /** Re-run a failed import, or re-check one whose outcome was unknown. */
  retry(id: string): void {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || (job.status !== 'failed' && job.status !== 'unknown')) return;
    if (!this.apiFor(id)) return;
    if (job.status === 'unknown') this.recovering.add(id);
    this.update(id, (current) => ({
      ...current,
      status: 'queued',
      message: job.status === 'unknown' ? 'Queued to check again' : 'Queued to retry',
      error: null,
      attempt: current.attempt + 1,
    }));
    this.pump();
  }

  dismiss(id: string): void {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || !TERMINAL.includes(job.status)) return;
    this.forget(job);
    this.jobs = this.jobs.filter((item) => item.id !== id);
    this.publish();
  }

  clearFinished(): void {
    const keep: PrImportJob[] = [];
    for (const job of this.jobs) {
      if (isFinishedImport(job.status)) this.forget(job);
      else keep.push(job);
    }
    if (keep.length === this.jobs.length) return;
    this.jobs = keep;
    this.publish();
  }

  /** Forget everything and ignore results still in flight (tests, sign-out). */
  reset(): void {
    this.epoch += 1;
    this.jobs = [];
    this.batches.clear();
    this.parentPromises.clear();
    this.apis.clear();
    this.delivered.clear();
    this.batchMeta.clear();
    this.defaultApi = null;
    this.recovering = new Set();
    this.running = 0;
    this.publish();
  }

  private forget(job: PrImportJob): void {
    this.apis.delete(job.id);
    this.delivered.delete(job.id);
    this.recovering.delete(job.id);
    if (!this.jobs.some((item) => item.id !== job.id && item.batchId === job.batchId)) {
      this.batches.delete(job.batchId);
      this.parentPromises.delete(job.batchId);
      this.batchMeta.delete(job.batchId);
    }
  }

  private publish(): void {
    this.snapshot = [...this.jobs];
    this.save();
    for (const listener of [...this.listeners]) listener();
  }

  private update(id: string, change: (job: PrImportJob) => PrImportJob): void {
    let changed = false;
    this.jobs = this.jobs.map((job) => {
      if (job.id !== id) return job;
      const next = change(job);
      if (next === job) return job;
      changed = true;
      return { ...next, updatedAt: this.clock() };
    });
    if (changed) this.publish();
  }

  private pump(): void {
    while (this.running < PR_IMPORT_CONCURRENCY) {
      const next = this.jobs.find((job) => job.status === 'queued' && this.apiFor(job.id));
      if (!next) return;
      const api = this.apiFor(next.id)!;
      const epoch = this.epoch;
      this.running += 1;
      this.update(next.id, (job) => ({ ...job, status: 'running', message: 'Starting checkout…' }));
      void this.run(next, api, epoch);
    }
  }

  private current(id: string, attempt: number, epoch: number): PrImportJob | undefined {
    if (epoch !== this.epoch) return undefined;
    const job = this.jobs.find((item) => item.id === id);
    return job && job.attempt === attempt ? job : undefined;
  }

  private apiFor(id: string): PrImportApi | null {
    return this.apis.get(id) ?? this.defaultApi;
  }

  /**
   * Resolves the batch's parent feature without ever blindly creating a second
   * one. A create whose response was lost (or whose app closed mid-request)
   * leaves the batch `uncertain`; the next attempt first looks the group up by
   * its unique reference, then retries the same durable operation key if the
   * group is absent from the read.
   */
  private parentFor(job: PrImportJob, api: PrImportApi, epoch: number): Promise<Feature> {
    const existing = this.parentPromises.get(job.batchId);
    if (existing) return existing;
    const meta = this.batchMeta.get(job.batchId)!;
    const batch = this.batches.get(job.batchId)!;
    const resolve = async (): Promise<Feature> => {
      if (meta.parentId) return api.getFeature(meta.parentId);
      if (meta.uncertain) {
        const found = (await api.listFeatures()).find(
          (feature) => feature.description?.includes(meta.token),
        );
        if (found) return found;
      }
      if (!this.current(job.id, job.attempt, epoch)) throw new Error('PR import cancelled');
      meta.uncertain = true;
      this.save();
      try {
        return await api.createFeature({
          name: meta.name,
          description: `Reviewing ${job.batchSize} pull requests from ${job.repoName}.\n\nImport reference: ${meta.token}`,
          repoId: job.repoId,
          parentFeatureId: job.parentFeatureId,
        }, { operationKey: `pr-import-parent-${meta.token}` });
      } catch (error) {
        // Server/gateway failures can lose a committed response too.
        if (isDefiniteRejection(error)) {
          meta.uncertain = false;
          this.save();
        }
        throw error;
      }
    };
    const created = resolve().then((parent) => {
      if (!this.current(job.id, job.attempt, epoch)) throw new Error('PR import cancelled');
      batch.parent = parent;
      meta.parentId = parent.id;
      meta.uncertain = false;
      this.save();
      return parent;
    });
    this.parentPromises.set(job.batchId, created);
    created.catch(() => {
      if (this.parentPromises.get(job.batchId) === created) {
        this.parentPromises.delete(job.batchId);
      }
    });
    return created;
  }

  private async run(job: PrImportJob, api: PrImportApi, epoch: number): Promise<void> {
    const { id, attempt } = job;
    try {
      if (!this.current(id, attempt, epoch)) return;
      let parent: Feature | null;
      try {
        parent = job.batchSize === 1 ? null : await this.parentFor(job, api, epoch);
      } catch (error) {
        const message = isDefiniteRejection(error) ? (error as ApiError).message : null;
        this.settle(
          id,
          attempt,
          epoch,
          message === null ? 'unknown' : 'failed',
          message === null ? PARENT_UNKNOWN_MESSAGE : `Could not prepare the review group: ${message}`,
        );
        return;
      }
      if (!this.current(id, attempt, epoch)) return;
      const { feature, alreadyImported } = await api.createPrFeatureStreamed(
        job.repoId,
        job.number,
        (status) => {
          if (this.current(id, attempt, epoch)) {
            this.update(id, (item) => ({ ...item, message: status.message }));
          }
        },
        parent?.id ?? job.parentFeatureId,
        job.parentGroupId,
      );
      if (!this.current(id, attempt, epoch)) return;
      // After an unknown outcome the server finished our own import, so it is
      // not "already imported" from the user's point of view.
      const existed = alreadyImported && !this.recovering.delete(id);
      this.update(id, (item) => ({
        ...item,
        status: 'succeeded',
        message: existed ? 'Already imported' : 'Imported · review queued',
        error: null,
        feature,
        alreadyImported: existed,
      }));
      this.drainUndelivered();
    } catch (error) {
      // A server error line is a definite failure; a transport error or a
      // stream that ended without a result leaves the outcome unknown.
      const message = definiteMessage(error);
      this.settle(id, attempt, epoch, message === null ? 'unknown' : 'failed', message ?? UNKNOWN_MESSAGE);
    } finally {
      if (epoch === this.epoch) {
        this.running -= 1;
        this.pump();
      }
    }
  }

  private settle(
    id: string,
    attempt: number,
    epoch: number,
    status: 'failed' | 'unknown',
    error: string,
  ): void {
    if (!this.current(id, attempt, epoch)) return;
    if (status === 'failed') this.recovering.delete(id);
    this.update(id, (item) => ({
      ...item,
      status,
      message: status === 'failed' ? 'Failed' : 'Outcome unknown',
      error,
    }));
  }

  private save(): void {
    if (!this.storage) return;
    const live = this.jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'unknown');
    const batchIds = new Set(live.map((job) => job.batchId));
    const state: PersistedState = {
      jobs: live.map(({ feature: _f, error: _e, message: _m, alreadyImported: _a, ...rest }) => rest),
      batches: [...batchIds].map((id) => ({
        id,
        repoId: this.batches.get(id)!.repoId,
        repoName: this.batches.get(id)!.repoName,
        ...this.batchMeta.get(id)!,
      })),
    };
    try {
      this.storage.setItem(PR_IMPORT_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage may be full or blocked; the in-memory queue keeps working.
    }
  }

  /**
   * Restores imports that were in flight when the app closed. Nothing is
   * resumed automatically: a request that may have reached the server is
   * `unknown` until the user checks it; one that never started can be retried.
   */
  private hydrate(): void {
    let state: Partial<PersistedState> = {};
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(PR_IMPORT_STORAGE_KEY) ?? '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      state = parsed as Partial<PersistedState>;
    } catch {
      return;
    }
    const str = (v: unknown): v is string => typeof v === 'string';
    for (const raw of Array.isArray(state.batches) ? state.batches : []) {
      if (!str(raw?.id) || !str(raw.repoId) || !str(raw.repoName) || !str(raw.name) || !str(raw.token)) continue;
      this.batches.set(raw.id, { id: raw.id, repoId: raw.repoId, repoName: raw.repoName, parent: null });
      this.batchMeta.set(raw.id, {
        name: raw.name,
        token: raw.token,
        parentId: str(raw.parentId) ? raw.parentId : null,
        uncertain: raw.uncertain === true,
      });
    }
    for (const raw of Array.isArray(state.jobs) ? state.jobs : []) {
      if (
        !str(raw?.id) || !str(raw.key) || !str(raw.repoId) || !str(raw.repoName) || !str(raw.title) ||
        !str(raw.batchId) || !this.batches.has(raw.batchId) || !Number.isSafeInteger(raw.number)
      ) continue;
      const neverStarted = raw.status === 'queued';
      this.jobs.push({
        ...raw,
        batchSize: Number.isSafeInteger(raw.batchSize) ? raw.batchSize : 1,
        parentFeatureId: str(raw.parentFeatureId) ? raw.parentFeatureId : null,
        parentGroupId: str(raw.parentGroupId) ? raw.parentGroupId : null,
        attempt: Number.isSafeInteger(raw.attempt) ? raw.attempt : 1,
        status: neverStarted ? 'failed' : 'unknown',
        message: neverStarted ? 'Not started' : 'Outcome unknown',
        error: neverStarted ? NOT_STARTED_MESSAGE : RELOAD_MESSAGE,
        feature: null,
        alreadyImported: false,
      });
      if (!neverStarted) this.recovering.add(raw.id);
      const n = Number(/(\d+)$/.exec(raw.id)?.[1] ?? 0);
      this.sequence = Math.max(this.sequence, n);
    }
    this.snapshot = [...this.jobs];
  }

  private drainUndelivered(): void {
    if (this.eventListeners.size === 0) return;
    for (const job of this.jobs) {
      const batch = this.batches.get(job.batchId);
      if (job.status !== 'succeeded' || !batch || this.delivered.has(job.id)) continue;
      this.delivered.add(job.id);
      for (const listener of [...this.eventListeners]) {
        listener({ type: 'imported', job, batch });
      }
    }
  }
}

export function storageOf(scope: { localStorage?: PrImportStorage }): PrImportStorage | null {
  return scope.localStorage ?? null;
}

export const prImportStore = new PrImportStore(Date.now, storageOf(globalThis));
