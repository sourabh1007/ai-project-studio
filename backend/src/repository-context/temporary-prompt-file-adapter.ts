import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { encodeTextPdf } from './text-pdf-encoder.js';
import type { TemporaryPromptFileFactory } from './temporary-prompt-file-port.js';

const MAX_WINDOWS_ATTACHMENT_PATH_CHARS = 240;

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Filesystem adapter for repository-analysis prompt attachments. */
export function createTemporaryPromptFileFactory(): TemporaryPromptFileFactory {
  return {
    async create(content, repositoryPath) {
      const roots = [
        ...(process.platform === 'win32' && process.env.SystemRoot
          ? [join(process.env.SystemRoot, 'Temp')]
          : []),
        tmpdir(),
      ];
      let lastError: unknown;
      for (const root of new Set(roots)) {
        let directory: string | undefined;
        try {
          directory = await mkdtemp(join(root, 'aps-'));
          const path = join(directory, 'p.pdf');
          if (
            isInside(repositoryPath, path) ||
            (process.platform === 'win32' &&
              path.length > MAX_WINDOWS_ATTACHMENT_PATH_CHARS)
          ) {
            throw new Error('Temporary prompt path is not safe for attachment');
          }
          await writeFile(path, encodeTextPdf(content));
          const promptDirectory = directory;
          return {
            path,
            cleanup: () =>
              rm(promptDirectory, { recursive: true, force: true }),
          };
        } catch (error) {
          lastError = error;
          if (directory) {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
      throw lastError ?? new Error('No temporary prompt directory is available');
    },
  };
}
