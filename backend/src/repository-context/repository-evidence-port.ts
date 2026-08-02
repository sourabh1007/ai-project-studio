import type {
  RepositoryEvidenceCandidate,
} from './repository-context-contract.js';

/** Limits and selection hints passed to the filesystem evidence adapter. */
export interface RepositoryEvidenceCollectionRequest {
  repositoryPath: string;
  prioritizedFiles: readonly string[];
  ignoredDirectories: readonly string[];
  maxFileBytes: number;
  maxFileChars: number;
  maxTreeChars: number;
  maxContentChars: number;
  maxEvidenceFiles: number;
}

/** Raw tracked-file inventory returned by an IO adapter. */
export interface CollectedRepositoryEvidence {
  tree: string;
  files: RepositoryEvidenceCandidate[];
  totalTrackedFileCount: number;
}

/** Collects repository text without interpreting or executing its contents. */
export interface RepositoryEvidenceCollector {
  collect(
    request: RepositoryEvidenceCollectionRequest,
  ): Promise<CollectedRepositoryEvidence>;
}

/** Enumerates paths known to Git without reading working-tree contents. */
export interface RepositoryTrackedFileLookup {
  listTrackedFiles(repositoryPath: string): Promise<string[]>;
}

/** Minimal filesystem surface used by the bounded evidence adapter. */
export interface RepositoryEvidenceFileSystem {
  size(path: string): Promise<number>;
  read(path: string, maxBytes: number): Promise<Buffer>;
}
