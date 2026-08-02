/** Resolves the immutable source revision currently checked out in a repository. */
export interface RepositoryRevisionLookup {
  getRevision(repositoryPath: string): Promise<string>;
}

