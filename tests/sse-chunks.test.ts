import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CHUNK_CODE_POINTS,
  buildChatCompletionChunks,
  splitIntoChunks,
} from '../src/sse-chunks.ts';

test('splitIntoChunks rejoins into the exact original string', () => {
  const text = '这是一段用来测试切块逻辑的中文回答。'.repeat(20);
  assert.equal(splitIntoChunks(text).join(''), text);
});

test('splitIntoChunks never splits a surrogate pair', () => {
  // emoji 是代理对，按 UTF-16 码元切会劈成乱码
  const text = '已完成 🎉🚀 部署 🎯';
  for (const size of [1, 2, 3, 5, 7]) {
    const chunks = splitIntoChunks(text, size);
    assert.equal(chunks.join(''), text, `size=${size} 时拼回应与原文一致`);
    for (const chunk of chunks) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), `size=${size} 时不应以代理对高位结尾`);
    }
  }
});

test('splitIntoChunks handles CJK astral characters and empty input', () => {
  assert.equal(splitIntoChunks('', 10).length, 0);
  assert.deepEqual(splitIntoChunks('abc', 10), ['abc']);
  const astral = '𠮷野家'; // 3 个增补平面汉字，各占两个码元
  assert.equal(splitIntoChunks(astral, 1).join(''), astral);
});

test('splitIntoChunks clamps a nonsensical size instead of looping forever', () => {
  assert.deepEqual(splitIntoChunks('abc', 0), ['a', 'b', 'c']);
  assert.deepEqual(splitIntoChunks('abc', -5), ['a', 'b', 'c']);
});

test('buildChatCompletionChunks emits role first, content, then a stop chunk', () => {
  const chunks = buildChatCompletionChunks({
    id: 'chatcmpl-1',
    created: 1,
    model: 'deepseek-web',
    provider: 'deepseek',
    conversationId: 'conv-1',
    url: 'https://chat.deepseek.com/a/chat/s/conv-1',
    content: '你好，世界。'.repeat(30),
    chunkSize: 10,
  });

  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks[0].choices[0].finish_reason, null);
  assert.equal(chunks.at(-1)?.choices[0].finish_reason, 'stop');
  assert.ok(chunks.at(-1)?.usage);

  // 每块都带 OpenAI 要求的信封字段
  for (const chunk of chunks) {
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.id, 'chatcmpl-1');
    assert.equal(chunk.model, 'deepseek-web');
    assert.equal(chunk.choices[0].index, 0);
  }

  // 拼起来的正文必须与原文完全一致
  const rebuilt = chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join('');
  assert.equal(rebuilt, '你好，世界。'.repeat(30));
});

test('buildChatCompletionChunks puts reasoning before content', () => {
  const chunks = buildChatCompletionChunks({
    id: 'x',
    created: 0,
    model: 'm',
    content: '最终答案',
    reasoningContent: '思考过程一二三',
    chunkSize: 100,
  });

  const reasoningIndex = chunks.findIndex((c) => c.choices[0].delta.reasoning_content);
  const contentIndex = chunks.findIndex((c) => c.choices[0].delta.content);
  assert.ok(reasoningIndex > 0);
  assert.ok(contentIndex > reasoningIndex);
  assert.equal(
    chunks.map((c) => c.choices[0].delta.reasoning_content ?? '').join(''),
    '思考过程一二三',
  );
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? '').join(''), '最终答案');
});

test('buildChatCompletionChunks still emits a valid sequence for empty content', () => {
  const chunks = buildChatCompletionChunks({
    id: 'x',
    created: 0,
    model: 'm',
    content: '',
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks[1].choices[0].finish_reason, 'stop');
});

test('buildChatCompletionChunks does not invent a conversationId when none is known', () => {
  const chunks = buildChatCompletionChunks({
    id: 'x',
    created: 0,
    model: 'm',
    content: 'hi',
  });
  assert.equal('conversationId' in chunks[0], false);
});

test('the default chunk size is sane for CJK text', () => {
  assert.ok(DEFAULT_CHUNK_CODE_POINTS >= 20);
  const text = '答'.repeat(200);
  assert.ok(splitIntoChunks(text).length >= 3);
});
