export interface TemporaryPromptFile {
  path: string;
  cleanup(): Promise<void>;
}

/** Creates short-lived prompt files outside repository checkouts. */
export interface TemporaryPromptFileFactory {
  create(content: string, repositoryPath: string): Promise<TemporaryPromptFile>;
}
