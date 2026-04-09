import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMessages } from '../src/prompt.ts';

// ── 错误场景 ──────────────────────────────────────────────────────────────────

test('throws when messages is empty array', () => {
  assert.throws(() => normalizeMessages([]), /messages 不能为空/);
});

test('throws when messages is not an array', () => {
  // @ts-expect-error intentional bad input
  assert.throws(() => normalizeMessages(null), /messages 不能为空/);
});

test('throws when all messages are system role', () => {
  assert.throws(
    () => normalizeMessages([{ role: 'system', content: 'be helpful' }]),
    /至少需要一条非 system 消息/,
  );
});

test('throws when there is no user message (only assistant)', () => {
  assert.throws(
    () =>
      normalizeMessages([
        { role: 'system', content: 'be helpful' },
        { role: 'assistant', content: 'hello' },
      ]),
    /至少需要一条 user 消息/,
  );
});

test('throws when all non-system messages have empty content', () => {
  // After trimming, the content is empty → filtered out → treated as "no non-system messages"
  assert.throws(
    () => normalizeMessages([{ role: 'user', content: '   ' }]),
    /至少需要一条非 system 消息/,
  );
});

// ── latestUserMessage ──────────────────────────────────────────────────────────

test('latestUserMessage is the last user message in the array', () => {
  const result = normalizeMessages([
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ]);
  assert.equal(result.latestUserMessage, 'second question');
});

test('latestUserMessage is the only user message when just one present', () => {
  const result = normalizeMessages([{ role: 'user', content: 'hello' }]);
  assert.equal(result.latestUserMessage, 'hello');
});

test('latestUserMessage is trimmed', () => {
  const result = normalizeMessages([{ role: 'user', content: '  hi  ' }]);
  assert.equal(result.latestUserMessage, 'hi');
});

// ── system prompt handling ────────────────────────────────────────────────────

test('single system message is exposed via result.system', () => {
  const result = normalizeMessages([
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(result.system, 'be helpful');
  assert.equal(result.hasSystem, true);
});

test('multiple system messages are joined with double newlines', () => {
  const result = normalizeMessages([
    { role: 'system', content: 'rule one' },
    { role: 'system', content: 'rule two' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(result.system, 'rule one\n\nrule two');
});

test('result.system is undefined when no system messages', () => {
  const result = normalizeMessages([{ role: 'user', content: 'hi' }]);
  assert.equal(result.system, undefined);
  assert.equal(result.hasSystem, false);
});

test('blank system messages are ignored', () => {
  const result = normalizeMessages([
    { role: 'system', content: '   ' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(result.system, undefined);
  assert.equal(result.hasSystem, false);
});

// ── trailingUserMessages ──────────────────────────────────────────────────────

test('trailingUserMessages contains all user messages in order', () => {
  const result = normalizeMessages([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ]);
  assert.equal(result.trailingUserMessages.length, 2);
  assert.equal(result.trailingUserMessages[0].content, 'q1');
  assert.equal(result.trailingUserMessages[1].content, 'q2');
});

test('trailingUserBlock joins user messages with double newlines', () => {
  const result = normalizeMessages([
    { role: 'user', content: 'alpha' },
    { role: 'user', content: 'beta' },
  ]);
  assert.equal(result.trailingUserBlock, 'alpha\n\nbeta');
});

test('trailingUserBlock prefixes messages that have a name', () => {
  const result = normalizeMessages([
    { role: 'user', content: 'hi', name: 'Alice' },
    { role: 'user', content: 'hey', name: 'Bob' },
  ]);
  assert.equal(result.trailingUserBlock, 'Alice: hi\n\nBob: hey');
});

// ── fullMessagesBlock ─────────────────────────────────────────────────────────

test('fullMessagesBlock uses role labels and separates messages with double newlines', () => {
  const result = normalizeMessages([
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'answer' },
  ]);
  assert.equal(result.fullMessagesBlock, 'user:\nquestion\n\nassistant:\nanswer');
});

test('fullMessagesBlock uses role:name label when name is present', () => {
  const result = normalizeMessages([{ role: 'user', content: 'hello', name: 'Alice' }]);
  assert.equal(result.fullMessagesBlock, 'user:Alice:\nhello');
});

// ── historyCount ──────────────────────────────────────────────────────────────

test('historyCount equals total non-system messages', () => {
  const result = normalizeMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
  ]);
  assert.equal(result.historyCount, 3);
});

// ── name field handling ───────────────────────────────────────────────────────

test('empty-string name is coerced to undefined', () => {
  const result = normalizeMessages([{ role: 'user', content: 'hi', name: '' }]);
  assert.equal(result.trailingUserMessages[0].name, undefined);
});

test('whitespace-only name is coerced to undefined', () => {
  const result = normalizeMessages([{ role: 'user', content: 'hi', name: '   ' }]);
  assert.equal(result.trailingUserMessages[0].name, undefined);
});
