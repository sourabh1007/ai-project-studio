import { describe, it, expect } from 'vitest';
import { createRepoService } from './repo-service.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createClock } from '../kernel/clock.js';
import { AppError } from '../kernel/error-types.js';
import type { Repository } from './repo-contract.js';
import type { RepoRepo } from './repo-repo-port.js';

function inMemoryRepo(): RepoRepo {
  const store = new Map<string, Repository>();
  return {
    create: (r) => void store.set(r.id, r),
    get: (id) => store.get(id) ?? null,
    list: () => [...store.values()],
    delete: (id) => void store.delete(id),
  };
}

function service(repo = inMemoryRepo()) {
  let n = 0;
  return createRepoService({
    repo,
    ids: createIdGenerator(() => `repo-${(n += 1)}`),
    clock: createClock(() => Date.parse('2025-01-01T00:00:00.000Z')),
  });
}

describe('repo-service', () => {
  it('creates a repository with generated id and timestamp', () => {
    const svc = service();
    const repo = svc.create({
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:/work/app',
      defaultBranch: 'main',
    });
    expect(repo).toEqual({
      id: 'repo-1',
      provider: 'github',
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:/work/app',
      defaultBranch: 'main',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(svc.get('repo-1')).toEqual(repo);
  });

  it('defaults an omitted default branch to null', () => {
    const svc = service();
    const repo = svc.create({
      provider: 'azure-devops',
      remoteUrl: 'https://dev.azure.com/org/proj/_git/repo',
      name: 'proj/repo',
      localPath: 'C:/work/repo',
    });
    expect(repo.defaultBranch).toBeNull();
  });

  it('lists created repositories', () => {
    const svc = service();
    svc.create({
      provider: 'github',
      remoteUrl: 'u1',
      name: 'a',
      localPath: 'p1',
    });
    svc.create({
      provider: 'github',
      remoteUrl: 'u2',
      name: 'b',
      localPath: 'p2',
    });
    expect(svc.list().map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('removes a repository', () => {
    const svc = service();
    svc.create({
      provider: 'github',
      remoteUrl: 'u',
      name: 'a',
      localPath: 'p',
    });
    svc.remove('repo-1');
    expect(() => svc.get('repo-1')).toThrow(AppError);
  });

  it('throws NotFound for unknown repositories', () => {
    const svc = service();
    expect(() => svc.get('nope')).toThrow(AppError);
    expect(() => svc.remove('nope')).toThrow(AppError);
  });

  it('rejects adding the same remote at the same local path twice', () => {
    const svc = service();
    const input = {
      provider: 'github' as const,
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
      localPath: 'C:/work/app',
    };
    svc.create(input);
    expect(() => svc.create(input)).toThrow(/already added/);
  });

  it('allows the same remote at a different local path', () => {
    const svc = service();
    const base = {
      provider: 'github' as const,
      remoteUrl: 'https://github.com/acme/app.git',
      name: 'acme/app',
    };
    svc.create({ ...base, localPath: 'C:/work/app' });
    expect(() =>
      svc.create({ ...base, localPath: 'C:/work/app-2' }),
    ).not.toThrow();
    expect(svc.list()).toHaveLength(2);
  });
});
