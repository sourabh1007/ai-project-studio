import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { backgroundWorkDefaults, backgroundWorkConfigSchema } from './background-work-config.js';
import { createBackgroundWorkRunner } from './background-work-runner.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const config = { ...backgroundWorkDefaults, maxWorkers: 1, maxQueued: 2 };
afterEach(() => { vi.useRealTimers(); });

describe('isolated background work', () => {
  it('has valid resource bounds', () => {
    expect(backgroundWorkConfigSchema.parse(backgroundWorkDefaults)).toEqual(backgroundWorkDefaults);
    expect(() => backgroundWorkConfigSchema.parse({ ...config, maxWorkers: 0 })).toThrow();
  });

  it('bounds workers, queues FIFO, reports progress, and releases after termination', async () => {
    const tasks = [deferred<number>(), deferred<number>()];
    const stopped = deferred<void>();
    const states: string[] = [];
    const progress: string[] = [];
    const spawn = vi.fn((input: number, report: (message: string) => void) => {
      report('reading');
      return { result: tasks[input].promise, terminate: () => input === 0 ? stopped.promise : Promise.resolve() };
    });
    const runner = createBackgroundWorkRunner({ config, spawn });
    const first = runner.run(0, { onProgress: (s) => progress.push(s) });
    const second = runner.run(1, { onState: (s) => states.push(s) });
    expect(runner.stats()).toMatchObject({ active: 1, queued: 1 });
    expect(states).toEqual(['queued']);
    tasks[0].resolve(4);
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(1);
    stopped.resolve();
    expect(await first).toBe(4);
    expect(states).toEqual(['queued', 'running']);
    tasks[1].resolve(5);
    expect(await second).toBe(5);
    expect(progress).toEqual(['reading']);
    expect(runner.stats()).toMatchObject({ active: 0, queued: 0 });
    await runner.close();
    await expect(runner.run(0)).rejects.toThrow('stopped');
  });

  it('rejects overload and pre-cancelled requests without spawning', async () => {
    const task = deferred<number>();
    const spawn = vi.fn(() => ({ result: task.promise, terminate: async () => {} }));
    const runner = createBackgroundWorkRunner({ config: { ...config, maxQueued: 0 }, spawn });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(runner.run(0, { signal: cancelled.signal })).rejects.toThrow('cancelled');
    const first = runner.run(0);
    await expect(runner.run(1)).rejects.toThrow('queue is full');
    task.resolve(1);
    await first;
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('removes cancelled queued work and terminates active cancellation before releasing capacity', async () => {
    const task = deferred<number>();
    const termination = deferred<void>();
    let report!: (message: string) => void;
    const terminate = vi.fn(() => termination.promise);
    const runner = createBackgroundWorkRunner({
      config,
      spawn: (_input: number, progress: (message: string) => void) => {
        report = progress;
        return { result: task.promise, terminate };
      },
    });
    const controller = new AbortController();
    const queued = new AbortController();
    const onProgress = vi.fn();
    const first = expect(runner.run(0, { signal: controller.signal, onProgress })).rejects.toThrow('cancelled');
    const second = expect(runner.run(1, { signal: queued.signal })).rejects.toThrow('cancelled');
    queued.abort();
    await second;
    expect(runner.stats().queued).toBe(0);
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(terminate).toHaveBeenCalledOnce();
    expect(runner.stats().active).toBe(1);
    report('late');
    expect(onProgress).not.toHaveBeenCalled();
    termination.resolve();
    await first;
    expect(runner.stats().active).toBe(0);
  });

  it('deadlines apply to running and queued work', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn(async () => {});
    const runner = createBackgroundWorkRunner({
      config: { ...config, timeoutMs: 10 },
      spawn: () => ({ result: new Promise<number>(() => {}), terminate }),
    });
    const first = expect(runner.run(0)).rejects.toThrow('exceeded 10ms');
    const second = expect(runner.run(1)).rejects.toThrow('exceeded 10ms');
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first, second]);
    expect(runner.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('contains worker and spawn failures and accepts later work', async () => {
    const spawn = vi.fn()
      .mockImplementationOnce(() => { throw new Error('spawn failed'); })
      .mockImplementationOnce(() => ({ result: Promise.reject(new Error('parse failed')), terminate: async () => {} }))
      .mockImplementation(() => ({ result: Promise.resolve(1), terminate: async () => {} }));
    const runner = createBackgroundWorkRunner<number, number>({ config, spawn });
    await expect(runner.run(0)).rejects.toThrow('spawn failed');
    await expect(runner.run(1)).rejects.toThrow('parse failed');
    expect(await runner.run(2)).toBe(1);
  });

  it('fails closed when worker termination is unconfirmed', async () => {
    const runner = createBackgroundWorkRunner({
      config,
      spawn: () => ({
        result: Promise.resolve(1),
        terminate: async () => { throw new Error('not stopped'); },
      }),
    });
    const first = expect(runner.run(0)).rejects.toThrow('termination could not be confirmed');
    const queued = expect(runner.run(1)).rejects.toThrow('termination could not be confirmed');
    await Promise.all([first, queued]);
    expect(runner.stats().active).toBe(1);
    await expect(runner.run(2)).rejects.toThrow('stopped');
    await expect(runner.close()).rejects.toThrow('did not confirm termination');
  });

  it('shutdown cancels all work and drains actual worker termination', async () => {
    const runner = createBackgroundWorkRunner({
      config,
      spawn: () => ({ result: new Promise<number>(() => {}), terminate: async () => {} }),
    });
    const first = expect(runner.run(0)).rejects.toThrow('shutdown');
    const queued = expect(runner.run(1)).rejects.toThrow('shutdown');
    await runner.close();
    await Promise.all([first, queued]);
    await runner.close();
    expect(runner.stats().active).toBe(0);
  });

  it('contains status callback errors and cancellation during admission', async () => {
    const task = deferred<number>();
    const runner = createBackgroundWorkRunner({
      config,
      spawn: () => ({ result: task.promise, terminate: async () => {} }),
    });
    const controller = new AbortController();
    await expect(runner.run(0, {
      signal: controller.signal,
      onState: () => controller.abort(),
    })).rejects.toThrow('cancelled');
    await expect(runner.run(0, {
      onState: () => { throw new Error('status failed'); },
    })).rejects.toThrow('status failed');
    const first = runner.run(0);
    await expect(runner.run(1, {
      onState: () => { throw new Error('status failed'); },
    })).rejects.toThrow('queue status could not be saved');
    task.resolve(1);
    await first;
  });

  it('contains progress callback failures instead of throwing on the API thread', async () => {
    const runner = createBackgroundWorkRunner({
      config,
      spawn: (_input: number, report: (message: string) => void) => {
        report('progress');
        return { result: new Promise<number>(() => {}), terminate: async () => {} };
      },
    });
    await expect(runner.run(0, {
      onProgress: () => { throw new Error('save failed'); },
    })).rejects.toThrow('progress could not be saved');
  });

  it('serves health and session APIs while two real CPU workers are stuck', async () => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/health' ? { status: 'ok' } : { sessions: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const ready = [deferred<void>(), deferred<void>()];
    const runner = createBackgroundWorkRunner({
      config: { ...config, maxWorkers: 2, timeoutMs: 2000 },
      spawn: (index: number) => {
        const worker = new Worker(
          'require("node:worker_threads").parentPort.postMessage("started"); while (true) {}',
          { eval: true },
        );
        worker.once('message', () => ready[index].resolve());
        worker.once('exit', () => ready[index].reject(new Error('Worker exited before ready')));
        return {
          result: new Promise<number>((_resolve, reject) => {
            worker.on('error', reject);
            worker.on('exit', () => reject(new Error('worker stopped')));
          }),
          terminate: async () => { await worker.terminate(); },
        };
      },
    });
    const jobs = [runner.run(0), runner.run(1)].map((job) => expect(job).rejects.toThrow('exceeded'));
    try {
      await Promise.all(ready.map((worker) => worker.promise));
      expect(runner.stats().active).toBe(2);
      for (const path of ['/health', '/features/f1/sessions', '/health']) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(750) });
        expect(response.status).toBe(200);
        await response.json();
      }
      await Promise.all(jobs);
    } finally {
      await runner.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
