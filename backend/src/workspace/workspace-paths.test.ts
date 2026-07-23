import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultWorkspaceDataDir } from './workspace-paths.js';

const APP_NAME = '@copilot-workspace/desktop';
const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

afterEach(() => {
  setPlatform(realPlatform);
});

describe('defaultWorkspaceDataDir', () => {
  it('uses AppData\\Roaming on Windows', () => {
    setPlatform('win32');
    expect(defaultWorkspaceDataDir()).toBe(
      join(homedir(), 'AppData', 'Roaming', APP_NAME),
    );
  });

  it('uses Library/Application Support on macOS', () => {
    setPlatform('darwin');
    expect(defaultWorkspaceDataDir()).toBe(
      join(homedir(), 'Library', 'Application Support', APP_NAME),
    );
  });

  it('falls back to ~/.config on Linux and other platforms', () => {
    setPlatform('linux');
    expect(defaultWorkspaceDataDir()).toBe(
      join(homedir(), '.config', APP_NAME),
    );
  });
});
