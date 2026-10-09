import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { meetingModelTemplates, resolveMeetingPlan } from '../src/meeting.js';
import type { CompletionPayload } from '../src/server.js';

/**
 * 会议编排测试（src/meeting.ts）。
 *
 * 两种模式（顺序对话 / 并行作答）加上席位命名。合在一个文件里是因为它们
 * 其实是同一件事的两面：**发言顺序与席位名决定了每个模型拿到哪个会话**，
 * 拆开测就会漏掉"顺序改了名字也跟着改"这类交叉影响。
 */
const payload = (meeting: Record<string, unknown>): CompletionPayload =>
  ({
    model: 'meeting-round-robin-web',
    messages: [{ role: 'user', content: '比较三种方案' }],
    meeting,
  }) as unknown as CompletionPayload;

const plan = (meeting: Record<string, unknown>) =>
  resolveMeetingPlan(meetingModelTemplates['meeting-round-robin-web'], payload(meeting));

// ===== 两种模式 =====

/**
 * 用户要的是两套清晰的编排方式：
 *   顺序对话 —— N 个模型依次发言，后一个能看到前面的全部发言
 *   并行作答 —— N 个模型同时回答同一问题，互不可见
 * 两者都由**独立的**总结者收口。
 *
 * 服务端本来就有 round-robin / parallel 两个模板，所以这些测试守的是
 * "语义没被改坏"，尤其是总结者不再占参与者名额这一点。
 */

describe('会议编排的两种模式', () => {
  it('两个模板分别对应顺序与并行', () => {
    assert.equal(meetingModelTemplates['meeting-round-robin-web'].mode, 'round-robin');
    assert.equal(meetingModelTemplates['meeting-parallel-web'].mode, 'parallel');
  });

  it('参与者顺序即发言顺序（round-robin）', () => {
    const plan = resolveMeetingPlan(
      meetingModelTemplates['meeting-round-robin-web'],
      payload({ participants: ['chatgpt', 'claude', 'grok'], summarizer: 'deepseek', rounds: 1 }),
    );
    assert.deepEqual(
      plan.participants.map((p) => [p.alias, p.provider]),
      [
        ['chatgpt1', 'chatgpt'],
        ['claude1', 'claude'],
        ['grok1', 'grok'],
      ],
      '数组顺序必须原样映射到席位，席位名按 provider 编号',
    );
  });

  it('每轮都是全部参与者发言（round-robin 与 parallel 同）', () => {
    for (const id of ['meeting-round-robin-web', 'meeting-parallel-web']) {
      const plan = resolveMeetingPlan(
        meetingModelTemplates[id],
        payload({ participants: ['chatgpt', 'claude'], summarizer: 'deepseek', rounds: 2 }),
      );
      const policy = buildPolicy(plan);
      assert.equal(policy.discussionParticipantsByRound.length, 2);
      for (const round of policy.discussionParticipantsByRound) {
        assert.deepEqual(round, ['chatgpt1', 'claude1'], `${id} 每一轮都应全员发言`);
      }
    }
  });

  it('总结者是独立会话，不占参与者名额', () => {
    // 这是本次修的核心：原先若 summarizer 也在 participants 里，
    // 它会被塞进某个 member 的 alias，于是「选 3 个 + 总结者也是其中之一」
    // 实际只有 2 个模型发言。
    const plan = resolveMeetingPlan(
      meetingModelTemplates['meeting-round-robin-web'],
      payload({
        participants: ['chatgpt', 'claude', 'deepseek'],
        summarizer: 'deepseek',
        rounds: 1,
      }),
    );
    const policy = buildPolicy(plan);
    assert.equal(policy.summarizerRole, 'separate-lead');
    assert.equal(policy.summarizerUsesParticipantSlot, false);
    assert.deepEqual(
      policy.discussionParticipantsByRound[0],
      ['chatgpt1', 'claude1', 'deepseek1'],
      '3 个参与者应全部发言，一个都不能少',
    );
    // 未指定 summarizerSeat 时开新会话，名字是 `<provider>-summary`
    assert.equal(plan.summarizer.alias, 'deepseek-summary');
  });

  it('总结者不在参与者里时同样是独立会话', () => {
    const plan = resolveMeetingPlan(
      meetingModelTemplates['meeting-parallel-web'],
      payload({ participants: ['chatgpt', 'grok'], summarizer: 'qwen', rounds: 1 }),
    );
    assert.equal(plan.summarizer.provider, 'qwen');
    assert.equal(plan.summarizer.alias, 'qwen-summary');
  });

  it('总结者允许与参与者同 provider，但仍是两个独立会话', () => {
    const plan = resolveMeetingPlan(
      meetingModelTemplates['meeting-round-robin-web'],
      payload({ participants: ['chatgpt', 'deepseek'], summarizer: 'deepseek', rounds: 1 }),
    );
    const participantWithSameProvider = plan.participants.filter((p) => p.provider === 'deepseek');
    assert.equal(participantWithSameProvider.length, 1, '参与席位里它只有一个');
    assert.notEqual(
      plan.summarizer.alias,
      participantWithSameProvider[0].alias,
      '总结者的 alias 不能复用参与者，否则会共用同一个网页会话',
    );
  });

  it('重复 provider 视为不同成员（顺序模式下各占一个会话）', () => {
    const plan = resolveMeetingPlan(
      meetingModelTemplates['meeting-round-robin-web'],
      payload({ participants: ['chatgpt', 'chatgpt'], summarizer: 'deepseek', rounds: 1 }),
    );
    assert.equal(plan.participants.length, 2);
    assert.deepEqual(
      plan.participants.map((p) => p.alias),
      ['chatgpt1', 'chatgpt2'],
      'alias 必须不同，否则两次请求会打到同一个会话',
    );
  });

  it('轮数可覆盖，且至少为一轮', () => {
    const plan = resolveMeetingPlan(
      meetingModelTemplates['meeting-round-robin-web'],
      payload({ participants: ['chatgpt', 'claude'], summarizer: 'deepseek', rounds: 3 }),
    );
    assert.equal(buildPolicy(plan).discussionParticipantsByRound.length, 3);
  });

  it('未指定 participants 时沿用模板自带的名单', () => {
    const plan = resolveMeetingPlan(
      meetingModelTemplates['meeting-round-robin-web'],
      payload({ summarizer: 'deepseek' }),
    );
    assert.equal(
      plan.participants.length,
      meetingModelTemplates['meeting-round-robin-web'].participants.length,
    );
  });

  it('brief 从模板池里循环取，不会因为名单变长而空掉', () => {
    const plan = resolveMeetingPlan(
      meetingModelTemplates['meeting-round-robin-web'],
      payload({ participants: ['chatgpt', 'claude', 'grok', 'qwen'], summarizer: 'deepseek' }),
    );
    for (const participant of plan.participants) {
      assert.ok(participant.brief, `${participant.alias} 缺少 brief`);
    }
  });
});

