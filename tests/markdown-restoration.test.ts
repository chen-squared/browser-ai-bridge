import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreMarkdownTokenPayloads } from '../src/browser/markdown-restoration.ts';

test('pads isolated block tokens and trims extra blank lines', () => {
  const restored = restoreMarkdownTokenPayloads('before\nQWEN_TABLE\nafter', [
    { token: 'QWEN_TABLE', markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |' },
  ]);

  assert.equal(restored, 'before\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter');
});

test('keeps inline payloads inline when padding is disabled', () => {
  const restored = restoreMarkdownTokenPayloads(
    '结论：MATH_TOKEN。',
    [{ token: 'MATH_TOKEN', markdown: '$E=mc^2$', display: 'inline' }],
    {
      padIsolatedToken: (payload) => payload.display === 'block',
    },
  );

  assert.equal(restored, '结论：$E=mc^2$。');
});

test('pads only block math payloads when requested', () => {
  const restored = restoreMarkdownTokenPayloads(
    'intro\nMATH_BLOCK\noutro',
    [{ token: 'MATH_BLOCK', markdown: '$$\na^2+b^2=c^2\n$$', display: 'block' }],
    {
      padIsolatedToken: (payload) => payload.display === 'block',
    },
  );

  assert.equal(restored, 'intro\n\n$$\na^2+b^2=c^2\n$$\n\noutro');
});

test('ignores malformed payload entries', () => {
  const restored = restoreMarkdownTokenPayloads('TOKEN', [
    { token: 'TOKEN', markdown: 'ok' },
    { token: 123 as unknown as string, markdown: 'bad' },
    { token: 'BROKEN', markdown: null as unknown as string },
  ]);

  assert.equal(restored, 'ok');
});
