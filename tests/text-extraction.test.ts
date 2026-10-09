import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasResponseTextLength,
  isPlaceholderArtifactText,
  normalizeResponseTextLengthText,
  MIN_FALLBACK_RESPONSE_TEXT_LENGTH,
  MIN_RESPONSE_TEXT_LENGTH,
} from '../src/browser/response-text.js';
import { restoreMarkdownTokenPayloads } from '../src/browser/markdown-restoration.js';

/**
 * 文本后处理测试。
 *
 * 两件事都是为了同一类失败：**抓到的东西看起来像正文，其实不是**。
 *   - response-text：把占位残渣（弹窗遮挡时页面留下的 `[](/)\n\n-`）挡在外面，
 *     同时**不能**误杀 `[]`、`-`、`{}`、`OK` 这类合法短答案。
 *   - markdown-restoration：把被 turndown 拆散的数学公式 token 还原。
 *
 * 两边都是"宁可漏也不可错"的取舍，所以放在一起看更清楚边界在哪。
 */

// ===== 占位残渣与长度门槛 =====

test('rejects the exact artifact observed when a modal blocks the conversation', () => {
  // 2026-10 实测：Grok 弹年龄确认门，页面没渲染对话区，兜底 innerText
  // 从侧边栏抓到了这个，桥却以 HTTP 200 + finish_reason=stop 返回了它。
  assert.equal(isPlaceholderArtifactText('[](/)\n\n-'), true);
});

test('rejects whitespace-only text', () => {
  assert.equal(isPlaceholderArtifactText(''), true);
  assert.equal(isPlaceholderArtifactText('   \n\t '), true);
});

test('keeps legitimate empty-list answers', () => {
  // 用户明确提出的反例：问"把列表里某些项筛出来"，筛不到时模型会回 []。
  // 这类文本不含空目标 Markdown 链接，必须放行。
  assert.equal(isPlaceholderArtifactText('[]'), false);
  assert.equal(isPlaceholderArtifactText('[ ]'), false);
  assert.equal(isPlaceholderArtifactText('{}'), false);
  assert.equal(isPlaceholderArtifactText('null'), false);
});

test('keeps legitimate punctuation-only and short answers', () => {
  assert.equal(isPlaceholderArtifactText('-'), false);
  assert.equal(isPlaceholderArtifactText('*'), false);
  assert.equal(isPlaceholderArtifactText('...'), false);
  assert.equal(isPlaceholderArtifactText('收到。'), false);
  assert.equal(isPlaceholderArtifactText('OK'), false);
  assert.equal(isPlaceholderArtifactText('3 个'), false);
  assert.equal(isPlaceholderArtifactText('无符合条件的结果'), false);
});

test('keeps answers that merely contain a broken link alongside real content', () => {
  assert.equal(isPlaceholderArtifactText('[](/) 实际内容在这里'), false);
  assert.equal(isPlaceholderArtifactText('详见 [](/) 里的说明'), false);
  assert.equal(isPlaceholderArtifactText('see [text]() for details'), false);
});

test('keeps normal markdown links and images', () => {
  assert.equal(isPlaceholderArtifactText('[文档](https://example.com)'), false);
  assert.equal(isPlaceholderArtifactText('![图](https://example.com/a.png)'), false);
});

test('rejects an artifact that also swallows a stray image', () => {
  assert.equal(isPlaceholderArtifactText('![](  )\n\n|'), true);
});

test('hasResponseTextLength folds whitespace before measuring', () => {
  assert.equal(normalizeResponseTextLengthText('  a\n\nb  '), 'a b');
  assert.equal(hasResponseTextLength('   \n  ', MIN_RESPONSE_TEXT_LENGTH), false);
  assert.equal(hasResponseTextLength('收到', MIN_RESPONSE_TEXT_LENGTH), false);
  assert.equal(hasResponseTextLength('[]', MIN_RESPONSE_TEXT_LENGTH), false);
});

test('the fallback threshold accepts the short answers the primary threshold drops', () => {
  // 这就是长度门槛必须分两档的原因：主门槛会否掉合法短答案，
  // 兜底门槛把它们救回来。
  for (const shortAnswer of ['[]', '收到', '3', 'OK', '-']) {
    assert.equal(hasResponseTextLength(shortAnswer, MIN_RESPONSE_TEXT_LENGTH), false);
    assert.equal(hasResponseTextLength(shortAnswer, MIN_FALLBACK_RESPONSE_TEXT_LENGTH), true);
  }
});

test('the primary threshold still rejects in-flight streaming fragments', () => {
  assert.equal(hasResponseTextLength('好', MIN_RESPONSE_TEXT_LENGTH), false);
  assert.equal(hasResponseTextLength('正在生成', MIN_RESPONSE_TEXT_LENGTH), false);
  assert.equal(hasResponseTextLength('正在生成回答，请稍候', MIN_RESPONSE_TEXT_LENGTH), true);
});

// ===== Markdown 还原 =====

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
