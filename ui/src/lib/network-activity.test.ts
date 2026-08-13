import { describe, expect, it } from 'vitest';
import {
  NETWORK_INTEGRATIONS,
  categoryLabel,
  groupIntegrationsByProvider,
  sensitivityLabel,
  summarizeEgress,
  filterIntegrations,
  listCategories,
  CATEGORY_ORDER,
  SENSITIVITY_ORDER,
  type IntegrationCategory,
  type DataSensitivity,
  type NetworkIntegration,
} from './network-activity.js';

describe('NETWORK_INTEGRATIONS', () => {
  it('has unique ids and non-empty required fields', () => {
    const ids = new Set<string>();
    for (const integration of NETWORK_INTEGRATIONS) {
      expect(ids.has(integration.id)).toBe(false);
      ids.add(integration.id);
      expect(integration.provider.length).toBeGreaterThan(0);
      expect(integration.purpose.length).toBeGreaterThan(0);
      expect(integration.dataShared.length).toBeGreaterThan(0);
      expect(integration.endpoints.length).toBeGreaterThan(0);
    }
    expect(ids.size).toBe(NETWORK_INTEGRATIONS.length);
  });
});

describe('groupIntegrationsByProvider', () => {
  it('groups the default catalog and preserves first-seen order', () => {
    const groups = groupIntegrationsByProvider();
    expect(groups.map((g) => g.provider)).toEqual([
      'GitHub',
      'Azure DevOps',
      'GitHub Copilot',
      'Microsoft',
      'MCP servers',
    ]);
    const total = groups.reduce((sum, g) => sum + g.integrations.length, 0);
    expect(total).toBe(NETWORK_INTEGRATIONS.length);
  });

  it('keeps integration order within a provider', () => {
    const github = groupIntegrationsByProvider().find((g) => g.provider === 'GitHub');
    expect(github?.integrations.map((i) => i.id)).toEqual([
      'github-auth',
      'github-repos',
      'github-pr-review',
    ]);
  });

  it('returns an empty list for empty input', () => {
    expect(groupIntegrationsByProvider([])).toEqual([]);
  });

  it('groups a custom list', () => {
    const custom: NetworkIntegration[] = [
      {
        id: 'a',
        provider: 'P',
        category: 'ai',
        purpose: 'x',
        dataShared: 'y',
        sensitivity: 'low',
        endpoints: ['e'],
        requiresAuth: true,
      },
      {
        id: 'b',
        provider: 'P',
        category: 'ai',
        purpose: 'x',
        dataShared: 'y',
        sensitivity: 'low',
        endpoints: ['e'],
        requiresAuth: false,
      },
    ];
    const groups = groupIntegrationsByProvider(custom);
    expect(groups).toHaveLength(1);
    expect(groups[0].integrations).toHaveLength(2);
  });
});

describe('summarizeEgress', () => {
  it('summarizes the default catalog', () => {
    const summary = summarizeEgress();
    expect(summary.total).toBe(NETWORK_INTEGRATIONS.length);
    expect(summary.authenticated).toBe(
      NETWORK_INTEGRATIONS.filter((i) => i.requiresAuth).length,
    );
    expect(summary.highSensitivity).toBe(
      NETWORK_INTEGRATIONS.filter((i) => i.sensitivity === 'high').length,
    );
    expect(summary.configurable).toBe(
      NETWORK_INTEGRATIONS.filter((i) => i.configurable).length,
    );
  });

  it('counts every branch on a mixed custom list', () => {
    const custom: NetworkIntegration[] = [
      {
        id: 'auth-high-cfg',
        provider: 'P',
        category: 'ai',
        purpose: 'x',
        dataShared: 'y',
        sensitivity: 'high',
        endpoints: ['e'],
        requiresAuth: true,
        configurable: true,
      },
      {
        id: 'plain',
        provider: 'P',
        category: 'tooling',
        purpose: 'x',
        dataShared: 'y',
        sensitivity: 'none',
        endpoints: ['e'],
        requiresAuth: false,
      },
    ];
    expect(summarizeEgress(custom)).toEqual({
      total: 2,
      authenticated: 1,
      highSensitivity: 1,
      configurable: 1,
    });
  });

  it('is all-zero for empty input', () => {
    expect(summarizeEgress([])).toEqual({
      total: 0,
      authenticated: 0,
      highSensitivity: 0,
      configurable: 0,
    });
  });
});

