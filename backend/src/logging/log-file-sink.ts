import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { LogRecord, LogSink } from '../kernel/logger.js';
import {
  createDailyLogPathStrategy,
  loggingDefaults,
  resolveLoggingFileRetentionConfig,
  type DailyLogPathStrategy,
} from './config.js';

interface FileStats {
  size: number;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface FileLogSinkFailure {
  kind: 'failure' | 'recovered';
  operation:
    | 'serialize'
    | 'ensure-dir'
    | 'stat'
    | 'cap'
    | 'append'
    | 'rename'
    | 'retention-list'
    | 'retention-stat'
    | 'retention-remove'
    | 'retention-blocked';
  errorName: string;
  managed: boolean;
  fileName: string;
  suppressedCount: number;
}

export interface FileLogSinkDeps {
  filePath: string;
  pathStrategy?: DailyLogPathStrategy;
  now?: () => Date;
  append?: (filePath: string, line: string) => void;
  ensureDir?: (dir: string) => void;
  lstat?: (filePath: string) => FileStats | null;
  stat?: (filePath: string) => FileStats | null;
  listDir?: (dir: string) => string[];
  rename?: (from: string, to: string) => void;
  removeFile?: (filePath: string) => void;
  maxFileBytes?: number;
  retainedFileCount?: number;
  maxRecordBytes?: number;
  onFailure?: (failure: FileLogSinkFailure) => void;
  writeFailureLine?: (line: string) => void;
}

export interface ManagedLogFile {
  fileName: string;
  filePath: string;
  dateKey: string;
  rotation: number;
  size: number;
}

interface FailureState {
  failure: Omit<FileLogSinkFailure, 'kind' | 'suppressedCount'>;
  suppressedCount: number;
}

interface JsonWriteState {
  readonly parts: string[];
  bytes: number;
  readonly byteLimit: number;
  nodesVisited: number;
}

interface SerializeContext {
  readonly seen: Set<object>;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayItems: number;
  readonly maxObjectProperties: number;
}

const LEGACY_DAILY_LOG_PATTERN = /^(.*)-\d{4}-\d{2}-\d{2}\.log$/u;
const MAX_TRACKED_FAILURES = 16;
const DEFAULT_SERIALIZER_DEPTH = 6;
const DEFAULT_SERIALIZER_NODES = 128;
const DEFAULT_SERIALIZER_ARRAY_ITEMS = 64;
const DEFAULT_SERIALIZER_OBJECT_PROPERTIES = 64;

class JsonOverflowError extends Error {}

function utf8Bytes(input: string): number {
  return Buffer.byteLength(input, 'utf8');
}

function appendJsonPart(state: JsonWriteState, part: string): void {
  const bytes = utf8Bytes(part);
  if (state.bytes + bytes > state.byteLimit) {
    throw new JsonOverflowError('JSON line exceeds byte limit');
  }
  state.parts.push(part);
  state.bytes += bytes;
}

function nextStringUnit(input: string, index: number): string {
  const first = input.charCodeAt(index);
  if (
    first >= 0xd800 &&
    first <= 0xdbff &&
    index + 1 < input.length
  ) {
    const second = input.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return input.slice(index, index + 2);
    }
  }
  return input.slice(index, index + 1);
}

function appendJsonString(state: JsonWriteState, value: string): void {
  appendJsonPart(state, '"');
  for (let index = 0; index < value.length;) {
    const unit = nextStringUnit(value, index);
    appendJsonPart(state, JSON.stringify(unit).slice(1, -1));
    index += unit.length;
  }
  appendJsonPart(state, '"');
}

function incrementNodeCount(state: JsonWriteState, ctx: SerializeContext): boolean {
  state.nodesVisited += 1;
  return state.nodesVisited <= ctx.maxNodes;
}

function appendSentinelString(state: JsonWriteState, reason: string): void {
  appendJsonString(state, reason);
}

