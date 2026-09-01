import { describe, expect, it } from 'vitest';
import {
  AZURE_DEVOPS_CREDENTIAL_ENV_KEYS,
  buildAzureDevOpsCredentialEnv,
} from './azure-devops-credential-env.js';

describe('buildAzureDevOpsCredentialEnv', () => {
  it('returns an empty object when there is no token', () => {
    expect(buildAzureDevOpsCredentialEnv(null)).toEqual({});
    expect(buildAzureDevOpsCredentialEnv('')).toEqual({});
  });

  it('exposes the token under common Azure DevOps MCP/tool variables', () => {
    const env = buildAzureDevOpsCredentialEnv('ado-token');

    expect(env.AZURE_DEVOPS_EXT_PAT).toBe('ado-token');
    expect(env.AZURE_DEVOPS_PAT).toBe('ado-token');
    expect(env.ADO_PAT).toBe('ado-token');
    expect(env.AZDO_PAT).toBe('ado-token');
    expect(env.SYSTEM_ACCESSTOKEN).toBe('ado-token');
  });

  it('keeps inherited GCM/Git auth non-interactive', () => {
    const env = buildAzureDevOpsCredentialEnv('ado-token');

    expect(env.GCM_INTERACTIVE).toBe('never');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GCM_MSAUTH_USEBROKER).toBe('false');
    expect(env.GCM_AZREPOS_CREDENTIALTYPE).toBe('oauth');
  });

  it('lists every key that must be cleared on sign-out or refresh failure', () => {
    expect(new Set(AZURE_DEVOPS_CREDENTIAL_ENV_KEYS)).toEqual(
      new Set(Object.keys(buildAzureDevOpsCredentialEnv('ado-token'))),
    );
  });
});
