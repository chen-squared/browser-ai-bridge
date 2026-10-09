import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractConversationId,
  isSameProviderHost,
  selectSessionsToEvict,
  type EvictableSession,
} from '../src/conversation-identity.js';
import { createSyncPlan, type NonSystemMessage } from '../src/session-sync.js';

/**
 * 会话与标签页生命周期测试。
 *
 * 两个源文件合在这里，因为它们回答同一个问题的两半：
 *   - session-sync：这一轮该发什么消息（复用还是续写）
 *   - conversation-identity：哪个标签页算"同一个会话"、什么时候该回收
 *
 * 判断"是不是同一个会话"是复用的唯一依据。这里必须谨慎——判错就会静默把消息
 * 写进用户正在看的另一个对话，而 bridge 自己的 transcript 仍以为一切正常。
 */

// ===== 会话身份与标签页回收 =====

// 下面这些 pattern 与 src/providers/registry.ts 中实际配置的一致
const PATTERNS = {
  chatgpt: '\\/c\\/([0-9a-f-]{20,})',
  gemini: '\\/app\\/([A-Za-z0-9_-]{6,})',
  claude: '\\/chat\\/([0-9a-f-]{20,})',
  grok: '\\/c\\/([0-9a-f-]{20,})',
  qwen: '\\/c\\/([0-9a-f-]{20,})',
  deepseek: '\\/a\\/chat\\/s\\/([0-9a-f-]{20,})',
} as const;

test('extractConversationId pulls the id out of real observed URLs', () => {
  // 这六个 URL 全部来自实测
  assert.equal(
    extractConversationId(
      'https://chatgpt.com/c/6ac67fd5-edd8-83ee-bf6f-2c1f7adc2e6d',
      PATTERNS.chatgpt,
    ),
    '6ac67fd5-edd8-83ee-bf6f-2c1f7adc2e6d',
  );
  assert.equal(
    extractConversationId('https://gemini.google.com/app/919ac3c7d20651f1', PATTERNS.gemini),
    '919ac3c7d20651f1',
  );
  assert.equal(
    extractConversationId(
      'https://claude.ai/chat/611457eb-7aaa-4657-9f12-ad208e6a3ac9',
      PATTERNS.claude,
    ),
    '611457eb-7aaa-4657-9f12-ad208e6a3ac9',
  );
  assert.equal(
    extractConversationId(
      'https://grok.com/c/9e6eeedf-2cea-4c34-b00d-a2c9f6aa1fd7?rid=a618bbe2',
      PATTERNS.grok,
    ),
    '9e6eeedf-2cea-4c34-b00d-a2c9f6aa1fd7',
  );
  assert.equal(
    extractConversationId(
      'https://chat.qwen.ai/c/ee6b7c9d-5fe5-46c7-968c-e69cd78d488b',
      PATTERNS.qwen,
    ),
    'ee6b7c9d-5fe5-46c7-968c-e69cd78d488b',
  );
  assert.equal(
    extractConversationId(
      'https://chat.deepseek.com/a/chat/s/5853ddf3-9a00-4fca-9601-31fe8e653b01',
      PATTERNS.deepseek,
    ),
    '5853ddf3-9a00-4fca-9601-31fe8e653b01',
  );
});

test('extractConversationId returns undefined on entry URLs that are not conversations', () => {
  assert.equal(extractConversationId('https://chatgpt.com/', PATTERNS.chatgpt), undefined);
  assert.equal(extractConversationId('https://gemini.google.com/app', PATTERNS.gemini), undefined);
  assert.equal(extractConversationId('https://claude.ai/new', PATTERNS.claude), undefined);
  assert.equal(extractConversationId('https://grok.com/', PATTERNS.grok), undefined);
  assert.equal(extractConversationId('https://chat.qwen.ai/', PATTERNS.qwen), undefined);
  assert.equal(extractConversationId('https://chat.deepseek.com/', PATTERNS.deepseek), undefined);
});

test('extractConversationId tolerates missing pattern and malformed pattern', () => {
  assert.equal(extractConversationId('https://chatgpt.com/c/abc', undefined), undefined);
  assert.equal(extractConversationId(undefined, PATTERNS.chatgpt), undefined);
  assert.equal(extractConversationId('', PATTERNS.chatgpt), undefined);
  // 配置写坏了不能把整个请求带崩，只是拿不到 id
  assert.equal(extractConversationId('https://chatgpt.com/c/abc', '([unclosed'), undefined);
});

