/**
 * Pure, dependency-free accounting core for the MCP launch proxy. It observes
 * the two halves of a server's stdio transport — client→server on stdin and
 * server→client on stdout — and derives real, measured usage:
 *
 *  - `inputBytes` / `outputBytes`: exact byte counts moved in each direction.
 *  - `calls`: number of `tools/call` JSON-RPC requests from the client.
 *  - `durationMs`: summed request→response wall-clock latency of those calls.
 *
 * MCP's stdio transport frames messages as newline-delimited JSON (one JSON
 * value per line, no embedded newlines), so the meter buffers partial lines and
 * parses each completed line. Non-JSON or unexpected lines are counted toward
 * bytes but otherwise ignored — the meter never throws, so it can never break
 * the proxied stream.
 */
export interface McpMeterSnapshot {
  calls: number;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
}

interface JsonRpcMessage {
  method?: unknown;
  id?: unknown;
}

/** Normalizes a JSON-RPC id to a stable map key, or null when absent. */
function idKey(id: unknown): string | null {
  if (typeof id === 'string') {
    return `s:${id}`;
  }
  if (typeof id === 'number') {
    return `n:${id}`;
  }
  return null;
}

export interface McpMeter {
  /** Account for a chunk flowing client→server (stdin). */
  onClientData(chunk: Buffer): void;
  /** Account for a chunk flowing server→client (stdout). */
  onServerData(chunk: Buffer): void;
  /** Current measured totals. */
  snapshot(): McpMeterSnapshot;
}

export function createMcpMeter(now: () => number = () => Date.now()): McpMeter {
  let calls = 0;
  let inputBytes = 0;
  let outputBytes = 0;
  let durationMs = 0;
  // Pending `tools/call` request ids → the time we saw the request, so the
  // matching response can be attributed a real latency.
  const pending = new Map<string, number>();
  let clientBuffer = '';
  let serverBuffer = '';

  function parseLines(buffer: string, onMessage: (msg: JsonRpcMessage) => void): string {
    let rest = buffer;
    let newline = rest.indexOf('\n');
    while (newline !== -1) {
      const line = rest.slice(0, newline).trim();
      rest = rest.slice(newline + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (parsed && typeof parsed === 'object') {
            onMessage(parsed as JsonRpcMessage);
          }
        } catch {
          // Not a complete JSON value on this line; ignore for accounting.
        }
      }
      newline = rest.indexOf('\n');
    }
    return rest;
  }

  return {
    onClientData(chunk) {
      inputBytes += chunk.length;
      clientBuffer = parseLines(clientBuffer + chunk.toString('utf8'), (msg) => {
        if (msg.method === 'tools/call') {
          calls += 1;
          const key = idKey(msg.id);
          if (key !== null) {
            pending.set(key, now());
          }
        }
      });
    },
    onServerData(chunk) {
      outputBytes += chunk.length;
      serverBuffer = parseLines(serverBuffer + chunk.toString('utf8'), (msg) => {
        const key = idKey(msg.id);
        if (key !== null && pending.has(key)) {
          durationMs += Math.max(0, now() - (pending.get(key) as number));
          pending.delete(key);
        }
      });
    },
    snapshot() {
      return { calls, inputBytes, outputBytes, durationMs };
    },
  };
}
