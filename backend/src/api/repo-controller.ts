import { z } from 'zod';
import type { RepoService } from '../repo/repo-service.js';
import type { CreateRepositoryInput } from '../repo/repo-contract.js';
import type { RemoteRepo } from '../repo/remote-repo-contract.js';
import type { ProvisionRepoInput } from '../repo/repo-provisioner.js';
import type { PrFeatureService } from '../repo/pr-feature-service.js';
import type { Route } from './http-contract.js';
import { parseInput } from './request-validation.js';

const createRepoSchema = z.object({
  provider: z.enum(['github', 'azure-devops']),
  remoteUrl: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().nullish(),
  localPath: z.string().min(1),
  mode: z.enum(['clone', 'existing']),
});

const reviewPullSchema = z.object({
  number: z.number().int().positive(),
});

export interface RepoControllerDeps {
  repos: RepoService;
  /** Clones or attaches an existing checkout, yielding a create input. */
  provision: (input: ProvisionRepoInput) => Promise<CreateRepositoryInput>;
  /** Lists the authenticated user's GitHub repositories. */
  listGithubRepos: () => Promise<RemoteRepo[]>;
  /** Lists repositories across an Azure DevOps organization's projects. */
  listAzureRepos: (org: string) => Promise<RemoteRepo[]>;
  /** Lists a repo's pull requests and turns one into a review feature. */
  prFeatures: PrFeatureService;
}

/**
 * Routes for the repository layer: the saved repositories the workspace is
 * organized around, plus the provider-backed lists the user picks from.
 */
export function createRepoRoutes(deps: RepoControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/repos',
      handler: () => ({ status: 200, body: deps.repos.list() }),
    },
    {
      method: 'post',
      path: '/repos',
      handler: async (req) => {
        const input = parseInput(createRepoSchema, req.body);
        const createInput = await deps.provision(input);
        return { status: 201, body: deps.repos.create(createInput) };
      },
    },
    {
      method: 'delete',
      path: '/repos/:id',
      handler: (req) => {
        deps.repos.remove(req.params.id);
        return { status: 200, body: { id: req.params.id } };
      },
    },
    {
      method: 'get',
      path: '/providers/github/repos',
      handler: async () => ({
        status: 200,
        body: await deps.listGithubRepos(),
      }),
    },
    {
      method: 'get',
      path: '/providers/azure-devops/repos',
      handler: async (req) => {
        const org = typeof req.query.org === 'string' ? req.query.org : '';
        return { status: 200, body: await deps.listAzureRepos(org) };
      },
    },
    {
      method: 'get',
      path: '/repos/:id/pulls',
      handler: async (req) => ({
        status: 200,
        body: await deps.prFeatures.listPulls(req.params.id),
      }),
    },
    {
      method: 'post',
      path: '/repos/:id/pulls',
      handler: async (req) => {
        const input = parseInput(reviewPullSchema, req.body);
        const feature = await deps.prFeatures.createFromPull(
          req.params.id,
          input.number,
        );
        return { status: 201, body: feature };
      },
    },
  ];
}
