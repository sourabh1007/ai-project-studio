import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_NAME = '@ai-project-studio/desktop';

function userDataRoot(): string {
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', APP_NAME);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', APP_NAME);
  }
  return join(homedir(), '.config', APP_NAME);
}

export function defaultWorkspaceDataDir(): string {
  return userDataRoot();
}

