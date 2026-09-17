import { describe, it, expect } from 'vitest';
import {
  BUG_BASH_NAMESPACE,
  bugBashConfigSchema,
  bugBashDefaults,
} from './config.js';

describe('bug-bash config', () => {
  it('exposes a stable namespace', () => {
    expect(BUG_BASH_NAMESPACE).toBe('bugBash');
  });

  it('accepts its own defaults', () => {
    expect(() => bugBashConfigSchema.parse(bugBashDefaults)).not.toThrow();
    expect(bugBashDefaults.generateTimeoutMs).toBeGreaterThan(0);
    expect(bugBashDefaults.runTimeoutMs).toBeGreaterThan(0);
    expect(bugBashDefaults.maxTesters).toBeGreaterThanOrEqual(1);
    expect(bugBashDefaults.maxAnalysts).toBeGreaterThanOrEqual(1);
    expect(bugBashDefaults.decomposePromptTemplate.length).toBeGreaterThan(0);
    expect(bugBashDefaults.generatePromptTemplate.length).toBeGreaterThan(0);
    expect(bugBashDefaults.testerPromptTemplate.length).toBeGreaterThan(0);
    expect(bugBashDefaults.reportPromptTemplate.length).toBeGreaterThan(0);
    expect(bugBashDefaults.refinePromptTemplate.length).toBeGreaterThan(0);
  });

  it('rejects a non-positive timeout', () => {
    expect(() =>
      bugBashConfigSchema.parse({ ...bugBashDefaults, generateTimeoutMs: 0 }),
    ).toThrow();
  });

  it('rejects too many testers', () => {
    expect(() =>
      bugBashConfigSchema.parse({ ...bugBashDefaults, maxTesters: 11 }),
    ).toThrow();
  });

  it('rejects too many analysts', () => {
    expect(() =>
      bugBashConfigSchema.parse({ ...bugBashDefaults, maxAnalysts: 11 }),
    ).toThrow();
  });
});
