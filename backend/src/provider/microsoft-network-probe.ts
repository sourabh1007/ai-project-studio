/**
 * Thin IO adapter that probes reachability of the Microsoft 1ES install endpoint
 * (the same `aka.ms/InstallTool` used to install Agency). Used only as a weak,
 * best-effort fallback signal for deciding the default provider; the strong
 * signals (explicit override, corp-domain env vars) are pure and fully tested in
 * `network-environment.ts`. Excluded from unit coverage like other IO adapters.
 *
 * Returns `true` when the endpoint is reachable, `false` on a network error, and
 * is bounded by a short timeout so startup never blocks on a slow network.
 */
export async function probeMicrosoftInstallEndpoint(
  timeoutMs = 2000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://aka.ms/InstallTool.ps1', {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    // Any HTTP answer (even a 4xx) proves the endpoint resolved and responded.
    return response.status > 0 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
