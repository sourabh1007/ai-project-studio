import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { ValidationError } from '../kernel/error-types.js';
import type {
  NewTaskCommit,
  NewTaskFileChange,
  NewTaskFileChangeType,
  NewTaskFileDiff,
  NewTaskGitPort,
  NewTaskWorktree,
} from './new-task-contract.js';

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a `git` command (args already include any `-C <path>`). */
export type NewTaskGitRunner = (args: string[]) => Promise<GitRunResult>;

export interface NewTaskGitDeps {
  git: NewTaskGitRunner;
  /** Whether a directory already exists on disk. */
  pathExists: (path: string) => boolean;
  /** Recursively delete a directory on disk (best-effort, force). */
  removeDir: (path: string) => void;
  /**
   * Short token appended to a re-planned branch so each re-plan gets a brand
   * new branch name. Injected for deterministic tests; defaults to a random id.
   */
  branchToken?: () => string;
  /**
   * Resolves the current user's short name for the `users/<name>/…` branch
   * prefix. Injected for deterministic tests; defaults to the OS user name.
   */
  resolveUser?: () => string;
}

/** The most characters allowed in the human-readable branch-name segment. */
export const BRANCH_NAME_MAX = 15;

/** Normalise a value into a lowercase, hyphen-delimited git-ref-safe segment. */
function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the branch a run's change is implemented on, following the required
 * `users/<username>/<name>` shape. The name segment is a meaningful slug derived
 * from the problem statement, clamped to {@link BRANCH_NAME_MAX} characters (the
 * re-plan token, when present, fits inside that budget so the segment stays
 * under the limit).
 */
export function newTaskBranch(
  username: string,
  name: string,
  token?: string,
): string {
  const user = sanitizeSegment(username) || 'user';
  const slug = sanitizeSegment(name) || 'task';
  const suffix = token ? sanitizeSegment(token).slice(0, 4) || '0' : '';
  const budget = suffix ? BRANCH_NAME_MAX - suffix.length - 1 : BRANCH_NAME_MAX;
  const head = slug.slice(0, budget).replace(/-+$/g, '');
  const label = suffix ? `${head}-${suffix}` : head;
  return `users/${user}/${label}`;
}

/** Where a run's worktree lives: a sibling `.ai-worktrees` dir next to the repo. */
export function newTaskWorktreePath(
  repoLocalPath: string,
  runId: string,
): string {
  return join(
    dirname(repoLocalPath),
    '.ai-worktrees',
    `${basename(repoLocalPath)}-task-${runId}`,
  );
}

