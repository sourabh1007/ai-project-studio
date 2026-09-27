import { expect, it } from 'vitest';
import { createDefaultAnalyzers } from './default-analyzers.js';

it('registers the production analyzers used by isolated graph workers', () => {
  const registry = createDefaultAnalyzers();
  for (const path of ['a.cs', 'a.ts', 'a.java', 'a.rs', 'a.cpp', 'ApplicationManifest.xml']) {
    expect(registry.analyzerFor(path)).not.toBeNull();
  }
  expect(registry.manifestMatchers()).toHaveLength(6);
});
