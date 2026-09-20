import { describe, it, expect } from 'vitest';
import { createMcpMeter } from './mcp-proxy-meter.js';

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('createMcpMeter', () => {
  it('counts bytes in each direction', () => {
    const meter = createMcpMeter();
    meter.onClientData(buf('hello\n'));
    meter.onServerData(buf('world!\n'));
    const snap = meter.snapshot();
    expect(snap.inputBytes).toBe(6);
    expect(snap.outputBytes).toBe(7);
  });

  it('counts only tools/call requests', () => {
    const meter = createMcpMeter();
    meter.onClientData(buf(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n'));
    meter.onClientData(buf(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call' }) + '\n'));
    meter.onClientData(buf(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call' }) + '\n'));
    expect(meter.snapshot().calls).toBe(2);
  });

  it('measures request→response latency for calls only', () => {
    let t = 1000;
    const meter = createMcpMeter(() => t);
    meter.onClientData(buf(JSON.stringify({ id: 1, method: 'tools/call' }) + '\n'));
    t = 1050;
    meter.onServerData(buf(JSON.stringify({ id: 1, result: {} }) + '\n'));
    // A response with no matching pending call adds nothing.
    meter.onServerData(buf(JSON.stringify({ id: 99, result: {} }) + '\n'));
    expect(meter.snapshot().durationMs).toBe(50);
  });

  it('handles string ids and multiple concurrent calls', () => {
    let t = 0;
    const meter = createMcpMeter(() => t);
    meter.onClientData(buf(JSON.stringify({ id: 'a', method: 'tools/call' }) + '\n'));
    t = 10;
    meter.onClientData(buf(JSON.stringify({ id: 'b', method: 'tools/call' }) + '\n'));
    t = 25;
    meter.onServerData(buf(JSON.stringify({ id: 'a', result: {} }) + '\n'));
    t = 40;
    meter.onServerData(buf(JSON.stringify({ id: 'b', result: {} }) + '\n'));
    expect(meter.snapshot().durationMs).toBe(25 + 30);
    expect(meter.snapshot().calls).toBe(2);
  });

  it('reassembles messages split across chunks', () => {
    const meter = createMcpMeter();
    const msg = JSON.stringify({ id: 7, method: 'tools/call' }) + '\n';
    meter.onClientData(buf(msg.slice(0, 5)));
    meter.onClientData(buf(msg.slice(5)));
    expect(meter.snapshot().calls).toBe(1);
  });

  it('counts an id-less tools/call but attributes no latency to it', () => {
    let t = 100;
    const meter = createMcpMeter(() => t);
    // A `tools/call` with no id (idKey -> null): counted, but never matched to a
    // response, so it contributes zero latency and no pending entry.
    meter.onClientData(buf(JSON.stringify({ method: 'tools/call' }) + '\n'));
    t = 500;
    // A response that also lacks an id must not match anything.
    meter.onServerData(buf(JSON.stringify({ result: {} }) + '\n'));
    expect(meter.snapshot().calls).toBe(1);
    expect(meter.snapshot().durationMs).toBe(0);
  });

  it('ignores non-JSON and non-object lines without throwing', () => {
    const meter = createMcpMeter();
    meter.onClientData(buf('not json\n'));
    meter.onServerData(buf('42\n'));
    meter.onClientData(buf('\n'));
    expect(meter.snapshot().calls).toBe(0);
    expect(meter.snapshot().durationMs).toBe(0);
  });
});