/** Classify one `git status --porcelain` line's two-letter code. */
function classifyPorcelain(code: string): NewTaskFileChangeType {
  if (code.includes('R')) return 'renamed';
  if (code === '??' || code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

/** Parse `git status --porcelain` output into a changed-file summary. */
export function parseChangedFiles(porcelain: string): NewTaskFileChange[] {
  const files: NewTaskFileChange[] = [];
  for (const raw of porcelain.split('\n')) {
    if (raw.trim().length === 0) continue;
    const code = raw.slice(0, 2);
    let path = raw.slice(3).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) {
      // Rename/copy lines read "old -> new"; report the new path.
      path = path.slice(arrow + 4).trim();
    }
    path = path.replace(/^"|"$/g, '');
    files.push({ path, changeType: classifyPorcelain(code) });
  }
  return files;
}

/** Classify one `git diff --name-status` status letter. */
function classifyDiffStatus(code: string): NewTaskFileChangeType {
  const letter = code.charAt(0);
  if (letter === 'R' || letter === 'C') return 'renamed';
  if (letter === 'A') return 'added';
  if (letter === 'D') return 'deleted';
  return 'modified';
}

/** Parse `git diff --name-status <base>...HEAD` output into a file summary. */
export function parseNameStatus(output: string): NewTaskFileChange[] {
  const files: NewTaskFileChange[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const parts = line.split('\t');
    // Rename/copy rows are "R100\told\tnew"; report the final (new) path.
    const path = parts[parts.length - 1].replace(/^"|"$/g, '');
    files.push({ path, changeType: classifyDiffStatus(parts[0]) });
  }
  return files;
}

/**
 * Git operations for the New Task flow, mirroring the PR-worktree provisioner's
 * injected-runner shape so the pure logic is fully unit-testable. The change is
 * always implemented in a dedicated worktree on a new branch based on the repo's
 * base branch, so the user's primary checkout is never disturbed.
 */
export function createNewTaskGit(deps: NewTaskGitDeps): NewTaskGitPort {
  async function prepareWorktree(input: {
    repoLocalPath: string;
    baseBranch: string;
    runId: string;
    name: string;
    previousBranch?: string;
  }): Promise<NewTaskWorktree> {
    const worktreePath = newTaskWorktreePath(input.repoLocalPath, input.runId);
    const username = (deps.resolveUser ?? (() => userInfo().username))();

    // Re-plan: tear down the previous plan's worktree + branch so the new plan
    // starts from a clean slate on a brand new branch (best-effort; a missing
    // worktree/branch is fine).
    if (input.previousBranch) {
      await deps.git([
        '-C',
        input.repoLocalPath,
        'worktree',
        'remove',
        '--force',
        worktreePath,
      ]);
      await deps.git(['-C', input.repoLocalPath, 'worktree', 'prune']);
      await deps.git([
        '-C',
        input.repoLocalPath,
        'branch',
        '-D',
        input.previousBranch,
      ]);
    }

    const token = input.previousBranch
      ? (deps.branchToken ?? (() => randomUUID().slice(0, 8)))()
      : undefined;
    const branch = newTaskBranch(username, input.name, token);

    // A worktree directory can linger on disk even after `worktree remove`
    // (an interrupted run, a Windows file lock, or a checkout git no longer
    // tracks). `worktree add` refuses an existing path, so purge any leftover
    // directory and prune the registry before recreating it.
    if (deps.pathExists(worktreePath)) {
      deps.removeDir(worktreePath);
      await deps.git(['-C', input.repoLocalPath, 'worktree', 'prune']);
    }

    // Best-effort refresh so the new branch is based on the latest base head.
    const fetched = await deps.git([
      '-C',
      input.repoLocalPath,
      'fetch',
      'origin',
      input.baseBranch,
    ]);
    // Prefer the freshly-fetched remote head; fall back to the local base ref
    // (offline / no remote), then to HEAD as a last resort.
    const base =
      fetched.code === 0 ? `origin/${input.baseBranch}` : input.baseBranch;

    const args = [
      '-c',
      'core.longpaths=true',
      '-C',
      input.repoLocalPath,
      'worktree',
      'add',
      '--force',
      '-B',
      branch,
      worktreePath,
    ];
    let add = await deps.git([...args, base]);
    if (add.code !== 0 && base !== 'HEAD') {
      // The base ref may not exist locally (e.g. a brand-new repo with no
      // origin); retry from the current HEAD so planning can still proceed.
      add = await deps.git([...args, 'HEAD']);
    }
    if (add.code !== 0) {
      throw new ValidationError(
        add.stderr.trim() || 'Failed to create the task worktree',
      );
    }
    return { worktreePath, branch };
  }

  async function commitAll(input: {
    worktreePath: string;
    message: string;
  }): Promise<NewTaskCommit> {
    const status = await deps.git([
      '-C',
      input.worktreePath,
      'status',
      '--porcelain',
    ]);
    if (status.code !== 0) {
      throw new ValidationError(
        status.stderr.trim() || 'Failed to inspect the worktree',
      );
    }
    if (status.stdout.trim().length === 0) {
      // Nothing was changed by the implementation turn.
      return { committed: false, files: [] };
    }
    const files = parseChangedFiles(status.stdout);
    const add = await deps.git(['-C', input.worktreePath, 'add', '-A']);
    if (add.code !== 0) {
      throw new ValidationError(
        add.stderr.trim() || 'Failed to stage the change',
      );
    }
    const commit = await deps.git([
      '-C',
      input.worktreePath,
      'commit',
      '-m',
      input.message,
    ]);
    if (commit.code !== 0) {
      throw new ValidationError(
        commit.stderr.trim() || 'Failed to commit the change',
      );
    }
    return { committed: true, files };
  }

  async function pushBranch(input: {
    worktreePath: string;
    branch: string;
  }): Promise<void> {
    const push = await deps.git([
      '-C',
      input.worktreePath,
      'push',
      '-u',
      'origin',
      input.branch,
    ]);
    if (push.code !== 0) {
      throw new ValidationError(
        push.stderr.trim() || 'Failed to push the branch',
      );
    }
  }

  async function changedFilesAgainst(input: {
    worktreePath: string;
    baseBranch: string;
  }): Promise<NewTaskFileChange[]> {
    const diff = await deps.git([
      '-C',
      input.worktreePath,
      'diff',
      '--name-status',
      `${input.baseBranch}...HEAD`,
    ]);
    if (diff.code !== 0) {
      throw new ValidationError(
        diff.stderr.trim() || 'Failed to inspect the branch',
      );
    }
    return parseNameStatus(diff.stdout);
  }

  async function fileDiff(input: {
    worktreePath: string;
    baseBranch: string;
    path: string;
  }): Promise<NewTaskFileDiff> {
    const diff = await deps.git([
      '-C',
      input.worktreePath,
      'diff',
      `${input.baseBranch}...HEAD`,
      '--',
      input.path,
    ]);
    if (diff.code !== 0) {
      throw new ValidationError(
        diff.stderr.trim() || 'Failed to diff the file',
      );
    }
    // The full current content on the branch; a deleted (or missing) file has
    // none, so an errored `git show` degrades to empty content, not a failure.
    const show = await deps.git([
      '-C',
      input.worktreePath,
      'show',
      `HEAD:${input.path}`,
    ]);
    return {
      path: input.path,
      diff: diff.stdout,
      content: show.code === 0 ? show.stdout : '',
    };
  }

  return {
    prepareWorktree,
    worktreePathFor: (repoLocalPath, runId) =>
      newTaskWorktreePath(repoLocalPath, runId),
    commitAll,
    pushBranch,
    changedFilesAgainst,
    fileDiff,
  };
}