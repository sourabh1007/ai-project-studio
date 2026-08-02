import type { RepositoryContextConfig } from './config.js';
import type {
  RepositoryEvidence,
  RepositoryEvidenceCandidate,
  RepositoryEvidenceFile,
} from './repository-context-contract.js';

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function priorityIndex(path: string, prioritizedFiles: readonly string[]): number {
  const normalized = normalizePath(path).toLowerCase();
  const parts = normalized.split('/');
  const basename = parts[parts.length - 1];
  const index = prioritizedFiles.findIndex((candidate) => {
    const priority = normalizePath(candidate).toLowerCase();
    if (priority === 'docs') {
      return normalized.startsWith('docs/') || normalized.includes('/docs/');
    }
    if (priority.includes('/')) {
      return normalized === priority || normalized.endsWith(`/${priority}`);
    }
    if (priority.startsWith('readme')) {
      return basename === 'readme' || basename.startsWith('readme.');
    }
    return basename === priority;
  });
  return index < 0 ? prioritizedFiles.length : index;
}

function compareCandidates(
  left: RepositoryEvidenceCandidate,
  right: RepositoryEvidenceCandidate,
  prioritizedFiles: readonly string[],
): number {
  const priorityDifference =
    priorityIndex(left.path, prioritizedFiles) -
    priorityIndex(right.path, prioritizedFiles);
  return priorityDifference !== 0
    ? priorityDifference
    : normalizePath(left.path).localeCompare(normalizePath(right.path));
}

/**
 * Deterministically prioritizes and bounds already-collected tracked text.
 * IO adapters remain responsible for binary detection and byte-size rejection.
 */
export function buildRepositoryEvidence(
  sourceRevision: string,
  tree: string,
  candidates: readonly RepositoryEvidenceCandidate[],
  config: RepositoryContextConfig,
  totalTrackedFileCount = candidates.length,
): RepositoryEvidence {
  const sorted = [...candidates].sort((left, right) =>
    compareCandidates(left, right, config.prioritizedFiles),
  );
  const files: RepositoryEvidenceFile[] = [];
  let remainingChars = config.maxContentChars;

  for (const candidate of sorted) {
    if (files.length >= config.maxEvidenceFiles || remainingChars === 0) {
      break;
    }
    const content = candidate.content.slice(
      0,
      Math.min(config.maxFileChars, remainingChars),
    );
    if (content.length === 0) {
      continue;
    }
    files.push({ path: normalizePath(candidate.path), content });
    remainingChars -= content.length;
  }

  const totalContentChars = candidates.reduce(
    (total, candidate) => total + candidate.content.length,
    0,
  );
  return {
    sourceRevision,
    tree: tree.slice(0, config.maxTreeChars),
    files,
    totalFileCount: totalTrackedFileCount,
    omittedFileCount: Math.max(0, totalTrackedFileCount - files.length),
    totalContentChars,
    largeRepository:
      totalTrackedFileCount >= config.largeRepositoryFileThreshold ||
      totalContentChars >= config.largeRepositoryContentThreshold,
  };
}
