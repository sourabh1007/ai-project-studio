import { describe, it, expect } from 'vitest';
import type { AzureRepoTarget } from './azure-pr-lister.js';
import type { AzureHttpResponse } from './azure-repo-lister.js';
import {
  activeWorkItemsWiql,
  wiqlUrl,
  workItemsUrl,
  workItemWebUrl,
  workItemCommentsUrl,
  parseWiqlIds,
  parseWorkItems,
  parseWorkItemComments,
  htmlToText,
  listAzureWorkItems,
  listAzureWorkItemComments,
  adoErrorDetail,
  type AzureWorkItemDeps,
} from './azure-workitem-lister.js';

const target: AzureRepoTarget = {
  org: 'acme',
  project: 'North wind',
  repo: 'app',
};

function deps(opts: {
  token?: string | null;
  post?: AzureHttpResponse;
  get?: AzureHttpResponse;
  postCalls?: { url: string; body: unknown }[];
  getCalls?: string[];
}): AzureWorkItemDeps {
  return {
    token: () => Promise.resolve(opts.token === undefined ? 'tok' : opts.token),
    httpPost: (url, _token, body) => {
      opts.postCalls?.push({ url, body });
      return Promise.resolve(opts.post ?? { status: 200, body: {} });
    },
    httpGet: (url) => {
      opts.getCalls?.push(url);
      return Promise.resolve(opts.get ?? { status: 200, body: {} });
    },
  };
}

describe('activeWorkItemsWiql', () => {
  it('scopes to the project and current user, excludes closed states, and escapes quotes', () => {
    const wiql = activeWorkItemsWiql("O'Brien");
    expect(wiql).toContain("[System.TeamProject] = 'O''Brien'");
    expect(wiql).toContain("NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed')");
    expect(wiql).toContain('[System.AssignedTo] = @Me');
    expect(wiql).toContain('ORDER BY [System.ChangedDate] DESC');
  });

  it('applies assignedTo=all, an explicit state, area, iteration, and tag filters', () => {
    const wiql = activeWorkItemsWiql('Proj', {
      assignedTo: 'all',
      state: 'Active',
      area: "Proj\\Team's",
      iteration: 'Proj\\Sprint 1',
      tag: 'GSI',
    });
    expect(wiql).not.toContain('@Me');
    expect(wiql).not.toContain('NOT IN');
    expect(wiql).toContain("[System.State] = 'Active'");
    expect(wiql).toContain("[System.AreaPath] UNDER 'Proj\\Team''s'");
    expect(wiql).toContain("[System.IterationPath] UNDER 'Proj\\Sprint 1'");
    expect(wiql).toContain("[System.Tags] CONTAINS 'GSI'");
  });

  it('ignores blank filter values and keeps the @Me default', () => {
    const wiql = activeWorkItemsWiql('Proj', {
      state: '   ',
      area: '',
      iteration: '  ',
      tag: '',
    });
    expect(wiql).toContain('[System.AssignedTo] = @Me');
    expect(wiql).toContain('NOT IN');
    expect(wiql).not.toContain('UNDER');
    expect(wiql).not.toContain('CONTAINS');
  });
});

describe('url builders', () => {
  it('builds the WIQL, batch, comments, and web URLs', () => {
    expect(wiqlUrl(target)).toBe(
      'https://dev.azure.com/acme/North%20wind/_apis/wit/wiql?api-version=7.1',
    );
    expect(workItemsUrl('acme', [1, 2, 3])).toBe(
      'https://dev.azure.com/acme/_apis/wit/workitems?ids=1,2,3' +
        '&fields=System.Id%2CSystem.Title%2CSystem.WorkItemType%2CSystem.State%2CSystem.AssignedTo%2CSystem.Description' +
        '&api-version=7.1',
    );
    expect(workItemCommentsUrl(target, 42)).toBe(
      'https://dev.azure.com/acme/North%20wind/_apis/wit/workItems/42/comments?api-version=7.1-preview.4',
    );
    expect(workItemWebUrl(target, 42)).toBe(
      'https://dev.azure.com/acme/North%20wind/_workitems/edit/42',
    );
  });
});

