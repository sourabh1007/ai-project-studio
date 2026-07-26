import { describe, it, expect } from 'vitest';
import { agencyInstallCommand } from './agency-install-command.js';

describe('agencyInstallCommand', () => {
  it('uses the PowerShell InstallTool bootstrap on Windows', () => {
    const plan = agencyInstallCommand('win32');
    expect(plan.command).toBe('powershell');
    expect(plan.args).toContain('iex "& { $(irm aka.ms/InstallTool.ps1)} agency"');
    expect(plan.args).toContain('-NoProfile');
  });

  it('uses the POSIX shell InstallTool bootstrap on non-Windows', () => {
    const plan = agencyInstallCommand('darwin');
    expect(plan.command).toBe('sh');
    expect(plan.args).toEqual([
      '-c',
      'curl -sSfL https://aka.ms/InstallTool.sh | sh -s agency',
    ]);
  });
});
