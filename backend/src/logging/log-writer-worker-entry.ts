import { Worker, parentPort, workerData } from 'node:worker_threads';
import { createDailyLogPathStrategy } from './config.js';
import { createFileLogLineWriter } from './log-file-sink.js';
import { createLogWriterCore, type LogWriterRequest } from './log-writer-core.js';
import { createLogWriterPort, type LogWriterPortOptions } from './log-writer-port.js';
import type { LogWriterPort } from './queued-log-sink.js';

export interface LogWriterWorkerOptions {
  directory: string;
  filePrefix: string;
  maxFileBytes: number;
  retainedFileCount: number;
  maxRecordBytes: number;
}

/** Thin native entry: the writer thread reuses the synchronous rotation/retention/symlink-safe file writer. */
export function spawnLogWriterWorker(options: LogWriterWorkerOptions, port: LogWriterPortOptions): LogWriterPort {
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind: 'log-writer', options } });
  return createLogWriterPort(worker, port);
}

if (parentPort && workerData?.kind === 'log-writer') {
  const channel = parentPort;
  const options = workerData.options as LogWriterWorkerOptions;
  const strategy = createDailyLogPathStrategy(options.directory, options.filePrefix);
  const core = createLogWriterCore({
    writeLine: (line, at) => writeLine(line, at),
    reply: (response) => channel.postMessage(response),
    stop: () => channel.close(),
  });
  const writeLine = createFileLogLineWriter({
    filePath: strategy.resolve(new Date(), 0),
    pathStrategy: strategy,
    maxFileBytes: options.maxFileBytes,
    retainedFileCount: options.retainedFileCount,
    maxRecordBytes: options.maxRecordBytes,
    onFailure: (failure) => core.onFailure(failure),
  });
  channel.on('message', (request: LogWriterRequest) => core.handle(request));
}
