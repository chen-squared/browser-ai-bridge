import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getProvider } from '../src/providers/registry.js';

/**
 * 注册表里的 provider 配置。这些断言盯的都是**实测得来的页面结构**，
 * 页面一改版就可能失效——写下来是为了让改动必须经过一次有意识的确认，
 * 而不是悄悄退化成"抓错块"却没人发现。
 */
describe('provider 配置', () => {
  /**
   * Grok 曾经"返回提示词本身"，而且是反复出现的稳定症状，不是偶发。
   *
   * 根因：Grok 给**用户提问和 AI 回复共用同一个 class** `.response-content-markdown`，
   * 两者唯一区别是用户气泡额外带 `data-testid="user-message"` 和
   * `bg-surface-user-bubble`。原实现"取最后一个可见块"，于是取到的往往是
   * 用户自己刚发出去的那句话。
   *
   * 真流捕获会掩盖这个问题（流优先于 DOM），一旦流捕获失败退回 DOM 就暴露。
   */
  describe('grok 的用户消息排除规则', () => {
    it('配了排除规则，且能覆盖实测到的两个用户消息标记', () => {
      const exclude = getProvider('grok').excludeUserMessageSelectors;
      assert.ok(exclude, 'grok 必须配 excludeUserMessageSelectors');
      assert.ok(
        exclude.includes('[data-testid="user-message"]'),
        '实测用户消息带 data-testid="user-message"',
      );
      assert.ok(
        exclude.includes('.bg-surface-user-bubble'),
        '实测用户气泡还有 bg-surface-user-bubble 这个 class',
      );
    });

    it('responseSelectors 里仍保留 .response-content-markdown——它是唯一能用的那条', () => {
      // 实测 [data-testid="conversation-item-assistant"] 一个都匹配不到，
      // 已从 responseSelectors 删除。这里守住"不要再把它加回来"。
      const selectors = getProvider('grok').responseSelectors;
      assert.ok(
        selectors.includes('.response-content-markdown'),
        '这是实测唯一命中 AI 回复的选择器，必须保留',
      );
      assert.ok(
        !selectors.includes('[data-testid="conversation-item-assistant"]'),
        '这条实测完全匹配不到，不能作为响应选择器',
      );
    });

    it('其余 provider 没有共用 class，不该被无差别排除', () => {
      // 审计过 chatgpt / claude / qwen / deepseek：它们的用户消息都不带
      // data-message-author-role="assistant" 之类的响应标记，误加排除规则会误伤。
      for (const id of ['chatgpt', 'claude', 'qwen', 'deepseek'] as const) {
        assert.equal(
          getProvider(id).excludeUserMessageSelectors,
          undefined,
          `${id} 不需要排除用户消息`,
        );
      }
    });
  });

  describe('真流捕获配置', () => {
    it('五家已接真流，gemini 仍是 DOM 兜底', () => {
      // gemini 的端点已定位、body 也能取到，但账号配额耗尽导致拿不到真实样本，
      // 归约器无从验证，所以故意不接。见 registry.ts 里的注释。
      for (const id of ['chatgpt', 'claude', 'deepseek', 'grok', 'qwen'] as const) {
        assert.ok(getProvider(id).streamCapture, `${id} 应当已配真流捕获`);
      }
      assert.equal(
        getProvider('gemini').streamCapture,
        undefined,
        'gemini 尚未验证，不该挂一个没跑过的归约器',
      );
    });

    it('每个 provider 用各自的归约器，不共用', () => {
      // 共用归约器是这套设计最容易犯的错：协议不同，套用错就是静默抓错内容。
      const used = ['chatgpt', 'claude', 'deepseek', 'grok', 'qwen'].map(
        (id) => getProvider(id as 'chatgpt').streamCapture?.reducer,
      );
      assert.equal(new Set(used).size, used.length, `归约器不应重复：${used.join(', ')}`);
    });

    it('claude 走 JSON 而不是 SSE——它的 SSE 中文编码是坏的', () => {
      const capture = getProvider('claude').streamCapture;
      assert.equal(capture?.transport, 'http');
      assert.equal(capture?.reducer, 'claude');
    });

    it('grok 走 WebSocket，它是唯一能拿到真首字延迟的', () => {
      assert.equal(getProvider('grok').streamCapture?.transport, 'websocket');
    });
  });

  describe('会话标识', () => {
    it('每家都配了会话 id 的提取规则', () => {
      for (const id of ['chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'gemini'] as const) {
        assert.ok(
          getProvider(id).conversationUrlPattern,
          `${id} 缺 conversationUrlPattern，多轮会话无法定位`,
        );
      }
    });

    it('只有 claude 需要 newChatUrl', () => {
      // 实测其余五家的入口 URL 本身就是新会话页，只有 Claude 不是。
      for (const id of ['chatgpt', 'deepseek', 'grok', 'qwen', 'gemini'] as const) {
        assert.equal(getProvider(id).newChatUrl, undefined, `${id} 不需要 newChatUrl`);
      }
      assert.equal(getProvider('claude').newChatUrl, 'https://claude.ai/new');
    });
  });
});