test('isSameProviderHost accepts the provider host in any shape', () => {
  assert.equal(isSameProviderHost('https://chatgpt.com/c/abc', 'https://chatgpt.com/'), true);
  assert.equal(isSameProviderHost('https://chatgpt.com/', 'https://chatgpt.com/'), true);
  assert.equal(isSameProviderHost('http://chatgpt.com/', 'https://chatgpt.com/'), true);
  assert.equal(isSameProviderHost('https://CHATGPT.com/c/abc', 'https://chatgpt.com/'), true);
});

test('isSameProviderHost rejects pages the user navigated elsewhere', () => {
  // 用户在复用标签页里手动点到别处，必须被判定为不可复用
  assert.equal(isSameProviderHost('https://claude.ai/new', 'https://chatgpt.com/'), false);
  assert.equal(isSameProviderHost('https://example.com/', 'https://chatgpt.com/'), false);
  assert.equal(isSameProviderHost(undefined, 'https://chatgpt.com/'), false);
  assert.equal(isSameProviderHost('', 'https://chatgpt.com/'), false);
  // 相似域名不算同一个
  assert.equal(isSameProviderHost('https://notchatgpt.com/', 'https://chatgpt.com/'), false);
});

const NOW = 10_000_000;
const policy = { now: NOW, idleMs: 7_200_000, maxPerProvider: 3 };

function session(
  key: string,
  lastUsedAt: number,
  extra: Partial<EvictableSession> = {},
): EvictableSession {
  return {
    key,
    providerId: 'chatgpt',
    lastUsedAt,
    pageClosed: false,
    ...extra,
  };
}

test('eviction always drops entries whose page is already closed', () => {
  const evicted = selectSessionsToEvict(
    [session('a:1', NOW - 10, { pageClosed: true }), session('a:2', NOW - 10)],
    { ...policy, keepKey: 'a:2' },
  );
  assert.deepEqual(evicted, ['a:1']);
});

test('eviction drops idle sessions but never the one in use', () => {
  const evicted = selectSessionsToEvict(
    [
      session('a:stale', NOW - 7_200_001),
      session('a:active', NOW - 7_200_001),
      session('a:recent', NOW - 5),
    ],
    { ...policy, keepKey: 'a:active' },
  );
  // a:stale 闲置超时 → 回收；a:active 同样超时但正在使用 → 保留；a:recent 还很新
  assert.deepEqual(evicted, ['a:stale']);
});

test('eviction enforces the per-provider cap, oldest first', () => {
  const sessions = [
    session('a:1', NOW - 1000),
    session('a:2', NOW - 900),
    session('a:3', NOW - 800),
    session('a:4', NOW - 700),
    session('a:5', NOW - 600),
  ];
  const evicted = selectSessionsToEvict(sessions, policy);
  // 5 个、闲置都没超时、上限 3 → 淘汰最旧的 2 个
  assert.deepEqual(evicted.sort(), ['a:1', 'a:2']);
});

test('eviction counts per provider, not globally', () => {
  const sessions: EvictableSession[] = [
    session('chatgpt:1', NOW - 10, { providerId: 'chatgpt' }),
    session('chatgpt:2', NOW - 9, { providerId: 'chatgpt' }),
    session('claude:1', NOW - 8, { providerId: 'claude' }),
    session('grok:1', NOW - 7, { providerId: 'grok' }),
  ];
  const evicted = selectSessionsToEvict(sessions, policy);
  assert.deepEqual(evicted, []);
});

// ===== 同步计划 =====

const user = (content: string): NonSystemMessage => ({ role: 'user', content });
const assistant = (content: string): NonSystemMessage => ({ role: 'assistant', content });

/**
 * 按调用方给的规格驱动：u=用户轮，a=助手轮。
 * 复用一个标签页的条件是"请求带回来的历史是该标签页已有 transcript 的前缀"。
 */
function plan(cached: NonSystemMessage[], incoming: NonSystemMessage[]) {
  return createSyncPlan({
    system: undefined,
    currentMessages: incoming,
    currentContextMessages: incoming.slice(0, -1),
    latestUserMessage: incoming[incoming.length - 1],
    cachedMessages: cached,
    hasExistingSession: true,
    desiredPromptMode: 'latest-user',
    injectSystemOnFirstTurn: false,
    transcriptMode: 'raw',
  });
}

// ─────────────────────────────────────────────────────────────
// 调用方规格，逐条钉死
// ─────────────────────────────────────────────────────────────

test('规格① u1a1u2 复用"回复过 u1 的那个标签页"', () => {
  const result = plan([user('u1'), assistant('a1')], [user('u1'), assistant('a1'), user('u2')]);

  assert.equal(result.mode, 'append');
  // 只补发新增的 u2，已说过的不重复
  assert.deepEqual(result.effectiveMessages, [user('u2')]);
});

