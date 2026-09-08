import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const backendUrl = process.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:4319';

export default defineConfig({
  base: './',
  plugins: [react()],
  // The change-graph layout runs in a module worker (`new Worker(url, { type:
  // 'module' })`). Vite's default `worker.format` is 'iife', which emits a
  // classic script that a module worker can fail to load in the packaged build
  // — freezing every layout recompute (expand/zoom). Emit an ES worker so the
  // built file matches how it's instantiated.
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        // Keep shared React code separate so loading the app does not also
        // pull in the charts vendor chunk, and each chunk stays below 500 kB.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          const modulePath = id.replaceAll('\\', '/');
          if (modulePath.includes('commonjsHelpers')) return 'vendor-runtime';
          if (/\/node_modules\/(react|react-dom|react-is|scheduler|use-sync-external-store)\//.test(modulePath)) {
            return 'react';
          }
          if (/\/node_modules\/recharts\//.test(modulePath)) return 'recharts';
          if (/\/node_modules\/@xterm\//.test(modulePath)) return 'xterm';
        },
      },
    },
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      '/api': { target: backendUrl, changeOrigin: true, ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts'],
      exclude: ['src/**/*.test.*'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
