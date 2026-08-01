/**
 * Same-origin guard for the interactive terminal WebSocket.
 *
 * WebSockets are exempt from the browser same-origin policy: any web page the
 * user happens to visit can open `ws://127.0.0.1:<port>/…` and, if it reaches a
 * live session, inject keystrokes into a CLI running with elevated tool access.
 * The desktop app only ever connects from its own localhost origin (the
 * packaged `http://127.0.0.1:<port>` page or the dev Vite server), so we reject
 * any cross-site browser Origin.
 *
 * Non-browser clients (integration tests, tooling) do not send an `Origin`
 * header at all; those are allowed, since the threat model is a hostile *web
 * page* — only browsers attach an Origin.
 */
export function isAllowedTerminalOrigin(origin: string | undefined | null): boolean {
  // No Origin header → not a browser-initiated cross-site request.
  if (!origin) {
    return true;
  }
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // Malformed or opaque origin (e.g. the literal string "null" that
    // sandboxed/file pages send) — reject.
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}
