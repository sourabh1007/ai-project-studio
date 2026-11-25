import { describe, expect, it, vi } from 'vitest';
import { createPlannerTrackingRoutes } from './planner-tracking-controller.js';
import type { WorkTracker } from '../planner-tracking/tracking-contract.js';
import { ValidationError } from '../kernel/error-types.js';

describe('Planner tracking routes', () => {
  it('reads status, persists pause/resume and loads evidence without dispatching AI', () => {
    const status = { enabled: true };
    const tracker = { status: vi.fn(() => status), setEnabled: vi.fn(() => status) } as unknown as WorkTracker;
    const store = { provenance: vi.fn(() => null) };
    const routes = createPlannerTrackingRoutes({ tracker, store });
    const req = { body: { enabled: false }, params: { taskId: 'task' }, query: {} };
    expect(routes[0].handler(req)).toEqual({ status: 200, body: status });
    expect(routes[1].handler(req)).toEqual({ status: 200, body: status });
    expect(tracker.setEnabled).toHaveBeenCalledWith(false);
    expect(routes[2].handler(req)).toEqual({ status: 200, body: null });
    expect(store.provenance).toHaveBeenCalledWith('task');
    expect(() => routes[1].handler({ ...req, body: { enabled: 'yes' } })).toThrow(ValidationError);
  });
});
