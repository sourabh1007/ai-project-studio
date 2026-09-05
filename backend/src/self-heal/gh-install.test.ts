import { describe, expect, it } from 'vitest';
import { buildGhInstallPlan } from './gh-install.js';

describe('buildGhInstallPlan', () => {
  it('uses winget on Windows', () => {
    const plan = buildGhInstallPlan('win32');
    expect(plan.supported).toBe(true);
    expect(plan.command).toBe('winget');
    expect(plan.args).toContain('GitHub.cli');
    expect(plan.args).toContain('--accept-package-agreements');
    expect(plan.help).toMatch(/winget/i);
  });

  it('uses Homebrew on macOS', () => {
    const plan = buildGhInstallPlan('darwin');
    expect(plan.supported).toBe(true);
    expect(plan.command).toBe('brew');
    expect(plan.args).toEqual(['install', 'gh']);
    expect(plan.help).toMatch(/homebrew/i);
  });

  it('is unsupported with guidance on other platforms', () => {
    const plan = buildGhInstallPlan('linux');
    expect(plan.supported).toBe(false);
    expect(plan.command).toBe('');
    expect(plan.args).toEqual([]);
    expect(plan.help).toMatch(/cli\.github\.com/);
  });
});
