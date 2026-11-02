import type { ProcessHandle } from '../provider/process-kernel/process-spawner.js';

/** A timeout requests termination; callers must retain admission until done acknowledges it. */
export async function boundedProcess(
  handle: ProcessHandle,
  timeoutMs: number,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { handle.kill(); resolve(null); }, timeoutMs);
  });
  try { return await Promise.race([handle.done, timeout]); }
  finally { clearTimeout(timer!); }
}

export async function boundedVersion(
  read: () => Promise<string | null>,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer!); }
}
