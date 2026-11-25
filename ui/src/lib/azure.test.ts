import { describe, it, expect } from 'vitest';
import { azureOrganization, describeAzureConnection, parseAzureOrganizations } from './azure.js';

describe('saved Azure organizations', () => {
  it('canonicalizes supported hosted organizations and rejects ambiguous or invalid hosts', () => {
    expect(azureOrganization(' Fabrikam ')).toBe('fabrikam');
    expect(azureOrganization('https://dev.azure.com/Fabrikam/Project/_git/repo')).toBe('fabrikam');
    expect(azureOrganization('FABRIKAM.visualstudio.com/Project/_git/repo')).toBe('fabrikam');
    for (const value of ['', 'bad org', 'http://dev.azure.com/org', 'https://github.com/org/repo', 'http://', 'https://dev.azure.com']) {
      expect(azureOrganization(value)).toBeNull();
    }
  });
  it('merges legacy organization settings, removes invalid entries and deduplicates URL aliases', () => {
    expect(parseAzureOrganizations(JSON.stringify([
      'fabrikam', 'https://fabrikam.visualstudio.com/Project/_git/repo', 'Contoso', 42, null, 'https://github.com/org/repo',
    ]), 'https://dev.azure.com/FABRIKAM/Project')).toEqual(['fabrikam', 'contoso']);
    expect(parseAzureOrganizations('invalid json', 'contoso')).toEqual(['contoso']);
    expect(parseAzureOrganizations('{}', '')).toEqual([]);
    expect(parseAzureOrganizations('', '')).toEqual([]);
  });
});

describe('describeAzureConnection', () => {
  it('returns empty for blank input', () => {
    expect(describeAzureConnection('')).toEqual({
      org: null,
      project: null,
      repo: null,
      label: '',
    });
    expect(describeAzureConnection(null)).toEqual({
      org: null,
      project: null,
      repo: null,
      label: '',
    });
    expect(describeAzureConnection(undefined).label).toBe('');
    expect(describeAzureConnection('   ').label).toBe('');
  });

  it('treats a bare org name as the org', () => {
    expect(describeAzureConnection('fabrikam')).toEqual({
      org: 'fabrikam',
      project: null,
      repo: null,
      label: 'fabrikam',
    });
  });

  it('parses a dev.azure.com org URL', () => {
    expect(describeAzureConnection('https://dev.azure.com/fabrikam')).toEqual({
      org: 'fabrikam',
      project: null,
      repo: null,
      label: 'fabrikam',
    });
  });

  it('parses a full repo URL into org / repo', () => {
    expect(
      describeAzureConnection(
        'https://dev.azure.com/fabrikam/Northwind/_git/inventory-api',
      ),
    ).toEqual({
      org: 'fabrikam',
      project: 'Northwind',
      repo: 'inventory-api',
      label: 'fabrikam / inventory-api',
    });
  });

  it('handles a _git URL with no repo segment', () => {
    expect(
      describeAzureConnection('https://dev.azure.com/fabrikam/Northwind/_git'),
    ).toEqual({
      org: 'fabrikam',
      project: 'Northwind',
      repo: null,
      label: 'fabrikam',
    });
  });

  it('parses a legacy visualstudio.com host', () => {
    expect(
      describeAzureConnection(
        'https://fabrikam.visualstudio.com/Northwind/_git/inventory-api',
      ),
    ).toEqual({
      org: 'fabrikam',
      project: 'Northwind',
      repo: 'inventory-api',
      label: 'fabrikam / inventory-api',
    });
  });

  it('accepts a URL without a scheme', () => {
    expect(describeAzureConnection('dev.azure.com/fabrikam')).toEqual({
      org: 'fabrikam',
      project: null,
      repo: null,
      label: 'fabrikam',
    });
  });

  it('falls back to the raw string when a URL-shaped value cannot be parsed', () => {
    expect(describeAzureConnection('http://')).toEqual({
      org: 'http://',
      project: null,
      repo: null,
      label: 'http://',
    });
  });

  it('verifies the documented Azure DevOps URL examples', () => {
    expect(
      describeAzureConnection(
        ' https://msdata.visualstudio.com/CosmosDB/_git/CosmosDB ',
      ),
    ).toEqual({
      org: 'msdata',
      project: 'CosmosDB',
      repo: 'CosmosDB',
      label: 'msdata / CosmosDB',
    });
    expect(
      describeAzureConnection(
        'https://dev.azure.com/msdata/CosmosDB/_git/CosmosDB/',
      ),
    ).toEqual({
      org: 'msdata',
      project: 'CosmosDB',
      repo: 'CosmosDB',
      label: 'msdata / CosmosDB',
    });
  });

  it('yields a null org for a host-only URL with an empty path', () => {
    const result = describeAzureConnection('https://dev.azure.com');
    expect(result.org).toBeNull();
    expect(result.label).toBe('');
  });

  it('resolves an org from an unknown host by first path segment', () => {
    expect(
      describeAzureConnection('https://onprem.example.com/myorg/proj/_git/repo'),
    ).toEqual({
      org: 'myorg',
      project: 'proj',
      repo: 'repo',
      label: 'myorg / repo',
    });
  });

  it('handles a visualstudio.com host with no leading label', () => {
    const result = describeAzureConnection('https://.visualstudio.com/');
    expect(result.org).toBeNull();
    expect(result.label).toBe('');
  });

  it.each([
    ['https://msazure.visualstudio.com/Liftr/_git/Liftr.Nginx', 'msazure', 'Liftr', 'Liftr.Nginx'],
    ['https://msazure.visualstudio.com/DefaultCollection/Liftr/_git/Liftr.Nginx', 'msazure', 'Liftr', 'Liftr.Nginx'],
    ['https://dev.azure.com/org/Team%20Project/_git/my%20repo', 'org', 'Team Project', 'my repo'],
    ['https://dev.azure.com/org/Team%20Project', 'org', 'Team Project', null],
    ['https://org.visualstudio.com/Team%20Project', 'org', 'Team Project', null],
    ['https://org.visualstudio.com/', 'org', null, null],
    ['https://org.visualstudio.com/_git/repo', 'org', 'repo', 'repo'],
    ['https://org.visualstudio.com/_git', 'org', null, null],
    ['https://dev.azure.com/org/_git/repo', 'org', 'repo', 'repo'],
    ['https://dev.azure.com/org/_git', 'org', null, null],
    ['https://dev.azure.com/org/%E0%A4%A/_git/repo', 'org', '%E0%A4%A', 'repo'],
  ])('disambiguates organization, project and repository in %s', (url, org, project, repo) => {
    expect(describeAzureConnection(url)).toMatchObject({ org, project, repo });
  });
});
