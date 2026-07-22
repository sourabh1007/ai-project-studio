import { describe, it, expect } from 'vitest';
import { listCopilotModels } from './copilot-model-lister.js';
import { copilotDefaults } from './config.js';

describe('copilot-model-lister', () => {
  it('maps configured models to ModelInfo', () => {
    const models = listCopilotModels(copilotDefaults);
    expect(models).toEqual(
      copilotDefaults.models.map((m) => ({ id: m.id, label: m.label })),
    );
  });

  it('reflects a custom configured list', () => {
    const models = listCopilotModels({
      ...copilotDefaults,
      models: [{ id: 'x', label: 'X' }],
    });
    expect(models).toEqual([{ id: 'x', label: 'X' }]);
  });
});
