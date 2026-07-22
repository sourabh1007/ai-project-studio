import { describe, it, expect } from 'vitest';
import { createEventBus } from './event-bus.js';

interface Events extends Record<string, unknown> {
  ping: { n: number };
  other: string;
}

describe('event-bus', () => {
  it('delivers events to subscribers', () => {
    const bus = createEventBus<Events>();
    const seen: number[] = [];
    bus.on('ping', (p) => seen.push(p.n));
    bus.emit('ping', { n: 1 });
    bus.emit('ping', { n: 2 });
    expect(seen).toEqual([1, 2]);
  });

  it('supports multiple handlers and reports handler count', () => {
    const bus = createEventBus<Events>();
    let a = 0;
    let b = 0;
    bus.on('ping', () => (a += 1));
    bus.on('ping', () => (b += 1));
    expect(bus.handlerCount('ping')).toBe(2);
    bus.emit('ping', { n: 0 });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('unsubscribe stops delivery', () => {
    const bus = createEventBus<Events>();
    let count = 0;
    const off = bus.on('ping', () => (count += 1));
    bus.emit('ping', { n: 0 });
    off();
    bus.emit('ping', { n: 0 });
    expect(count).toBe(1);
    expect(bus.handlerCount('ping')).toBe(0);
  });

  it('emitting an event with no handlers is a no-op', () => {
    const bus = createEventBus<Events>();
    expect(() => bus.emit('other', 'x')).not.toThrow();
    expect(bus.handlerCount('other')).toBe(0);
  });
});
