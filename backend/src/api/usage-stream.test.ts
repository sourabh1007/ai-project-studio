import { describe, it, expect } from 'vitest';
import { subscribeStream, type StreamEventMap, type SseSink } from './usage-stream.js';
import { createEventBus } from '../kernel/event-bus.js';

describe('subscribeStream', () => {
  it('forwards every stream event to the sink and can unsubscribe', () => {
    const bus = createEventBus<StreamEventMap>();
    const events: Array<{ event: string; data: unknown }> = [];
    const sink: SseSink = {
      send: (event, data) => events.push({ event, data }),
    };

    const off = subscribeStream(bus, sink);

    bus.emit('session.started', { id: 's1' } as never);
    bus.emit('session.output', { sessionId: 's1', event: { type: 'stdout', line: 'x' } });
    bus.emit('session.ended', { id: 's1' } as never);
    bus.emit('session.updated', { id: 's1' } as never);
    bus.emit('usage.recorded', { sessionId: 's1' } as never);

    expect(events.map((e) => e.event)).toEqual([
      'session.started',
      'session.output',
      'session.ended',
      'session.updated',
      'usage.recorded',
    ]);

    off();
    bus.emit('session.started', { id: 's2' } as never);
    expect(events).toHaveLength(5);
  });
});
