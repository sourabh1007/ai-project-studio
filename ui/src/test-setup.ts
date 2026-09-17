import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

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