function hasCustomToJson(value: object): boolean {
  let target: object | null = value;
  let depth = 0;
  while (target) {
    if (depth++ >= DEFAULT_SERIALIZER_DEPTH) return true;
    const descriptor = Object.getOwnPropertyDescriptor(target, 'toJSON');
    if (
      descriptor &&
      (typeof descriptor.value === 'function' ||
        typeof descriptor.get === 'function') &&
      !(target === Date.prototype && descriptor.value === Date.prototype.toJSON)
    ) {
      return true;
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  return false;
}

function appendEnumerableObject(
  state: JsonWriteState,
  value: Record<string, unknown>,
  depth: number,
  ctx: SerializeContext,
): void {
  appendJsonPart(state, '{');
  let wrote = false;
  let visited = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    visited += 1;
    if (visited > ctx.maxObjectProperties) {
      if (wrote) {
        appendJsonPart(state, ',');
      }
      appendJsonString(state, '__omitted__');
      appendJsonPart(state, ':');
      appendSentinelString(state, 'property-limit');
      wrote = true;
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      continue;
    }
    if (
      descriptor.value === undefined ||
      typeof descriptor.value === 'function' ||
      typeof descriptor.value === 'symbol'
    ) {
      continue;
    }
    if (wrote) {
      appendJsonPart(state, ',');
    }
    appendJsonString(state, key);
    appendJsonPart(state, ':');
    appendJsonValue(state, descriptor.value, depth + 1, ctx);
    wrote = true;
  }
  appendJsonPart(state, '}');
}

function appendArrayValue(
  state: JsonWriteState,
  value: unknown[],
  depth: number,
  ctx: SerializeContext,
): void {
  appendJsonPart(state, '[');
  let wrote = false;
  let index = 0;
  const limit = Math.min(value.length, ctx.maxArrayItems);
  while (index < limit) {
    if (wrote) {
      appendJsonPart(state, ',');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      appendJsonPart(state, 'null');
    } else {
      appendJsonValue(state, descriptor.value, depth + 1, ctx);
    }
    wrote = true;
    index += 1;
  }
  if (index < value.length) {
    if (wrote) {
      appendJsonPart(state, ',');
    }
    appendSentinelString(state, 'array-limit');
  }
  appendJsonPart(state, ']');
}

function appendJsonValue(
  state: JsonWriteState,
  value: unknown,
  depth: number,
  ctx: SerializeContext,
): void {
  if (!incrementNodeCount(state, ctx)) {
    appendSentinelString(state, 'node-limit');
    return;
  }
  if (value === null) {
    appendJsonPart(state, 'null');
    return;
  }
  switch (typeof value) {
    case 'string':
      appendJsonString(state, value);
      return;
    case 'boolean':
      appendJsonPart(state, value ? 'true' : 'false');
      return;
    case 'number':
      appendJsonPart(state, Number.isFinite(value) ? String(value) : 'null');
      return;
    case 'bigint':
      appendJsonString(state, `${value}n`);
      return;
    case 'undefined':
    case 'function':
    case 'symbol':
      appendJsonPart(state, 'null');
      return;
    case 'object':
      break;
  }
  if (depth >= ctx.maxDepth) {
    appendSentinelString(state, 'depth-limit');
    return;
  }
  if (hasCustomToJson(value)) {
    appendSentinelString(state, 'custom-tojson-omitted');
    return;
  }
  if (value instanceof Date) {
    appendJsonPart(
      state,
      Number.isNaN(Date.prototype.getTime.call(value))
        ? 'null' : JSON.stringify(Date.prototype.toISOString.call(value)),
    );
    return;
  }
  if (Array.isArray(value)) {
    if (ctx.seen.has(value)) {
      appendSentinelString(state, 'circular');
      return;
    }
    ctx.seen.add(value);
    try {
      appendArrayValue(state, value, depth, ctx);
    } finally {
      ctx.seen.delete(value);
    }
    return;
  }
  if (ctx.seen.has(value)) {
    appendSentinelString(state, 'circular');
    return;
  }
  ctx.seen.add(value);
  try {
    appendEnumerableObject(
      state,
      value as Record<string, unknown>,
      depth,
      ctx,
    );
  } finally {
    ctx.seen.delete(value);
  }
}

function serializeJsonLine(entry: Record<string, unknown>, maxBytes: number): string | null {
  const state: JsonWriteState = {
    parts: [],
    bytes: 0,
    byteLimit: maxBytes,
    nodesVisited: 0,
  };
  const ctx: SerializeContext = {
    seen: new Set(),
    maxDepth: DEFAULT_SERIALIZER_DEPTH,
    maxNodes: DEFAULT_SERIALIZER_NODES,
    maxArrayItems: DEFAULT_SERIALIZER_ARRAY_ITEMS,
    maxObjectProperties: DEFAULT_SERIALIZER_OBJECT_PROPERTIES,
  };
  try {
    appendEnumerableObject(state, entry, 0, ctx);
    appendJsonPart(state, '\n');
  } catch (error) {
    if (error instanceof JsonOverflowError) {
      return null;
    }
    throw error;
  }
  return state.parts.join('');
}

function formatOversizedRecord(
  record: LogRecord,
  now: Date,
  maxRecordBytes: number,
): string {
  const detailed = serializeJsonLine(
    {
      ts: now.toISOString(),
      level: record.level,
      message: 'log record truncated',
      data: {
        truncated: true,
        maxRecordBytes,
        originalMessageCodeUnits: record.message.length,
        originalDataType:
          record.data === null ? 'null' : typeof record.data,
        droppedData: record.data !== undefined,
      },
    },
    maxRecordBytes,
  );
  if (detailed) {
    return detailed;
  }
  const omitted = serializeJsonLine(
      {
        ts: now.toISOString(),
        level: record.level,
        message: 'log record omitted',
        data: { truncated: true, maxRecordBytes },
      },
      maxRecordBytes,
    ) ?? serializeJsonLine({ message: 'log record omitted' }, maxRecordBytes);
  if (omitted === null) {
    throw new RangeError('Log record budget cannot fit an omission marker');
  }
  return omitted;
}

export function formatLogLine(
  record: LogRecord,
  now: Date,
  maxRecordBytes = loggingDefaults.maxRecordBytes,
): string {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
    throw new RangeError('Log record budget must be a positive safe integer');
  }
  const line = serializeJsonLine(
    {
      ts: now.toISOString(),
      level: record.level,
      message: record.message,
      data: record.data,
    },
    maxRecordBytes,
  );
  return line ?? formatOversizedRecord(record, now, maxRecordBytes);
}

