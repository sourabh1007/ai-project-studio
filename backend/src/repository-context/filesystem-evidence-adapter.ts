import { lstat, open } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import type {
  RepositoryEvidenceCollector,
  RepositoryEvidenceFileSystem,
  RepositoryTrackedFileLookup,
} from './repository-evidence-port.js';

const defaultFileSystem: RepositoryEvidenceFileSystem = {
  async size(path) {
    const metadata = await lstat(path);
    return metadata.isFile() ? metadata.size : -1;
  },
  async read(path, maxBytes) {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function isIgnored(path: string, ignoredDirectories: readonly string[]): boolean {
  const ignored = new Set(ignoredDirectories.map((item) => item.toLowerCase()));
  return normalizePath(path)
    .split('/')
    .slice(0, -1)
    .some((part) => ignored.has(part.toLowerCase()));
}

function priorityIndex(path: string, priorities: readonly string[]): number {
  const normalized = normalizePath(path).toLowerCase();
  const basename = normalized.split('/').at(-1) ?? normalized;
  const index = priorities.findIndex((candidate) => {
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
  return index < 0 ? priorities.length : index;
}

function isBinary(content: Buffer): boolean {
  if (content.includes(0)) {
    return true;
  }
  let controls = 0;
  for (const byte of content) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      controls += 1;
    }
  }
  return content.length > 0 && controls / content.length > 0.3;
}

function renderTree(paths: readonly string[], maxChars: number): string {
  return paths.join('\n').slice(0, maxChars);
}

export function createFilesystemEvidenceCollector(deps: {
  trackedFiles: RepositoryTrackedFileLookup;
  fileSystem?: RepositoryEvidenceFileSystem;
}): RepositoryEvidenceCollector {
  const fileSystem = deps.fileSystem ?? defaultFileSystem;
  return {
    async collect(request) {
      const tracked = (await deps.trackedFiles.listTrackedFiles(
        request.repositoryPath,
      ))
        .map(normalizePath)
        .filter(
          (path) =>
            path.length > 0 &&
            !win32.isAbsolute(path) &&
            !path.split('/').includes('..') &&
            !isIgnored(path, request.ignoredDirectories),
        )
        .sort((left, right) => left.localeCompare(right));
      const ordered = [...tracked].sort((left, right) => {
        const difference =
          priorityIndex(left, request.prioritizedFiles) -
          priorityIndex(right, request.prioritizedFiles);
        return difference || left.localeCompare(right);
      });
      const files = [];
      let remainingChars = request.maxContentChars;

      for (const path of ordered) {
        if (files.length >= request.maxEvidenceFiles || remainingChars === 0) {
          break;
        }
        const absolutePath = join(request.repositoryPath, ...path.split('/'));
        const sizeBytes = await fileSystem.size(absolutePath);
        if (sizeBytes <= 0 || sizeBytes > request.maxFileBytes) {
          continue;
        }
        const content = await fileSystem.read(
          absolutePath,
          Math.min(
            sizeBytes,
            request.maxFileBytes,
            request.maxFileChars,
            remainingChars,
          ),
        );
        if (isBinary(content)) {
          continue;
        }
        const text = content.toString('utf8').slice(0, remainingChars);
        if (text.length === 0) {
          continue;
        }
        files.push({ path, content: text, sizeBytes });
        remainingChars -= text.length;
      }

      return {
        tree: renderTree(tracked, request.maxTreeChars),
        files,
        totalTrackedFileCount: tracked.length,
      };
    },
  };
}
