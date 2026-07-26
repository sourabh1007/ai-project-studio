import { defineConfig } from 'vitest/config';

/**
 * `node:sqlite` is a newer Node builtin that this Vite version does not know
 * about. Route imports through a virtual shim that loads the real native
 * module via createRequire, bypassing Vite's builtin resolution.
 */
const NODE_SQLITE_SHIM = '\0node-sqlite-shim';
const externalizeNodeSqlite = {
  name: 'externalize-node-sqlite',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (id === 'node:sqlite' || id === 'sqlite') {
      return NODE_SQLITE_SHIM;
    }
    return null;
  },
  load(id: string) {
    if (id === NODE_SQLITE_SHIM) {
      return [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        "const sqlite = require('node:sqlite');",
        'export const DatabaseSync = sqlite.DatabaseSync;',
        'export const StatementSync = sqlite.StatementSync;',
        'export default sqlite;',
      ].join('\n');
    }
    return null;
  },
};

export default defineConfig({
  plugins: [externalizeNodeSqlite],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/**/index.ts',
        // IO/native adapters: exercised via e2e, not unit tests (like main.ts).
        'src/terminal/node-pty-spawner.ts',
        'src/terminal/terminal-ws-server.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
