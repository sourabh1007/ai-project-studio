import { describe, it, expect } from 'vitest';
import { listAgencyModels } from './agency-model-lister.js';
import { agencyDefaults } from './config.js';

describe('agency-model-lister', () => {
  it('maps configured models to ModelInfo', () => {
    const models = listAgencyModels(agencyDefaults);
    expect(models).toEqual(
      agencyDefaults.models.map((m) => ({ id: m.id, label: m.label })),
    );
  });

  it('reflects a custom configured list', () => {
    const models = listAgencyModels({
      ...agencyDefaults,
      models: [{ id: 'x', label: 'X' }],
    });
    expect(models).toEqual([{ id: 'x', label: 'X' }]);
  });
});
