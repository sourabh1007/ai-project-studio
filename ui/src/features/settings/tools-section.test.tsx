import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolsSection, OPEN_TOOL_OWNER_EVENT } from './tools-section.js';
import { projectToolConfig, projectToolValues, setToolPatch, toolFields } from './tools-model.js';
import type { CommandCatalogEntry, ConfigResponse } from '../../lib/types.js';

const entries: CommandCatalogEntry[] = [
  { id: 'git', label: 'Git', category: 'repository', description: 'Shared executable', config: { namespace: 'git', keys: ['executable'] }, required: ['Direct argv'], sources: ['gitRun'] },
  { id: 'mcp', label: 'MCP servers', category: 'mcp', description: 'Native definitions', owner: 'native', settingsLink: 'mcp', required: ['Protocol'], sources: ['inspect'] },
];

describe('Tools & CLIs', () => {
  it('renders metadata and routes editing to the native owner without inspecting or running commands', () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_TOOL_OWNER_EVENT, listener);
    const { rerender } = render(<ToolsSection entries={entries} query="" />);
    expect(screen.getByText('gitRun')).toBeInTheDocument();
    expect(screen.getByText('Direct argv')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open MCP definitions', hidden: true }));
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('mcp');
    rerender(<ToolsSection entries={entries} query="native" />);
    expect(screen.queryByText('gitRun')).toBeNull();
    window.removeEventListener(OPEN_TOOL_OWNER_EVENT, listener);
  });

  it('projects only catalog-owned fields, hiding native hints and leaving nested settings in their original module', () => {
    const all = [...entries, { ...entries[0], id: 'profile', config: { namespace: 'git', keys: ['profile.versionArgs', 'missing', 'profile.versionArgs'] } }];
    const fields = toolFields(all);
    expect(fields.get('git')).toEqual(['executable', 'profile.versionArgs', 'missing']);
    const data: ConfigResponse = {
      namespaces: ['git'], defaults: {}, overrides: { git: { profile: { versionArgs: ['-v'] } } },
      current: { git: { executable: 'git', profile: { versionArgs: ['--version'], token: 'private' } } },
      schema: { git: { kind: 'object', fields: { executable: { kind: 'string' }, profile: { kind: 'object', fields: { versionArgs: { kind: 'array' } } } } } },
    };
    const projected = projectToolConfig(data, fields);
    expect(projected.current.git).toEqual({ executable: 'git', 'profile.versionArgs': ['--version'] });
    expect(projected.schema?.git.fields?.['profile.versionArgs']).toEqual({ kind: 'array' });
    expect(projected.overrides.git).toEqual({ 'profile.versionArgs': ['-v'] });
    const patch = {};
    setToolPatch(patch, 'profile.versionArgs', ['-v']);
    setToolPatch(patch, 'profile.extra', []);
    setToolPatch(patch, 'executable', 'custom');
    expect(patch).toEqual({ profile: { versionArgs: ['-v'], extra: [] }, executable: 'custom' });
    expect(projectToolValues({ parent: null }, ['parent.child', 'absent'])).toEqual({});
    expect(projectToolConfig({ ...data, schema: undefined, current: {}, overrides: {} }, fields).current.git).toEqual({});
  });

  it('hides unsupported Copilot reload hints while retaining the Agency-owned reload editor', () => {
    const fields = toolFields([
      { ...entries[0], config: { namespace: 'copilot', keys: ['commandProfile.usageCommand'] } },
      { ...entries[0], id: 'agency', config: { namespace: 'agency', keys: ['commandProfile.usageCommand', 'commandProfile.liveReloadCommand'] } },
    ]);
    const profile = { commandProfile: { usageCommand: '/usage', liveReloadCommand: '/restart' } };
    const result = projectToolConfig({
      namespaces: ['copilot', 'agency'], defaults: {}, overrides: { copilot: profile, agency: profile },
      current: { copilot: profile, agency: profile },
    }, fields);
    expect(result.current.copilot).toEqual({ 'commandProfile.usageCommand': '/usage' });
    expect(result.overrides.copilot).not.toHaveProperty('commandProfile.liveReloadCommand');
    expect(result.current.agency['commandProfile.liveReloadCommand']).toBe('/restart');
    expect(result.overrides.agency['commandProfile.liveReloadCommand']).toBe('/restart');
  });
});
