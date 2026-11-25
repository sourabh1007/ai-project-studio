import {
  resolveReviewContextConfig,
  validReviewContextPath,
  type ReviewContextConfig,
  type ReviewContextSourcePort,
} from './review-context.js';

export interface ReviewContextCommandOptions {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
}

export interface ReviewContextCommandRunner {
  run(executable: string, args: readonly string[], options: ReviewContextCommandOptions): Promise<{ stdout: Buffer | string }>;
}

function validRevision(revision: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision);
}

function checkedRevision(revision: string): string {
  if (!validRevision(revision)) throw new Error('Invalid pinned Git revision');
  return revision;
}

function checkedRef(ref: string | null): string {
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || /(^|\/)\.|\.\.|\/\/|\.lock(?:\/|$)|[/.]$/.test(ref)) {
    throw new Error('Invalid Git target ref');
  }
  return ref;
}

interface TreeEntry {
  mode: string;
  objectId: string;
  path: string;
  size: number;
}

function parseTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\s+(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Malformed Git tree response');
    entries.push({ mode: match[1]!, objectId: match[2]!, size: Number(match[3]), path: match[4]! });
  }
  return entries;
}

/** Bounded object-only commands; paths and text are never interpreted by a shell. */
export function createGitReviewContextSource(
  runner: ReviewContextCommandRunner,
  limits?: Partial<ReviewContextConfig>,
): ReviewContextSourcePort {
  const config = resolveReviewContextConfig(limits);
  const command = async (cwd: string, args: string[], signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    const result = await runner.run('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', ...args], {
      cwd, timeout: config.commandTimeoutMs, maxBuffer: config.maxCommandBytes, signal,
    });
    signal?.throwIfAborted();
    if (Buffer.byteLength(result.stdout) > config.maxCommandBytes) throw new Error('Git output exceeded context budget');
    return result.stdout.toString();
  };
  return {
    async pin(repositoryPath, headSha, baseBranch, signal) {
      if (!headSha) throw new Error('Review has no pinned HEAD');
      checkedRevision(headSha);
      const base = checkedRef(baseBranch);
      const head = checkedRevision((await command(repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${headSha}^{commit}`], signal)).trim());
      if (head.toLowerCase() !== headSha.toLowerCase()) throw new Error('Git HEAD does not match review revision');
      const target = checkedRevision((await command(repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], signal)).trim());
      const mergeBase = checkedRevision((await command(repositoryPath, ['merge-base', head, target], signal)).trim());
      return { headSha: head, baseSha: target, mergeBaseSha: mergeBase };
    },
    async listFiles(repositoryPath, revision, signal, paths) {
      checkedRevision(revision);
      if (paths?.some((path) => !validReviewContextPath(path))) throw new Error('Unsafe guidance lookup path');
      const batches = paths === undefined ? [undefined]
        : Array.from({ length: Math.ceil(paths.length / 16) }, (_, index) => paths.slice(index * 16, (index + 1) * 16));
      const files = new Map<string, TreeEntry>();
      for (const batch of batches) {
        const tree = parseTree(await command(repositoryPath,
          ['ls-tree', '-r', '-z', '-l', revision, ...(batch ? ['--', ...batch] : [])], signal));
        for (const entry of tree) {
          if (files.has(entry.path)) continue;
          if (files.size === config.maxFiles) return { files: [...files.values()], truncated: true };
          files.set(entry.path, entry);
        }
      }
      return { files: [...files.values()], truncated: false };
    },
    async readFile(repositoryPath, revision, path, signal) {
      checkedRevision(revision);
      if (!validReviewContextPath(path)) throw new Error('Unsafe repository context path');
      const entries = parseTree(await command(repositoryPath, ['ls-tree', '-z', '-l', revision, '--', path], signal));
      const entry = entries.find((candidate) => candidate.path === path);
      if (!entry) return { content: null };
      if (!['100644', '100755'].includes(entry.mode) || !Number.isSafeInteger(entry.size)) return { content: null, unsupported: true };
      if (entry.size > config.maxFileBytes) return { content: null, truncated: true };
      const content = await command(repositoryPath, ['cat-file', 'blob', checkedRevision(entry.objectId)], signal);
      if (Buffer.byteLength(content) > config.maxFileBytes) return { content: null, truncated: true };
      if (content.includes('\0') || content.includes('\uFFFD')) return { content: null, unsupported: true };
      return { content };
    },
  };
}
