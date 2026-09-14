import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Kills a process and, on Windows, also force-kills its full descendant
 * tree. `ChildProcess#kill()` only signals the immediate process — CLI
 * providers like `agency` spawn nested children (e.g. `copilot`), which
 * Node's kill() leaves running as orphans on Windows. Orphaned processes
 * accumulate silently across retries (observed: 100+ after a few hours of
 * a stuck retry loop) and eventually starve the whole machine, making the
 * backend appear to hang or time out. `taskkill /T /F` recursively kills
 * the whole tree. This always runs in addition to the direct kill (never
 * instead of it), so behavior is unchanged wherever a pid isn't available
 * (e.g. unit tests with a fake child process).
 */
export function killProcessTree(
  pid: number | undefined,
  kill: () => void,
  spawnTaskkill: typeof nodeSpawn = nodeSpawn,
): void {
  kill();
  if (process.platform !== 'win32' || typeof pid !== 'number') {
    return;
  }
  try {
    spawnTaskkill('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => {
      // Best-effort cleanup; ignore failures (e.g. process already exited).
    });
  } catch {
    // Best-effort cleanup; ignore synchronous spawn failures too.
  }
}