describe('parseWiqlIds', () => {
  it('extracts numeric ids in order', () => {
    expect(
      parseWiqlIds({ workItems: [{ id: 5 }, { id: 9 }, { id: undefined }, null] }),
    ).toEqual([5, 9]);
  });

  it('returns an empty array when workItems is missing or not an array', () => {
    expect(parseWiqlIds({})).toEqual([]);
    expect(parseWiqlIds(null)).toEqual([]);
    expect(parseWiqlIds({ workItems: 'nope' })).toEqual([]);
  });
});

describe('parseWorkItems', () => {
  it('maps work items with fields, defaulting missing values', () => {
    const items = parseWorkItems(target, {
      value: [
        {
          id: 1,
          fields: {
            'System.Title': 'Fix cache',
            'System.WorkItemType': 'Bug',
            'System.State': 'Active',
            'System.AssignedTo': { displayName: 'Mona Lisa' },
            'System.Description': '<div>Fix &amp; verify<br>cache&nbsp;hits</div>',
          },
        },
        {
          id: 2,
          fields: {
            'System.Title': '   ',
            'System.AssignedTo': 'legacy@acme.com',
            'System.Description': '<p>&nbsp;</p>',
          },
        },
        { id: 3, fields: { 'System.AssignedTo': { displayName: '  ' } } },
      ],
    });
    expect(items).toEqual([
      {
        provider: 'azure-devops',
        id: 1,
        title: 'Fix cache',
        url: 'https://dev.azure.com/acme/North%20wind/_workitems/edit/1',
        type: 'Bug',
        state: 'Active',
        assignedTo: 'Mona Lisa',
        description: 'Fix & verify cache hits',
      },
      {
        provider: 'azure-devops',
        id: 2,
        title: 'Work item 2',
        url: 'https://dev.azure.com/acme/North%20wind/_workitems/edit/2',
        type: 'Work Item',
        state: '',
        assignedTo: 'legacy@acme.com',
        description: null,
      },
      {
        provider: 'azure-devops',
        id: 3,
        title: 'Work item 3',
        url: 'https://dev.azure.com/acme/North%20wind/_workitems/edit/3',
        type: 'Work Item',
        state: '',
        assignedTo: null,
        description: null,
      },
    ]);
  });

  it('skips entries missing an id or fields', () => {
    const items = parseWorkItems(target, {
      value: [
        { fields: { 'System.Title': 'No id' } },
        { id: 4 },
        { id: 5, fields: null },
      ],
    });
    expect(items).toEqual([]);
  });

  it('returns an empty array when value is missing or not an array', () => {
    expect(parseWorkItems(target, {})).toEqual([]);
    expect(parseWorkItems(target, null)).toEqual([]);
    expect(parseWorkItems(target, { value: 'nope' })).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('strips tags, decodes common entities, collapses whitespace, and nulls empty values', () => {
    expect(
      htmlToText('<p>A&amp;B &lt;x&gt; &quot;q&quot; &#39;s&#39;&nbsp;z</p>'),
    ).toBe('A&B <x> "q" \'s\' z');
    expect(htmlToText('<div>  </div>')).toBeNull();
    expect(htmlToText(null)).toBeNull();
    expect(htmlToText(undefined)).toBeNull();
  });
});

describe('parseWorkItemComments', () => {
  it('returns non-empty plain-text comment bodies', () => {
    expect(
      parseWorkItemComments({
        comments: [
          { text: '<p>First &amp; second</p>' },
          { text: '<div>&nbsp;</div>' },
          { text: 42 },
          null,
          {},
          { text: ' Plain ' },
        ],
      }),
    ).toEqual(['First & second', 'Plain']);
  });

  it('returns an empty array for missing or malformed comments', () => {
    expect(parseWorkItemComments({})).toEqual([]);
    expect(parseWorkItemComments(null)).toEqual([]);
    expect(parseWorkItemComments({ comments: 'nope' })).toEqual([]);
  });
});

describe('adoErrorDetail', () => {
  it('extracts a trimmed message or returns empty for bodies without one', () => {
    expect(adoErrorDetail({ message: '  boom  ' })).toBe(': boom');
    expect(adoErrorDetail({ message: '   ' })).toBe('');
    expect(adoErrorDetail({ message: 42 })).toBe('');
    expect(adoErrorDetail({})).toBe('');
    expect(adoErrorDetail(null)).toBe('');
    expect(adoErrorDetail('nope')).toBe('');
  });
});

describe('listAzureWorkItems', () => {
  it('runs WIQL then batch-fetches the ids, slicing to the limit', async () => {
    const postCalls: { url: string; body: unknown }[] = [];
    const getCalls: string[] = [];
    const items = await listAzureWorkItems(
      deps({
        postCalls,
        getCalls,
        post: { status: 200, body: { workItems: [{ id: 11 }, { id: 22 }, { id: 33 }] } },
        get: {
          status: 200,
          body: {
            value: [
              { id: 11, fields: { 'System.Title': 'A' } },
              { id: 22, fields: { 'System.Title': 'B' } },
            ],
          },
        },
      }),
      target,
      { limit: 2 },
    );
    expect(items).toHaveLength(2);
    expect(postCalls[0].body).toEqual({ query: activeWorkItemsWiql(target.project) });
    expect(getCalls[0]).toContain('ids=11,22');
    expect(getCalls[0]).not.toContain('33');
  });

  it('threads the filter into the WIQL query', async () => {
    const postCalls: { url: string; body: unknown }[] = [];
    await listAzureWorkItems(
      deps({
        postCalls,
        post: { status: 200, body: { workItems: [] } },
      }),
      target,
      { filter: { assignedTo: 'all', tag: 'GSI' } },
    );
    expect(postCalls[0].body).toEqual({
      query: activeWorkItemsWiql(target.project, { assignedTo: 'all', tag: 'GSI' }),
    });
  });

  it('throws when not signed in', async () => {
    await expect(
      listAzureWorkItems(deps({ token: null }), target),
    ).rejects.toThrow('Not signed in to Azure DevOps');
  });

  it('throws when the WIQL query fails, surfacing the Azure error detail', async () => {
    await expect(
      listAzureWorkItems(
        deps({
          post: { status: 400, body: { message: 'VS402337: too many results' } },
        }),
        target,
      ),
    ).rejects.toThrow(
      'Failed to query Azure DevOps work items (HTTP 400): VS402337: too many results',
    );
  });

  it('throws without a detail when the WIQL query fails opaquely', async () => {
    await expect(
      listAzureWorkItems(deps({ post: { status: 403, body: {} } }), target),
    ).rejects.toThrow('Failed to query Azure DevOps work items (HTTP 403)');
  });

  it('returns an empty array when no ids come back', async () => {
    const items = await listAzureWorkItems(
      deps({ post: { status: 200, body: { workItems: [] } } }),
      target,
    );
    expect(items).toEqual([]);
  });

  it('throws when the batch fetch fails', async () => {
    await expect(
      listAzureWorkItems(
        deps({
          post: { status: 200, body: { workItems: [{ id: 1 }] } },
          get: { status: 500, body: {} },
        }),
        target,
      ),
    ).rejects.toThrow('Failed to load Azure DevOps work items (HTTP 500)');
  });
});

describe('listAzureWorkItemComments', () => {
  it('fetches and parses comments for one work item', async () => {
    const getCalls: string[] = [];
    const comments = await listAzureWorkItemComments(
      deps({
        getCalls,
        get: {
          status: 200,
          body: { comments: [{ text: '<p>Looks &amp; good</p>' }] },
        },
      }),
      target,
      7,
    );
    expect(comments).toEqual(['Looks & good']);
    expect(getCalls[0]).toBe(workItemCommentsUrl(target, 7));
  });

  it('throws when not signed in', async () => {
    await expect(
      listAzureWorkItemComments(deps({ token: null }), target, 7),
    ).rejects.toThrow('Not signed in to Azure DevOps');
  });

  it('throws when loading comments fails', async () => {
    await expect(
      listAzureWorkItemComments(
        deps({ get: { status: 404, body: {} } }),
        target,
        7,
      ),
    ).rejects.toThrow(
      'Failed to load Azure DevOps work-item comments (HTTP 404)',
    );
  });
});
