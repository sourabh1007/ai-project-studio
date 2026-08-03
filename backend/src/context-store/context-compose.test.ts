import { describe, expect, it } from 'vitest';
import { contextDefaults } from './config.js';
import { composeSharedContext } from './context-compose.js';

describe('composeSharedContext', () => {
  it('returns empty string when there are no layers', () => {
    expect(composeSharedContext([], contextDefaults)).toBe('');
  });

  it('skips layers with blank content and returns empty when all blank', () => {
    expect(
      composeSharedContext(
        [
          { scope: 'workspace', content: '   ' },
          { scope: 'feature', content: '' },
        ],
        contextDefaults,
      ),
    ).toBe('');
  });

  it('renders headed blocks for populated layers in order', () => {
    const out = composeSharedContext(
      [
        { scope: 'workspace', content: '- global rule' },
        { scope: 'repo', content: '' },
        { scope: 'feature', content: '- feature rule' },
      ],
      contextDefaults,
    );
    expect(out).toBe(
      [
        '## Shared Context',
        '',
        '### Workspace',
        '',
        '- global rule',
        '',
        '### Feature',
        '',
        '- feature rule',
      ].join('\n'),
    );
  });

  it('clamps each layer to the configured cap with an ellipsis', () => {
    const out = composeSharedContext(
      [{ scope: 'feature', content: 'x'.repeat(50) }],
      { ...contextDefaults, maxInjectCharsPerLayer: 10 },
    );
    expect(out).toBe('## Shared Context\n\n### Feature\n\nxxxxxxxxxx…');
  });
});