describe('categoryLabel', () => {
  it('labels every category', () => {
    const categories: IntegrationCategory[] = [
      'authentication',
      'source-control',
      'code-review',
      'ai',
      'tooling',
      'extension',
    ];
    for (const category of categories) {
      expect(categoryLabel(category).length).toBeGreaterThan(0);
    }
    expect(categoryLabel('code-review')).toBe('Code review');
  });
});

describe('sensitivityLabel', () => {
  it('labels every sensitivity level', () => {
    const levels: DataSensitivity[] = ['none', 'low', 'high'];
    for (const level of levels) {
      expect(sensitivityLabel(level).length).toBeGreaterThan(0);
    }
    expect(sensitivityLabel('high')).toBe('Sensitive data');
  });
});

const custom: NetworkIntegration[] = [
  {
    id: 'gh',
    provider: 'GitHub',
    category: 'source-control',
    purpose: 'List repos',
    dataShared: 'token and metadata',
    sensitivity: 'high',
    endpoints: ['api.github.com'],
    requiresAuth: true,
  },
  {
    id: 'tool',
    provider: 'Microsoft',
    category: 'tooling',
    purpose: 'Download installer',
    dataShared: 'nothing sensitive',
    sensitivity: 'none',
    endpoints: ['aka.ms/InstallTool.sh'],
    requiresAuth: false,
  },
];

describe('filterIntegrations', () => {
  it('returns the list unchanged for an empty filter', () => {
    expect(filterIntegrations(custom, {})).toEqual(custom);
    expect(filterIntegrations(custom)).toEqual(custom);
  });

  it('treats "all" selectors as no restriction', () => {
    expect(
      filterIntegrations(custom, { category: 'all', sensitivity: 'all' }),
    ).toEqual(custom);
  });

  it('filters by category', () => {
    const result = filterIntegrations(custom, { category: 'tooling' });
    expect(result.map((i) => i.id)).toEqual(['tool']);
  });

  it('filters by sensitivity', () => {
    const result = filterIntegrations(custom, { sensitivity: 'high' });
    expect(result.map((i) => i.id)).toEqual(['gh']);
  });

  it('filters to authenticated integrations only', () => {
    const result = filterIntegrations(custom, { authOnly: true });
    expect(result.map((i) => i.id)).toEqual(['gh']);
  });

  it('matches the query against provider, purpose, data, and endpoints', () => {
    expect(filterIntegrations(custom, { query: 'github' }).map((i) => i.id)).toEqual(['gh']);
    expect(filterIntegrations(custom, { query: 'installer' }).map((i) => i.id)).toEqual(['tool']);
    expect(filterIntegrations(custom, { query: 'metadata' }).map((i) => i.id)).toEqual(['gh']);
    expect(filterIntegrations(custom, { query: 'aka.ms' }).map((i) => i.id)).toEqual(['tool']);
  });

  it('trims/lowercases the query and returns nothing on no match', () => {
    expect(filterIntegrations(custom, { query: '  GITHUB ' }).map((i) => i.id)).toEqual(['gh']);
    expect(filterIntegrations(custom, { query: 'nomatch' })).toEqual([]);
  });

  it('combines multiple filters', () => {
    expect(
      filterIntegrations(custom, {
        category: 'source-control',
        authOnly: true,
        query: 'repos',
      }).map((i) => i.id),
    ).toEqual(['gh']);
  });
});

describe('listCategories', () => {
  it('returns present categories in canonical order', () => {
    expect(listCategories(custom)).toEqual(['source-control', 'tooling']);
  });

  it('defaults to the full catalog and only lists present categories', () => {
    const result = listCategories();
    const present = new Set(NETWORK_INTEGRATIONS.map((i) => i.category));
    expect(result).toEqual(CATEGORY_ORDER.filter((c) => present.has(c)));
  });
});

describe('ordering constants', () => {
  it('cover every category and sensitivity level', () => {
    expect([...CATEGORY_ORDER].sort()).toEqual(
      [
        'ai',
        'authentication',
        'code-review',
        'extension',
        'source-control',
        'tooling',
      ].sort(),
    );
    expect([...SENSITIVITY_ORDER].sort()).toEqual(['high', 'low', 'none'].sort());
  });
});