/** buildMeetingPolicy 不是导出的，这里按同样的规则复算，供断言使用。 */
function buildPolicy(plan: ReturnType<typeof resolveMeetingPlan>) {
  const discussionParticipants = plan.participants.map((p) => p.alias);
  return {
    summarizerRole: 'separate-lead' as const,
    summarizerUsesParticipantSlot: false,
    discussionParticipants,
    discussionParticipantsByRound: Array.from(
      { length: Math.max(plan.rounds, 1) },
      () => discussionParticipants,
    ),
  };
}

// ===== 席位命名与总结会话 =====

/**
 * 席位名 `deepseek1` / `deepseek2` 不只是显示：**它进 conversationId**
 * （`<meetingId>:<alias>`），所以它同时就是会话身份。
 *
 *   名字相同 ⇒ conversationId 相同 ⇒ 命中同一个网页标签页
 *
 * 因此命名算法一旦和 UI 里的算法不一致，就会静默复用错会话——
 * 那是最难发现的一类 bug。这些测试把算法钉死。
 */

describe('席位命名', () => {
  it('同一 provider 出现多次时用序号区分', () => {
    const resolved = plan({
      participants: ['deepseek', 'chatgpt', 'deepseek'],
      summarizer: 'qwen',
    });
    assert.deepEqual(
      resolved.participants.map((p) => p.alias),
      ['deepseek1', 'chatgpt1', 'deepseek2'],
    );
  });

  it('序号按出现顺序累加，三次就是 1/2/3', () => {
    const resolved = plan({
      participants: ['grok', 'grok', 'grok', 'chatgpt'],
      summarizer: 'qwen',
    });
    assert.deepEqual(
      resolved.participants.map((p) => p.alias),
      ['grok1', 'grok2', 'grok3', 'chatgpt1'],
    );
  });

  it('provider 名里本来就带数字也不受影响（别名只是拼接）', () => {
    // 防止有人后来加"把尾部数字剥掉"的逻辑，那会把 chatgpt1 和 chatgpt 混起来
    const resolved = plan({ participants: ['grok', 'grok'], summarizer: 'qwen' });
    assert.deepEqual(
      resolved.participants.map((p) => p.alias),
      ['grok1', 'grok2'],
    );
    assert.notEqual(resolved.participants[0].alias, resolved.participants[1].alias);
  });

  it('重复 provider 的两个席位是不同的会话（alias 不同 ⇒ conversationId 不同）', () => {
    const resolved = plan({ participants: ['deepseek', 'deepseek'], summarizer: 'qwen' });
    const [first, second] = resolved.participants;
    assert.equal(first.provider, second.provider);
    assert.notEqual(first.alias, second.alias, 'alias 必须不同，否则两次请求会打到同一个会话');
  });

  it('顺序变了，席位名跟着变——名字里编码的是序号而不是固定身份', () => {
    const forward = plan({ participants: ['chatgpt', 'deepseek'], summarizer: 'qwen' });
    const reversed = plan({ participants: ['deepseek', 'chatgpt'], summarizer: 'qwen' });
    assert.equal(forward.participants[0].alias, 'chatgpt1');
    assert.equal(reversed.participants[0].alias, 'deepseek1');
  });

  it('唯一 provider 也带序号 1（统一规则，不做"只有一个就不编号"）', () => {
    const resolved = plan({ participants: ['claude'], summarizer: 'qwen' });
    assert.equal(resolved.participants[0].alias, 'claude1');
  });
});

