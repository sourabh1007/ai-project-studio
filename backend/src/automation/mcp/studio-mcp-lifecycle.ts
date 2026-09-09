/**
 * Detects when this MCP server's parent process (the provider CLI that
 * spawned it over stdio, e.g. `copilot`/`agency`) has gone away, so the
 * server can exit instead of leaking forever.
 *
 * The MCP SDK's `StdioServerTransport` only listens for stdin `'data'`/
 * `'error'`; it never reacts to stdin ending. When a CLI session that owns
 * this process exits (normally, on timeout, or killed), Node closes the
 * write end of the pipe on Windows/POSIX alike, which fires stdin `'end'`
 * (and usually `'close'`) here — but with no listener, this process just
 * sits idle forever with nothing left to talk to. Multiplied across every
 * session ever opened, these zombies accumulate unboundedly (each holding
 * real memory) and starve the whole machine, which surfaces as the backend
 * becoming slow/unresponsive to unrelated requests.
 */
export interface ParentStdinWatchable {
  once(event: 'end' | 'close', cb: () => void): unknown;
}

/** Calls `onParentGone` the first time stdin signals its far end is closed. */
export function watchForParentExit(
  stdin: ParentStdinWatchable,
  onParentGone: () => void,
): void {
  let fired = false;
  const fire = (): void => {
    if (fired) {
      return;
    }
    fired = true;
    onParentGone();
  };
  stdin.once('end', fire);
  stdin.once('close', fire);
}
