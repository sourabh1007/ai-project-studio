import type { SessionSpec } from '../provider-contract.js';
import { buildCopilotEnv } from '../copilot-adapter/copilot-env-mapper.js';
import { win32 } from 'node:path';
import { resolveExecutable } from '../../terminal/executable-resolver.js';

export function resolveAgencyNativeCopilot(
  pathEnv: string,
  deps: {
    isWindows: boolean;
    fileExists: (path: string) => boolean;
    nativeFromNpm?: (shim: string) => string | null;
  },
): string | null {
  if (!deps.isWindows) return null;
  // The VS Code launcher can rediscover npm's .cmd and reject its argument
  // values. Agency needs the actual native CLI, not another forwarding shim.
  const searchPath = pathEnv.split(';').filter((directory) =>
    win32.basename(directory).toLowerCase() !== 'copilot-shim').join(';');
  const executable = resolveExecutable('copilot.exe', {
    ...deps, pathEnv: searchPath, pathExt: '',
  });
  if (executable !== 'copilot.exe') return executable;
  for (const directory of searchPath.split(';').filter(Boolean)) {
    const shim = win32.join(directory, 'copilot.cmd');
    if (!deps.fileExists(shim)) continue;
    const native = deps.nativeFromNpm?.(shim);
    if (native) return native;
  }
  return null;
}

/**
 * Produces the environment for an Agency session. Agency forwards to the same
 * underlying Copilot CLI, so per-session OpenTelemetry usage is captured with
 * the identical COPILOT_OTEL_* + resource-attribute mapping.
 */
export function buildAgencyEnv(
  spec: SessionSpec,
  baseEnv: Record<string, string | undefined>,
  nativeCopilot?: string | null,
): Record<string, string> {
  const env = buildCopilotEnv(spec, baseEnv);
  if (nativeCopilot) {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = [win32.dirname(nativeCopilot), env[pathKey]].filter(Boolean).join(';');
  }
  return env;
}
