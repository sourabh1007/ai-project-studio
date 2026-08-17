import { describe, expect, it } from 'vitest';
import {
  createAzureDescriptionGateway,
  parseDescription,
  pullUrl,
} from './azure-pr-description.js';
import type { AzureDescriptionDeps } from './azure-pr-description.js';

const target = { org: 'o', project: 'p', repo: 'r', pullRequestId: 7 };

function deps(overrides: Partial<AzureDescriptionDeps>): AzureDescriptionDeps {
  return {
    token: async () => 'tok',
    httpGet: async () => ({ status: 200, body: { description: 'current' } }),
    httpPatch: async () => ({ status: 200, body: null }),
    ...overrides,
  };
}

describe('azure-pr-description helpers', () => {
  it('builds the pull URL', () => {
    expect(pullUrl(target)).toContain('/pullRequests/7?api-version=7.1');
  });

  it('parses a description, defaulting to empty', () => {
    expect(parseDescription({ description: 'x' })).toBe('x');
    expect(parseDescription({})).toBe('');
  });
});

describe('createAzureDescriptionGateway', () => {
  it('reads the description', async () => {
    const gw = createAzureDescriptionGateway(deps({}), target);
    expect(await gw.getBody()).toBe('current');
  });

  it('throws when not signed in', async () => {
    const gw = createAzureDescriptionGateway(
      deps({ token: async () => null }),
      target,
    );
    await expect(gw.getBody()).rejects.toThrow('Not signed in');
  });

  it('throws when the read fails', async () => {
    const gw = createAzureDescriptionGateway(
      deps({ httpGet: async () => ({ status: 404, body: null }) }),
      target,
    );
    await expect(gw.getBody()).rejects.toThrow('HTTP 404');
  });

  it('patches the description', async () => {
    let sent: unknown = null;
    const gw = createAzureDescriptionGateway(
      deps({
        httpPatch: async (_url, _token, body) => ((sent = body), { status: 200, body: null }),
      }),
      target,
    );
    await gw.setBody('next');
    expect(sent).toEqual({ description: 'next' });
  });

  it('throws when the patch fails', async () => {
    const gw = createAzureDescriptionGateway(
      deps({ httpPatch: async () => ({ status: 500, body: null }) }),
      target,
    );
    await expect(gw.setBody('x')).rejects.toThrow('HTTP 500');
  });
});
