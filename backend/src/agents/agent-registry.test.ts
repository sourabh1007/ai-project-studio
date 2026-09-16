import { describe, it, expect } from 'vitest';
import { createAgentRegistry } from './agent-registry.js';
import type { AgentDefinition } from './agent-contract.js';

function fakeAgent(id: string): AgentDefinition {
  return {
    manifest: {
      id,
      title: id,
      description: '',
      icon: 'icon',
      allowMultiplePerFeature: false,
      prerequisiteLabel: '',
      usageLabel: id,
      promptFields: [],
    },
    checkPrerequisite: () => ({ met: true }),
  };
}

describe('agent-registry', () => {
  it('lists definitions in registration order and looks them up by id', () => {
    const a = fakeAgent('a');
    const b = fakeAgent('b');
    const registry = createAgentRegistry([a, b]);
    expect(registry.list().map((d) => d.manifest.id)).toEqual(['a', 'b']);
    expect(registry.get('b')).toBe(b);
  });

  it('returns null for an unknown id', () => {
    const registry = createAgentRegistry([fakeAgent('a')]);
    expect(registry.get('missing')).toBeNull();
  });

  it('returns a defensive copy of the list', () => {
    const registry = createAgentRegistry([fakeAgent('a')]);
    registry.list().push(fakeAgent('x'));
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects duplicate agent ids', () => {
    expect(() => createAgentRegistry([fakeAgent('dup'), fakeAgent('dup')])).toThrow(
      /Duplicate agent id: dup/,
    );
  });
});
