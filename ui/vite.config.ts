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
        // Split the two heaviest dependency trees into their own chunks so the
        // main bundle isn't a single ~900 kB file; charts and the terminal are
        // only needed on specific views and can load/cache independently.
        manualChunks: {
          recharts: ['recharts'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
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