test('规格② u1a1u2a2u3 复用"回复过 u2 的那个标签页"', () => {
  const cached = [user('u1'), assistant('a1'), user('u2'), assistant('a2')];
  const result = plan(cached, [...cached, user('u3')]);

  assert.equal(result.mode, 'append');
  assert.deepEqual(result.effectiveMessages, [user('u3')]);
});

test('规格③ u1 和 u2 不复用', () => {
  // 只带最新一句、没有历史的请求，前缀必然接不上 → 重开
  const first = plan([user('u1'), assistant('a1')], [user('u2')]);
  assert.equal(first.mode, 'rebuild');

  // 没有任何已有 transcript 时也走新建
  const fresh = createSyncPlan({
    system: undefined,
    currentMessages: [user('u1')],
    currentContextMessages: [],
    latestUserMessage: user('u1'),
    cachedMessages: [],
    hasExistingSession: false,
    desiredPromptMode: 'latest-user',
    injectSystemOnFirstTurn: false,
    transcriptMode: 'raw',
  });
  assert.equal(fresh.mode, 'fresh');
});

test('规格④ u1a1u2 与 u1a1u3 不复用同一标签页', () => {
  // 该标签页停在 u1a1u2（已回复过 u2）
  const result = plan(
    [user('u1'), assistant('a1'), user('u2')],
    [user('u1'), assistant('a1'), user('u3')],
  );

  assert.equal(result.mode, 'rebuild');
  assert.equal(result.debug.reason, 'context-diverged');
  // 分叉点就是 u2 / u3 所在的那一位
  assert.equal(result.debug.divergenceIndex, 2);
});

test('规格⑤ u1a2u2 不复用 u1a1', () => {
  const result = plan([user('u1'), assistant('a1')], [user('u1'), assistant('a2'), user('u2')]);

  assert.equal(result.mode, 'rebuild');
  // 分叉点是 a1 / a2 那一轮
  assert.equal(result.debug.divergenceIndex, 1);
});

// ─────────────────────────────────────────────────────────────
// 上面规格的真实用例：复用判定不该被空白差异误伤
// ─────────────────────────────────────────────────────────────

test('同一个 assistant 回答只有尾随空格差异时，仍然判定为可复用', () => {
  // bridge 存的是网页里实际产出的文本，调用方存的是自己那份副本。
  // 逐字节比较会因为一个尾随空格就误判成换话题。
  const result = plan(
    [user('u1'), assistant('a1  '), user('u2'), assistant('a2')],
    [user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3')],
  );

  assert.equal(result.mode, 'append');
  assert.deepEqual(result.effectiveMessages, [user('u3')]);
});

test('CRLF 与多余空行不应造成误判', () => {
  const result = plan(
    [user('u1'), assistant('a1\r\n\r\n\r\n  '), user('u2'), assistant('a2')],
    [user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3')],
  );

  assert.equal(result.mode, 'append');
});

test('内容真的不同则依然判定为换话题（归一化不会削弱分叉判定）', () => {
  const result = plan(
    [user('u1'), assistant('a1')],
    [user('u1'), assistant('a1 完全不同'), user('u2')],
  );

  assert.equal(result.mode, 'rebuild');
  assert.equal(result.debug.divergenceIndex, 1);
});

// ─────────────────────────────────────────────────────────────
// 其余既有行为不能因为这次改动而回退
// ─────────────────────────────────────────────────────────────

test('context-window 模式下上下文窗口滑动仍能复用', () => {
  const result = createSyncPlan({
    system: undefined,
    currentMessages: [user('u1'), assistant('a1'), user('u2'), assistant('a2')],
    currentContextMessages: [user('u1'), assistant('a1'), user('u2'), assistant('a2')],
    latestUserMessage: user('u3'),
    cachedMessages: [user('u1'), assistant('a1')],
    hasExistingSession: true,
    desiredPromptMode: 'latest-user',
    injectSystemOnFirstTurn: false,
    transcriptMode: 'context-window',
  });

  assert.equal(result.mode, 'append');
  assert.equal(result.debug.reason, 'context-window-append');
});

test('已有会话但 transcript 为空时仍然重开', () => {
  const result = plan([], [user('u1')]);
  assert.equal(result.mode, 'rebuild');
  assert.equal(result.debug.reason, 'empty-cache-with-existing-session');
});

test('无状态客户端仍会在 debug 里被标记出来，但不参与决策', () => {
  const result = plan([user('u1'), assistant('a1')], [user('u2')]);
  assert.equal(result.debug.statelessClient, true);
  // 关键：标记存在，但判定依然是"不复用"
  assert.equal(result.mode, 'rebuild');
});
