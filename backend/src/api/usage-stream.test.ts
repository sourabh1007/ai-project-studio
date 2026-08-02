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
    bus.emit('session.output', {
      sessionId: 's1',
      scope: 'feature',
      event: { type: 'stdout', line: 'x' },
    });
    bus.emit('session.ended', { id: 's1' } as never);
    bus.emit('session.updated', { id: 's1' } as never);
    bus.emit('usage.recorded', { sessionId: 's1' } as never);
    bus.emit('repository.context.updated', {
      repositoryId: 'r1',
      status: 'ready',
    } as never);
    bus.emit('pr.review.updated', {
      featureId: 'f1',
      status: 'ready',
    } as never);

    expect(events.map((e) => e.event)).toEqual([
      'session.started',
      'session.output',
      'session.ended',
      'session.updated',
      'usage.recorded',
      'repository.context.updated',
      'pr.review.updated',
    ]);

    off();
    bus.emit('session.started', { id: 's2' } as never);
    expect(events).toHaveLength(7);
  });

  it('does not stream internal session lifecycle or output events', () => {
    const bus = createEventBus<StreamEventMap>();
    const events: string[] = [];
    subscribeStream(bus, { send: (event) => events.push(event) });

    bus.emit('session.started', { id: 'hidden', scope: 'internal' } as never);
    bus.emit('session.output', {
      sessionId: 'hidden',
      scope: 'internal',
      event: { type: 'stdout', line: 'private' },
    });
    bus.emit('session.ended', { id: 'hidden', scope: 'internal' } as never);
    bus.emit('usage.recorded', { sessionId: 'hidden' } as never);

    expect(events).toEqual(['usage.recorded']);
  });
});
