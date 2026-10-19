import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)![1];

it.each(['full', 'reduced', 'off'])('restores Clarity and %s motion before first paint', (motion) => {
  const attributes = new Map<string, string>();
  const window = {
    desktop: { getAppearance: () => ({ values: {
      'cw-theme': 'dark', 'cw-ui-prefs': JSON.stringify({ appearance: 'clarity', motion }),
    } }) },
    localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: false }),
  };
  const document = { documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) } };
  new Function('window', 'document', bootstrap)(window, document);
  expect(attributes.get('data-appearance')).toBe('clarity');
  expect(attributes.get('data-theme')).toBe('dark');
  expect(attributes.get('data-motion')).toBe(motion);
});
