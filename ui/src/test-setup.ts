import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// Node's native storage can shadow jsdom's origin-scoped browser storage.
const browser = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom.window;
for (const key of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: browser[key],
  });
}

// Explorer expansion (and other UI preferences) persist to localStorage. Clear
// it between tests so persisted state from one test can never leak into the
// next and flip a default-collapsed assertion.
afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* jsdom without storage; nothing to clear */
  }
});
