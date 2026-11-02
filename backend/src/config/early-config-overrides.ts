import type { ConfigSource } from './config-contract.js';
import type { ConfigOverrideRecord, ConfigOverrideStore } from './config-override-store.js';

export const EARLY_CONFIG_NAMESPACES = ['git', 'githubCli', 'desktopRuntime'] as const;

/** Per-module files are the sole persisted owner for settings needed before Node starts. */
export function createEarlyConfigOverrides(
  fallback: ConfigOverrideStore,
  files: ReadonlyMap<string, ConfigOverrideStore>,
): ConfigOverrideStore {
  const owner = (namespace: string) => files.get(namespace) ?? fallback;
  return {
    all: () => [
      ...fallback.all().filter((record) => !files.has(record.namespace)),
      ...[...files.values()].flatMap((store) => store.all()),
    ],
    get: (namespace) => owner(namespace).get(namespace),
    set: (record: ConfigOverrideRecord) => owner(record.namespace).set(record),
    delete: (namespace) => owner(namespace).delete(namespace),
  };
}

export function legacyExecutableSource(env: Record<string, string | undefined>): ConfigSource {
  const data: Record<string, unknown> = {};
  if (env.CW_GIT_BIN) data.git = { executable: env.CW_GIT_BIN };
  if (env.CW_GH_BIN) data.githubCli = { executable: env.CW_GH_BIN };
  const node = env.CW_NODE_BIN_OVERRIDE ?? env.CW_NODE_BIN;
  if (node) data.desktopRuntime = { nodeExecutable: node };
  return { origin: 'legacy executable overrides', data };
}
