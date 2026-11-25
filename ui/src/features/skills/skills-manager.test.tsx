import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { Skill } from '../../lib/types.js';
import { SkillsManager } from './skills-manager.js';

const cosmos: Skill = {
  id: 'cosmos-auth', name: 'Cosmos DB: Authentication and trust boundaries', kind: 'instruction',
  instructions: 'Our edited authorization checklist.', removalInstructions: '', recommendedScope: 'feature', createdAt: '',
};
const general: Skill = { ...cosmos, id: 'general', name: 'General review' };

describe('Cosmos DB Skills library section', () => {
  it('groups relevant IDE checklists separately while retaining editable instructions and per-card actions', async () => {
    const api = {
      listSkills: vi.fn().mockResolvedValue([cosmos, general]),
      updateSkill: vi.fn().mockResolvedValue(cosmos),
      deleteSkill: vi.fn().mockResolvedValue(undefined),
    };
    render(<ApiProvider value={api as unknown as ApiClient}><SkillsManager /></ApiProvider>);
    const section = await screen.findByRole('region', { name: 'Cosmos DB IDE skills' });
    expect(within(section).getByText(cosmos.instructions)).toBeVisible();
    expect(within(section).queryByText(general.name)).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Other IDE skills' })).getByText(general.name)).toBeVisible();
    expect(within(section).getByRole('button', { name: `Download ${cosmos.name}` })).toBeEnabled();
    fireEvent.click(within(section).getByRole('button', { name: `Edit ${cosmos.name}` }));
    expect(screen.getByLabelText('Instructions')).toHaveValue(cosmos.instructions);
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Verify denied and allowed callers.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.updateSkill).toHaveBeenCalledWith(cosmos.id,
      expect.objectContaining({ instructions: 'Verify denied and allowed callers.' })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: `Delete ${cosmos.name}` }));
    await waitFor(() => expect(api.deleteSkill).toHaveBeenCalledWith(cosmos.id));
  });
});
