import { describe, it, expect } from 'vitest';
import { createTerminalDelivery } from './terminal-delivery.js';
import type { ClientMessage, ServerMessage, TerminalState } from './terminal-protocol.js';

function fixture() {
  const sent: ClientMessage[] = [];
  const statuses: Array<{ state: TerminalState; notice: string }> = [];
  let throws = false;
  const delivery = createTerminalDelivery({
    send: (message) => { if (throws) throw new Error('send failed'); sent.push(message); },
    status: (state, notice) => statuses.push({ state, notice }),
  });
  const state = (state: TerminalState, generation = 1, inputLimit = 16) =>
    delivery.receive({ type: 'state', version: 2, state, generation, inputLimit });
  const ack = (seq: number, outcome: 'written' | 'rejected' | 'uncertain' = 'written', generation = 1) =>
    delivery.receive({ type: 'ack', seq, generation, outcome, reason: 'reason' });
  return { delivery, sent, statuses, state, ack, failSend: () => { throws = true; } };
}

describe('terminal input delivery', () => {
  it('buffers FIRST and SECOND once before ready, sends initial geometry and bounds outstanding bytes until ack', () => {
    const f = fixture();
    f.delivery.offer(''); f.delivery.offer('FIRST'); f.delivery.offer('SECOND');
    f.delivery.resize(80, 24); f.delivery.resize(100, 30);
    f.state('bootstrapping');
    expect(f.sent).toEqual([]);
    f.state('ready');
    expect(f.sent).toEqual([
      { type: 'resize', cols: 100, rows: 30, generation: 1 },
      { type: 'input', data: 'FIRST', generation: 1, seq: 1 },
      { type: 'input', data: 'SECOND', generation: 1, seq: 2 },
    ]);
    f.state('ready'); f.delivery.resize(100, 30);
    expect(f.sent).toHaveLength(3);
    f.ack(1); f.ack(2); f.ack(99);
    f.delivery.offer('another');
    expect(f.sent).toHaveLength(4);
  });
  it('rejects oversized paste in full and blocks Enter without replaying any queued prefix', () => {
    const f = fixture();
    f.state('bootstrapping', 1, 4);
    f.delivery.offer('a'); f.delivery.offer('😀'); f.delivery.offer('\r');
    f.state('ready');
    expect(f.sent).toEqual([]);
    expect(f.statuses.at(-1)).toEqual(expect.objectContaining({ state: 'failed' }));
    expect(f.statuses.at(-1)?.notice).toContain('Paste rejected in full');
    expect(f.statuses.at(-1)?.notice).toContain('1 unsent');
  });
  it('rejects a queued transaction if the server advertises a smaller limit', () => {
    const f = fixture();
    f.delivery.offer('long text');
    f.state('ready', 1, 2);
    expect(f.sent).toEqual([]);
    expect(f.statuses.at(-1)?.notice).toContain('Server input limit');
  });
  it('discards unsent/uncertain data on loss, and never retransmits into another epoch', () => {
    const f = fixture();
    f.state('ready'); f.delivery.offer('executed?');
    f.delivery.disconnect(true);
    expect(f.statuses.at(-1)?.notice).toContain('1 unacknowledged');
    f.delivery.offer('not writable');
    f.state('connecting', 0); f.delivery.offer('new');
    f.state('ready', 2);
    expect(f.sent).toEqual([
      { type: 'input', data: 'executed?', generation: 1, seq: 1 },
      { type: 'input', data: 'new', generation: 2, seq: 1 },
    ]);
    f.ack(1, 'written', 1); // Old-epoch ack cannot release new-epoch ownership.
    f.state('bootstrapping', 3);
    expect(f.statuses.at(-1)?.notice).toContain('generation changed');
    f.state('ready', 3);
    expect(f.sent).toHaveLength(2);
  });
  it('reports closed/failed/reconnecting states, including rejection when nothing was queued', () => {
    for (const state of ['closed', 'failed', 'reconnecting'] as const) {
      const f = fixture();
      f.state(state); f.delivery.offer('not sent');
      expect(f.sent).toEqual([]);
      expect(f.statuses.at(-1)?.notice).toContain('not writable');
    }
    const f = fixture(); f.delivery.disconnect(false);
    expect(f.statuses.at(-1)?.state).toBe('failed');
  });
  it('stops on rejected/uncertain acknowledgements or send exceptions, without retry', () => {
    for (const outcome of ['rejected', 'uncertain'] as const) {
      const f = fixture();
      f.state('ready'); f.delivery.offer('X'); f.ack(1, outcome);
      expect(f.statuses.at(-1)?.notice).toContain(outcome);
      f.delivery.offer('\r'); expect(f.sent).toHaveLength(1);
    }
    const f = fixture(); f.state('ready'); f.failSend(); f.delivery.offer('X');
    expect(f.statuses.at(-1)?.notice).toContain('1 unacknowledged');
    const resize = fixture(); resize.failSend(); resize.delivery.resize(80, 24); resize.state('ready');
    expect(resize.statuses.at(-1)?.notice).toContain('Connection write failed');
    f.delivery.receive({ type: 'output', data: '' } as ServerMessage);
  });
});
