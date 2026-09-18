import { describe, it, expect } from 'vitest';
import { describeAzureConnection } from './azure.js';

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
});