export function defaultLogFileLstat(filePath: string): FileStats | null {
  try {
    const stat = lstatSync(filePath);
    return {
      size: stat.size,
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export function defaultLogFileStat(filePath: string): FileStats | null {
  try {
    const stat = statSync(filePath);
    return {
      size: stat.size,
      isFile: stat.isFile(),
      isSymbolicLink: false,
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export function parseManagedLogFileName(fileName: string): ManagedLogFile | null {
  const match =
    /^(?<prefix>.+)-(?<date>\d{4}-\d{2}-\d{2})(?:\.(?<rotation>\d+))?\.log$/u.exec(
      fileName,
    );
  if (!match?.groups?.date) {
    return null;
  }
  return {
    fileName,
    filePath: fileName,
    dateKey: match.groups.date,
    rotation: Number(match.groups.rotation ?? '0'),
    size: 0,
  };
}

function compareManagedFiles(left: ManagedLogFile, right: ManagedLogFile): number {
  if (left.dateKey !== right.dateKey) {
    return left.dateKey.localeCompare(right.dateKey);
  }
  return left.rotation - right.rotation;
}

export function deriveLegacyDailyLogPathStrategy(
  filePath: string,
): DailyLogPathStrategy | null {
  const fileName = basename(filePath);
  const match = LEGACY_DAILY_LOG_PATTERN.exec(fileName);
  if (!match?.[1]) {
    return null;
  }
  return createDailyLogPathStrategy(dirname(filePath), match[1]);
}

export function logFailureName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'Error';
}

function formatFailureLine(failure: FileLogSinkFailure): string {
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    component: 'file-log-sink',
    kind: failure.kind,
    operation: failure.operation,
    errorName: failure.errorName,
    managed: failure.managed,
    fileName: failure.fileName,
    suppressedCount: failure.suppressedCount,
  })}\n`;
}

function createFailureReporter(
  onFailure: ((failure: FileLogSinkFailure) => void) | undefined,
  writeFailureLine: (line: string) => void,
) {
  const failures = new Map<string, FailureState>();
  let reporting = false;

  const emit = (failure: FileLogSinkFailure): void => {
    reporting = true;
    try {
      if (onFailure) {
        try {
          onFailure(failure);
          return;
        } catch {
          writeFailureLine(formatFailureLine(failure));
          return;
        }
      }
      writeFailureLine(formatFailureLine(failure));
    } catch {
      // Both notification channels failed; reporting must not recurse or throw.
    } finally {
      reporting = false;
    }
  };

  const keyOf = (failure: Omit<FileLogSinkFailure, 'kind' | 'suppressedCount'>) =>
    `${failure.operation}|${failure.managed ? '1' : '0'}|${failure.fileName}`;

  return {
    fail(failure: Omit<FileLogSinkFailure, 'kind' | 'suppressedCount'>): void {
      if (reporting) return;
      const key = keyOf(failure);
      const existing = failures.get(key);
      if (existing) {
        existing.suppressedCount += 1;
        return;
      }
      failures.set(key, { failure, suppressedCount: 0 });
      while (failures.size > MAX_TRACKED_FAILURES) {
        failures.delete([...failures.keys()][0]);
      }
      emit({ ...failure, kind: 'failure', suppressedCount: 0 });
    },
    recover(
      matches: (failure: Omit<FileLogSinkFailure, 'kind' | 'suppressedCount'>) => boolean,
    ): void {
      if (reporting) return;
      for (const [key, state] of [...failures]) {
        if (!matches(state.failure)) {
          continue;
        }
        failures.delete(key);
        emit({
          ...state.failure,
          kind: 'recovered',
          suppressedCount: state.suppressedCount,
        });
      }
    },
  };
}

function readRegularFileState(
  filePath: string,
  lstat: (filePath: string) => FileStats | null,
  stat: (filePath: string) => FileStats | null,
): { exists: boolean; size: number } | null {
  const linkInfo = lstat(filePath);
  if (!linkInfo) {
    return { exists: false, size: 0 };
  }
  if (linkInfo.isSymbolicLink) {
    return null;
  }
  const regular = stat(filePath);
  if (!regular || !regular.isFile || regular.isSymbolicLink) {
    return null;
  }
  return { exists: true, size: regular.size };
}

function buildManagedLogFile(
  directory: string,
  fileName: string,
  size: number,
): ManagedLogFile | null {
  const parsed = parseManagedLogFileName(fileName);
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    filePath: join(directory, fileName),
    size,
  };
}

export function createFileLogSink(deps: FileLogSinkDeps): LogSink {
  const now = deps.now ?? (() => new Date());
  const append = deps.append ?? appendFileSync;
  const ensureDir =
    deps.ensureDir ?? ((dir) => mkdirSync(dir, { recursive: true }));
  const lstat = deps.lstat ?? defaultLogFileLstat;
  const stat = deps.stat ?? defaultLogFileStat;
  const listDir = deps.listDir ?? ((dir) => readdirSync(dir));
  const rename = deps.rename ?? renameSync;
  const removeFile = deps.removeFile ?? ((filePath) => rmSync(filePath));
  const writeFailureLine =
    deps.writeFailureLine ??
    ((line: string) => {
      try {
        process.stderr.write(line);
      } catch {
        /* last-resort logging must remain non-fatal */
      }
    });
  const limits = resolveLoggingFileRetentionConfig({
    maxFileBytes: deps.maxFileBytes,
    retainedFileCount: deps.retainedFileCount,
    maxRecordBytes: deps.maxRecordBytes,
  });
  const pathStrategy =
    deps.pathStrategy ?? deriveLegacyDailyLogPathStrategy(deps.filePath);
  const reporter = createFailureReporter(deps.onFailure, writeFailureLine);
  let ensuredDirectory: string | null = null;
  let retainedPath: string | null = null;

  const markHealthy = (targetPath: string): void => {
    const fileName = basename(targetPath);
    reporter.recover(
      (failure) =>
        failure.fileName === fileName &&
        ['append', 'cap', 'rename'].includes(failure.operation),
    );
  };

  const ensureDirectoryReady = (directory: string): boolean => {
    if (ensuredDirectory === directory) {
      return true;
    }
    try {
      ensureDir(directory);
      ensuredDirectory = directory;
      reporter.recover(
        (failure) =>
          failure.operation === 'ensure-dir' &&
          failure.fileName === basename(directory),
      );
      return true;
    } catch (error) {
      reporter.fail({
        operation: 'ensure-dir',
        errorName: logFailureName(error),
        managed: pathStrategy !== null,
        fileName: basename(directory),
      });
      return false;
    }
  };

  const readTarget = (
    filePath: string,
    managed: boolean,
  ): { exists: boolean; size: number } | null => {
    try {
      const state = readRegularFileState(filePath, lstat, stat);
      if (state) {
        reporter.recover(
          (failure) =>
            failure.operation === 'stat' &&
            failure.fileName === basename(filePath),
        );
      } else {
        reporter.fail({
          operation: 'stat',
          errorName: 'NonRegularFileError',
          managed,
          fileName: basename(filePath),
        });
      }
      return state;
    } catch (error) {
      reporter.fail({
        operation: 'stat',
        errorName: logFailureName(error),
        managed,
        fileName: basename(filePath),
      });
      return null;
    }
  };

  const managedFiles = (directory: string): ManagedLogFile[] | null => {
    const strategy = pathStrategy!;
    let names: string[];
    try {
      names = listDir(directory);
      reporter.recover(
        (failure) =>
          failure.operation === 'retention-list' &&
          failure.fileName === basename(directory),
      );
    } catch (error) {
      reporter.fail({
        operation: 'retention-list',
        errorName: logFailureName(error),
        managed: true,
        fileName: basename(directory),
      });
      return null;
    }
    const files: ManagedLogFile[] = [];
    for (const fileName of names) {
      if (!strategy.isManagedFile(fileName)) {
        continue;
      }
      const filePath = join(directory, fileName);
      try {
        const state = readRegularFileState(filePath, lstat, stat);
        if (!state || !state.exists) {
          continue;
        }
        reporter.recover(
          (failure) =>
            failure.operation === 'retention-stat' &&
            failure.fileName === fileName,
        );
        const parsed = buildManagedLogFile(directory, fileName, state.size);
        if (parsed) {
          files.push(parsed);
        }
      } catch (error) {
        reporter.fail({
          operation: 'retention-stat',
          errorName: logFailureName(error),
          managed: true,
          fileName,
        });
        return null;
      }
    }
    files.sort(compareManagedFiles);
    return files;
  };

  const enforceRetention = (
    directory: string,
    protectedPaths: readonly string[],
    additionalManagedFiles: number,
  ): boolean => {
    const files = managedFiles(directory);
    if (!files) {
      return false;
    }
    const protectedSet = new Set(protectedPaths);
    const allowedCount = limits.retainedFileCount - additionalManagedFiles;
    let remaining = files.length;
    for (const file of files) {
      if (remaining <= allowedCount) {
        break;
      }
      if (protectedSet.has(file.filePath)) {
        continue;
      }
      try {
        removeFile(file.filePath);
        reporter.recover(
          (failure) =>
            failure.operation === 'retention-remove' &&
            failure.fileName === file.fileName,
        );
        remaining -= 1;
      } catch (error) {
        reporter.fail({
          operation: 'retention-remove',
          errorName: logFailureName(error),
          managed: true,
          fileName: file.fileName,
        });
        return false;
      }
    }
    return true;
  };

  const nextArchivePath = (directory: string, date: Date): string | null => {
    const files = managedFiles(directory);
    if (!files) {
      return null;
    }
    const dateKey = date.toISOString().slice(0, 10);
    let rotation = 1;
    for (const file of files) {
      if (file.dateKey !== dateKey) {
        continue;
      }
      rotation = Math.max(rotation, file.rotation + 1);
    }
    return pathStrategy!.resolve(date, rotation);
  };

  return (record) => {
    const at = now();
    const targetPath = pathStrategy
      ? pathStrategy.resolve(at, 0)
      : deps.filePath;
    const directory = dirname(targetPath);
    let line: string;
    try {
      line = formatLogLine(record, at, limits.maxRecordBytes);
      reporter.recover(
        (failure) =>
          failure.operation === 'serialize' &&
          failure.fileName === basename(targetPath),
      );
    } catch (error) {
      reporter.fail({
        operation: 'serialize',
        errorName: logFailureName(error),
        managed: pathStrategy !== null,
        fileName: basename(targetPath),
      });
      return;
    }
    if (!ensureDirectoryReady(directory)) {
      return;
    }
    const targetState = readTarget(targetPath, pathStrategy !== null);
    if (!targetState) {
      return;
    }
    const lineBytes = utf8Bytes(line);
    const willCreateTarget = pathStrategy !== null && !targetState.exists;
    const willOverflowTarget = targetState.exists &&
      targetState.size + lineBytes > limits.maxFileBytes;
    const replaceSingleFile = pathStrategy !== null && willOverflowTarget &&
      limits.retainedFileCount === 1;
    if (pathStrategy &&
        (retainedPath !== targetPath || willCreateTarget || willOverflowTarget)) {
      retainedPath = null;
      const protectedPaths = targetState.exists && !replaceSingleFile ? [targetPath] : [];
      const additionalManagedFiles = willCreateTarget || willOverflowTarget ? 1 : 0;
      if (!enforceRetention(directory, protectedPaths, additionalManagedFiles)) {
        return;
      }
      if (replaceSingleFile) {
        const remainingTarget = readTarget(targetPath, true);
        if (!remainingTarget || remainingTarget.exists) {
          reporter.fail({
            operation: 'retention-blocked',
            errorName: 'RetentionExceededError',
            managed: true,
            fileName: basename(directory),
          });
          return;
        }
        targetState.exists = false;
        targetState.size = 0;
      }
      reporter.recover(
        (failure) => failure.operation === 'retention-blocked' &&
          failure.fileName === basename(directory),
      );
      retainedPath = targetPath;
    }
    if (!pathStrategy && targetState.size + lineBytes > limits.maxFileBytes) {
      reporter.fail({
        operation: 'cap',
        errorName: 'FileCapExceededError',
        managed: false,
        fileName: basename(targetPath),
      });
      return;
    }
    if (pathStrategy && targetState.exists && willOverflowTarget) {
      const archivePath = nextArchivePath(directory, at);
      if (!archivePath) {
        return;
      }
      try {
        rename(targetPath, archivePath);
        targetState.exists = false;
        targetState.size = 0;
      } catch (error) {
        reporter.fail({
          operation: 'rename',
          errorName: logFailureName(error),
          managed: true,
          fileName: basename(targetPath),
        });
        return;
      }
    }
    try {
      append(targetPath, line);
      markHealthy(targetPath);
    } catch (error) {
      ensuredDirectory = null;
      reporter.fail({
        operation: 'append',
        errorName: logFailureName(error),
        managed: pathStrategy !== null,
        fileName: basename(targetPath),
      });
      return;
    }
  };
}

export function combineSinks(...sinks: LogSink[]): LogSink {
  return (record) => {
    for (const sink of sinks) {
      sink(record);
    }
  };
}