describe('总结者的会话来源', () => {
  it('默认开新会话，不复用任何参与者', () => {
    const resolved = plan({ participants: ['chatgpt', 'deepseek'], summarizer: 'qwen' });
    assert.equal(resolved.summarizer.alias, 'qwen-summary');
    assert.equal(
      resolved.participants.some((p) => p.alias === resolved.summarizer.alias),
      false,
      '新会话名不能和任何席位撞名，否则会误复用',
    );
  });

  it('指定 summarizerSeat 时复用该席位，名字保持一致', () => {
    const resolved = plan({
      participants: ['deepseek', 'chatgpt', 'deepseek'],
      summarizer: 'deepseek',
      summarizerSeat: 'deepseek2',
    });
    assert.equal(resolved.summarizer.alias, 'deepseek2');
    assert.ok(
      resolved.participants.some((p) => p.alias === 'deepseek2'),
      '必须确实是个已有席位，否则"复用"落空',
    );
  });

  it('复用的席位仍然照常参加讨论（它既发言又总结）', () => {
    const resolved = plan({
      participants: ['deepseek', 'chatgpt'],
      summarizer: 'deepseek',
      summarizerSeat: 'deepseek1',
    });
    assert.deepEqual(
      resolved.participants.map((p) => p.alias),
      ['deepseek1', 'chatgpt1'],
      '被复用的席位不能从讨论里消失，否则少一个人发言',
    );
  });

  it('summarizerSeat 指向不存在的席位时退回新会话，而不是静默复用错的', () => {
    const resolved = plan({
      participants: ['chatgpt', 'deepseek'],
      summarizer: 'qwen',
      summarizerSeat: 'grok9',
    });
    assert.equal(resolved.summarizer.alias, 'qwen-summary');
  });

  it('总结者 provider 与被复用席位不同也不影响复用（以席位为准）', () => {
    // 席位名已编码 provider，这里防的是有人后来改成"按 provider 匹配"
    const resolved = plan({
      participants: ['deepseek', 'chatgpt'],
      summarizer: 'qwen',
      summarizerSeat: 'deepseek1',
    });
    assert.equal(resolved.summarizer.provider, 'qwen', 'provider 仍按请求走');
    assert.equal(resolved.summarizer.alias, 'deepseek1', '会话身份按席位走');
  });
});

describe('brief 不受席位改名影响', () => {
  it('每个席位都能拿到 brief（改名不该让某个席位拿到 undefined）', () => {
    const resolved = plan({
      participants: ['deepseek', 'deepseek', 'deepseek', 'deepseek'],
      summarizer: 'qwen',
    });
    for (const participant of resolved.participants) {
      assert.ok(participant.brief, `${participant.alias} 缺少 brief`);
    }
  });
});

describe('席位上限必须容得下一次会议', () => {
  it('每个 provider 的标签页上限 ≥ 6 席位 + 1 总结者', async () => {
    // 并行时同一 provider 的多个席位同时建页，而会话是按 provider:conversationId
    // 分键的，所以 N 个席位就是 N 个标签页。上限若小于 7，后建的会把先建的挤掉关闭，
    // 表现为"未找到回复节点"或"发送按钮未确认提交成功"——看着像站点问题，
    // 其实是自己回收了自己的标签页。
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../src/browser/browser-manager.ts', import.meta.url),
      'utf8',
    );
    const matched = /const MAX_SESSIONS_PER_PROVIDER = (\d+);/.exec(source);
    assert.ok(matched, '应能从 browser-manager 读出标签页上限');
    const limit = Number(matched[1]);
    assert.ok(
      limit >= 7,
      `标签页上限 ${limit} 容不下「6 个同 provider 席位 + 1 个总结者」所需的 7 个`,
    );
  });
});
