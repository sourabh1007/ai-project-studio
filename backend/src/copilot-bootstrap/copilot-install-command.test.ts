import { describe, it, expect } from 'vitest';
import { copilotInstallCommand } from './copilot-install-command.js';

describe('copilotInstallCommand', () => {
  it('runs npm through cmd on Windows', () => {
    expect(copilotInstallCommand('win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'npm install -g @github/copilot'],
    });
  });

  it('runs npm through sh on POSIX platforms', () => {
    expect(copilotInstallCommand('linux')).toEqual({
      command: 'sh',
      args: ['-c', 'npm install -g @github/copilot'],
    });
    expect(copilotInstallCommand('darwin')).toEqual({
      command: 'sh',
      args: ['-c', 'npm install -g @github/copilot'],
    });
  });
});
