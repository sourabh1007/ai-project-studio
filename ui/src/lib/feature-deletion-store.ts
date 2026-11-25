import { ApiError } from './api.js';
import type { Feature } from './types.js';

export interface FeatureDeletionJob {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  message: string;
}

const active = (job: FeatureDeletionJob) => job.status === 'queued' || job.status === 'running';
const MAX_JOBS = 30;

/** App-lifetime work: navigation and closing the confirmation must not cancel deletion. */
export class FeatureDeletionStore {
  private jobs: readonly FeatureDeletionJob[] = [];
  private listeners = new Set<() => void>();
  private work = new Map<string, () => Promise<void>>();
  private running = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 500)),
  ) {}

  getSnapshot = (): readonly FeatureDeletionJob[] => this.jobs;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  enqueue(feature: Pick<Feature, 'id' | 'name'>, work: () => Promise<void>): boolean {
    if (this.jobs.some((job) => job.id === feature.id && active(job))) return true;
    if (this.jobs.filter(active).length >= MAX_JOBS) return false;
    this.jobs = this.jobs.filter((job) => job.id !== feature.id);
    if (this.jobs.length >= MAX_JOBS) {
      const oldest = this.jobs.find((job) => !active(job))!;
      this.jobs = this.jobs.filter((job) => job !== oldest);
    }
    this.jobs = [...this.jobs, {
      id: feature.id, name: feature.name, status: 'queued', message: 'Queued for deletion',
    }];
    this.work.set(feature.id, work);
    this.emit();
    void this.pump();
    return true;
  }

  dismiss(id: string): void {
    this.jobs = this.jobs.filter((job) => job.id !== id || active(job));
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private update(id: string, status: FeatureDeletionJob['status'], message: string): void {
    this.jobs = this.jobs.map((job) => job.id === id ? { ...job, status, message } : job);
    this.emit();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.jobs.find((entry) => entry.status === 'queued'); job;
        job = this.jobs.find((entry) => entry.status === 'queued')) {
        const work = this.work.get(job.id)!;
        this.update(job.id, 'running', 'Deleting feature and its sessions');
        const deadline = this.now() + 30_000;
        try {
          for (;;) {
            try {
              await work();
              break;
            } catch (error) {
              if (!(error instanceof ApiError) || error.status !== 409 || this.now() >= deadline) throw error;
              this.update(job.id, 'running', 'Waiting for active work to stop');
              await this.pause();
            }
          }
          this.work.delete(job.id);
          this.update(job.id, 'succeeded', 'Deleted');
        } catch (error) {
          this.work.delete(job.id);
          this.update(job.id, 'failed',
            `Deletion not confirmed: ${error instanceof Error ? error.message : String(error)}. Check the feature before trying Delete feature again.`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export const featureDeletionStore = new FeatureDeletionStore();
