/**
 * Builds the environment that lets Azure DevOps-aware child processes reuse the
 * OAuth access token already cached by Git Credential Manager. Many MCP servers
 * and Azure DevOps tools check one of these PAT-style variables before falling
 * back to MSAL/azure-identity interactive browser auth; publishing the cached
 * token under the common names keeps spawned sessions and MCP servers silent
 * after the app's explicit sign-in has primed GCM.
 */
export const AZURE_DEVOPS_CREDENTIAL_ENV_KEYS = [
  'AZURE_DEVOPS_EXT_PAT',
  'AZURE_DEVOPS_PAT',
  'ADO_PAT',
  'AZDO_PAT',
  'SYSTEM_ACCESSTOKEN',
  'GCM_INTERACTIVE',
  'GIT_TERMINAL_PROMPT',
  'GCM_MSAUTH_USEBROKER',
  'GCM_AZREPOS_CREDENTIALTYPE',
] as const;

export function buildAzureDevOpsCredentialEnv(
  token: string | null,
): Record<string, string> {
  if (!token) {
    return {};
  }
  return {
    AZURE_DEVOPS_EXT_PAT: token,
    AZURE_DEVOPS_PAT: token,
    ADO_PAT: token,
    AZDO_PAT: token,
    SYSTEM_ACCESSTOKEN: token,
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0',
    GCM_MSAUTH_USEBROKER: 'false',
    GCM_AZREPOS_CREDENTIALTYPE: 'oauth',
  };
}
