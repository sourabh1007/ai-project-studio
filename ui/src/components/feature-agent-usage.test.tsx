import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentUsageValue } from './feature-agent-usage.js';
describe('AgentUsageValue', () => {
  it('distinguishes unavailable, partial and genuine zero costs', () => {
    const { rerender } = render(<AgentUsageValue usage={{ aic: null, operations: 1, unknownOperations: 1, running: true }} />);
    expect(screen.getByLabelText('Agent AI credits')).toHaveTextContent('AIC unavailable · partial');
    rerender(<AgentUsageValue usage={{ aic: 0, operations: 1, unknownOperations: 0, running: false }} />);
    expect(screen.getByLabelText('Agent AI credits')).toHaveTextContent('0 AIC');
    rerender(<AgentUsageValue usage={{ aic: 2, operations: 2, unknownOperations: 1, running: false }} />);
    expect(screen.getByLabelText('Agent AI credits')).toHaveTextContent('2 AIC · partial');
  });
});
