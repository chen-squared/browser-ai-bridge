import { randomUUID } from 'node:crypto';
import { normalizeMessages } from './prompt.js';
import type { ChatMessage, ProviderId } from './types.js';

export type CompletionPayload = {
  model?: string;
  provider?: ProviderId;
  messages: ChatMessage[];
  temperature?: number;
  conversationId?: string;
  enableSearch?: boolean;
  enableReasoning?: boolean;
  promptMode?: 'latest-user' | 'trailing-users' | 'full-messages';
  includeTrailingUserMessages?: boolean;
  injectSystemOnFirstTurn?: boolean;
  sessionTranscriptMode?: 'raw' | 'context-window';
  dryRun?: boolean;
  /**
   * 要逐字增量。内部调用时打开，好让 WebSocket 型 provider（Grok）把增量
   * 推到页面，用户能第一时间看到首字，而不是对着空白等整段写完。
   */
  stream?: boolean;
  meeting?: {
    participants?: ProviderId[];
    rounds?: number;
    summarizer?: ProviderId;
    /**
     * 总结者复用哪个席位的会话。席位名形如 deepseek1 / deepseek2。
     *
     * 不填则开新会话（`<provider>-summary`）。填了就沿用该席位的名字，
     * 于是 conversationId 相同、命中同一个网页标签页——总结者能在自己
     * 上一轮发言的基础上继续收口。
     */
    summarizerSeat?: string;
  };
};

export type MeetingParticipantPlan = {
  alias: string;
  provider: ProviderId;
  brief: string;
  enableSearch?: boolean;
  enableReasoning?: boolean;
};

export type MeetingTemplate = {
  id: string;
  label: string;
  description: string;
  mode: 'round-robin' | 'parallel';
  rounds: number;
  participants: MeetingParticipantPlan[];
  summarizer: { provider: ProviderId; alias: string; brief: string; enableReasoning?: boolean };
};

export type MeetingTranscriptEntry = {
  role: 'user' | 'assistant';
  speaker: string;
  provider?: ProviderId;
  stage: 'input' | 'assignment' | 'discussion' | 'summary';
  round?: number;
  content: string;
};

export type MeetingPolicy = {
  summarizerRole: 'separate-lead' | 'participant-lead';
  summarizerSpeaksFirst: true;
  summarizerSpeaksLast: true;
  participantOrderControlsTurnOrder: true;
  duplicateProvidersAllowed: true;
  summarizerMayAlsoUseParticipantProvider: true;
  summarizerUsesParticipantSlot: boolean;
  coordinatorAlias: string;
  discussionParticipants: string[];
  discussionParticipantsByRound: string[][];
  note: string;
};

export type MeetingProgressEvent =
  | {
      type: 'meeting.started';
      meeting: {
        conversationId: string;
        template: string;
        label: string;
        mode: MeetingTemplate['mode'];
        rounds: number;
        participants: MeetingParticipantPlan[];
        summarizer: MeetingTemplate['summarizer'];
        policy: MeetingPolicy;
      };
    }
  | {
      type: 'meeting.entry';
      meeting: {
        conversationId: string;
        template: string;
      };
      entry: MeetingTranscriptEntry;
    }
  | {
      /**
       * 某人开始写了。
       *
       * 没有它，页面上只有一个笼统的「正在处理中」，而且第一条发言到达就被撤掉了。
       * 走 HTTP 的 provider 推不出增量，于是从"他开始写"到"他写完"这整段时间里
       * 屏幕上什么都不显示——用户根本分不清是在跑还是卡住了。发了这个事件，
       * 对应的人就先冒出来，文字再慢慢填进去。
       */
      type: 'meeting.speaking';
      meeting: {
        conversationId: string;
        template: string;
      };
      speaker: string;
      provider: ProviderId;
      round: number;
    }
  | {
      /**
       * 某人正在写，边写边推。
       *
       * 只有走 WebSocket 的 provider（Grok）真正拿得到增量：它的帧是一帧一帧
       * 到达的，能测出真实的首字延迟。走 HTTP SSE 的 provider 只能在生成结束后
       * 一次性取到 body，推不了增量——那种情况下这个事件根本不会发，页面会等到
       * `meeting.entry` 才一次性显示。
       */
      type: 'meeting.delta';
      meeting: {
        conversationId: string;
        template: string;
      };
      speaker: string;
      provider: ProviderId;
      round: number;
      contentDelta?: string;
      reasoningDelta?: string;
    }
  | {
      type: 'meeting.completed';
      meeting: {
        conversationId: string;
        template: string;
      };
      response: unknown;
    };

/**
 * 各成员负责的角度。
 *
 * 原来是同一句话抄三遍：「沿着统筹者拆出来的子问题推进」。分工全靠统筹者在
 * 提示词里现编，结果模型被训练成"服从派任务的执行者"，而不是各自拿出真东西。
 *
 * 改成**角度**而不是**任务**：任务要等别人分派，角度自己就能站住。把它们按席位
 * 顺序铺开，于是三个成员天然分工不同，不需要统筹者去协调。
 */
const DISCUSSION_ANGLES = [
  '摆事实和依据：到底是什么、有哪些现成做法',
  '讲实现路径和代价：真要落地怎么走、要付出什么',
  '挑反例和边界：什么情况下这套根本不成立',
  '比取舍：几个方案之间该怎么选，标准是什么',
  '落到人身上：真实使用者的感受和实际影响',
  '指风险和未决的地方：哪里还不确定',
];

function briefAt(index: number): string {
  return DISCUSSION_ANGLES[index % DISCUSSION_ANGLES.length];
}

export const meetingModelTemplates: Record<string, MeetingTemplate> = {
  'meeting-round-robin-web': {
    id: 'meeting-round-robin-web',
    label: '轮流讨论会议',
    description: '负责人先给出自己的判断，其他成员按顺序接着补，最后由负责人收口。',
    mode: 'round-robin',
    rounds: 2,
    participants: [
      { alias: 'member-1', provider: 'chatgpt', brief: briefAt(0) },
      { alias: 'member-2', provider: 'qwen', brief: briefAt(1), enableReasoning: true },
      { alias: 'member-3', provider: 'claude', brief: briefAt(2) },
      { alias: 'member-4', provider: 'gemini', brief: briefAt(3) },
      { alias: 'member-5', provider: 'grok', brief: briefAt(4) },
      { alias: 'member-6', provider: 'deepseek', brief: briefAt(5) },
    ],
    summarizer: {
      provider: 'deepseek',
      alias: 'lead',
      brief: '先给出自己的判断，最后把全场的结论收成一条答复',
      enableReasoning: true,
    },
  },
  'meeting-parallel-web': {
    id: 'meeting-parallel-web',
    label: '并行讨论会议',
    description: '负责人先给出自己的判断，其他成员同时作答，最后由负责人汇总。',
    mode: 'parallel',
    rounds: 2,
    participants: [
      { alias: 'member-1', provider: 'gemini', brief: briefAt(0) },
      { alias: 'member-2', provider: 'qwen', brief: briefAt(1), enableReasoning: true },
      { alias: 'member-3', provider: 'claude', brief: briefAt(2) },
      { alias: 'member-4', provider: 'chatgpt', brief: briefAt(3) },
      { alias: 'member-5', provider: 'grok', brief: briefAt(4) },
      { alias: 'member-6', provider: 'deepseek', brief: briefAt(5) },
    ],
    summarizer: {
      provider: 'deepseek',
      alias: 'lead',
      brief: '先给出自己的判断，最后把全场的结论收成一条答复',
      enableReasoning: true,
    },
  },
};

export function resolveMeetingTemplate(model: string | undefined): MeetingTemplate | undefined {
  if (!model) {
    return undefined;
  }
  return meetingModelTemplates[model];
}

export function resolveMeetingPlan(
  template: MeetingTemplate,
  payload: CompletionPayload,
): MeetingTemplate {
  const overrideParticipants = payload.meeting?.participants;
  const rounds = payload.meeting?.rounds ?? template.rounds;
  const summarizerProvider = payload.meeting?.summarizer ?? template.summarizer.provider;

  const personaPool = template.participants;
  const participantProviders =
    overrideParticipants && overrideParticipants.length > 0
      ? overrideParticipants
      : template.participants.map((item) => item.provider);

  // 席位名由 provider 派生，重复的 provider 用序号区分：deepseek1 / deepseek2。
  //
  // 原来是 member-1 / member-2，看着只是序号，既看不出背后是哪个模型，
  // 也没法在总结阶段指认"复用哪一个席位"。而席位名会进 conversationId
  // （`<meetingId>:<alias>`），所以它同时是**会话身份**：同名即同一会话。
  const seatCounters = new Map<ProviderId, number>();
  const participants = participantProviders.map((provider, index) => {
    const base = personaPool[index % personaPool.length];
    const nth = (seatCounters.get(provider) ?? 0) + 1;
    seatCounters.set(provider, nth);
    return {
      alias: `${provider}${nth}`,
      provider,
      brief: base.brief,
      enableSearch: base.enableSearch,
      enableReasoning: base.enableReasoning,
    } satisfies MeetingParticipantPlan;
  });

  // 总结者：默认开新会话（summarizer-<provider>）；若显式指定复用某个席位，
  // 就沿用那个席位的名字，从而复用同一个网页会话。
  //
  // 名字相同 ⇒ conversationId 相同 ⇒ browser-manager 命中已有标签页，
  // 于是总结者是在该成员自己的会话里接着说，能看到它之前那一轮发言。
  const requestedSeat = payload.meeting?.summarizerSeat;
  const reusable = requestedSeat
    ? participants.find((participant) => participant.alias === requestedSeat)
    : undefined;

  // 「复用某席位的会话」只有总结者**就是那个席位**时才成立。
  //
  // 复用靠的是同名 ⇒ 同 conversationId ⇒ 命中同一个浏览器标签页。跨 provider
  // 时这条路根本不存在：alias 叫 chatgpt1 而 provider 是 qwen，开出来的其实是
  // 一个挂着 chatgpt 名字的全新 qwen 会话，界面提示「会在 chatgpt1 的同一个会话
  // 里收口」是假的。与其悄悄做错，不如当场说清楚。
  if (requestedSeat && !reusable) {
    throw new Error(
      `找不到名为 ${requestedSeat} 的席位。当前席位是 ${participants
        .map((participant) => participant.alias)
        .join('、')}。`,
    );
  }
  if (reusable && reusable.provider !== summarizerProvider) {
    throw new Error(
      `${reusable.alias} 是 ${reusable.provider} 的席位，总结者选的是 ${summarizerProvider}，` +
        `两者不是同一个模型，没法复用同一个网页会话。` +
        `要复用就把总结者改成 ${reusable.provider}；想开新会话就把「总结用哪个会话」留空。`,
    );
  }

  const summarizerAlias = reusable ? reusable.alias : `${summarizerProvider}-summary`;

  return {
    ...template,
    rounds,
    participants,
    summarizer: {
      ...template.summarizer,
      alias: summarizerAlias,
      provider: summarizerProvider,
    },
  };
}

export function toMeetingTranscriptSeed(messages: ChatMessage[]): MeetingTranscriptEntry[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      speaker: message.name?.trim() || (message.role === 'user' ? 'user' : 'assistant'),
      stage: 'input' as const,
      content: message.content.trim(),
    }))
    .filter((entry) => Boolean(entry.content));
}

export function buildMeetingRoster(plan: MeetingTemplate): string {
  return plan.participants
    .map((participant) => `${participant.alias}(${participant.provider})`)
    .join('、');
}

function buildMeetingPolicy(plan: MeetingTemplate): MeetingPolicy {
  // 席位名与总结者名字相同 ⇒ 总结者复用了该成员的网页会话。
  const reusesSeat = plan.participants.some(
    (participant) => participant.alias === plan.summarizer.alias,
  );
  const discussionParticipants = plan.participants.map((participant) => participant.alias);
  const discussionParticipantsByRound = Array.from(
    { length: Math.max(plan.rounds, 1) },
    () => discussionParticipants,
  );

  return {
    summarizerRole: reusesSeat ? 'participant-lead' : 'separate-lead',
    summarizerSpeaksFirst: true,
    summarizerSpeaksLast: true,
    participantOrderControlsTurnOrder: true,
    duplicateProvidersAllowed: true,
    summarizerMayAlsoUseParticipantProvider: true,
    summarizerUsesParticipantSlot: reusesSeat,
    coordinatorAlias: plan.summarizer.alias,
    discussionParticipants,
    discussionParticipantsByRound,
    note: reusesSeat
      ? `总结者复用了席位 ${plan.summarizer.alias} 的会话，因此它既参加讨论、又负责最后收口，且能看到自己之前的发言。participants 的顺序就是发言顺序；重复 provider 用序号区分（deepseek1 / deepseek2），各占独立会话。`
      : `总结者是独立会话（${plan.summarizer.alias}），不占参与者名额：participants 决定发言成员与顺序，每轮全部成员都发言。重复 provider 用序号区分（deepseek1 / deepseek2），各占独立会话。`,
  } as const;
}

function getDiscussionParticipantsForRound(
  plan: MeetingTemplate,
  policy: MeetingPolicy,
  round: number,
): MeetingParticipantPlan[] {
  const aliases = new Set(
    policy.discussionParticipantsByRound[round - 1] ?? policy.discussionParticipants,
  );
  return plan.participants.filter((participant) => aliases.has(participant.alias));
}

/**
 * 流水线式启动：每隔 {@link PARALLEL_STAGGER_MS} 毫秒才发起下一个。
 *
 * 原来是 `Promise.all` 一次性全发出去。同一个浏览器里每个 provider 都要新开标签页
 * 并加载重 SPA，同时起就互相抢资源——实测只要 ChatGPT 在其中，同场的 Gemini 就会
 * `未能稳定提取`，Claude 更惨，退回 DOM 后抓到的是首屏问候语
 * （`How can I help you today?`），而不是回答。
 *
 * 错开之后仍然是"并行"：总耗时接近最慢的那一个，而不是所有人之和；
 * 但不会再在大家都还没加载完的时候一起冲进去。
 */
const PARALLEL_STAGGER_MS = 1500;

async function startStaggered<T, R>(
  items: readonly T[],
  start: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const tasks: Promise<R>[] = [];
  for (const [index, item] of items.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, PARALLEL_STAGGER_MS));
    }
    tasks.push(start(item, index));
  }
  return Promise.all(tasks);
}

export function buildDiscussionMessages(
  seedMessages: ChatMessage[],
  _transcript: MeetingTranscriptEntry[],
  prompt: string,
): ChatMessage[] {
  // 接力链的形态：上下文就写在 prompt 正文里（问题 + 一行行的「某某说：……」），
  // 不再把 transcript 当聊天历史重放一遍——那样同一个内容会出现两次
  // （一次在历史里、一次在 prompt 里），模型容易被带偏。
  return [
    ...seedMessages.filter((message) => message.role === 'system'),
    { role: 'user', content: prompt },
  ];
}

/**
 * 拼接力链的 prompt。
 *
 * 就是最朴素的形态：问题在前，别人说过的话一行行接在后面，需要收口的那位
 * 再加一句"总结一下他们的内容"。不解释这是什么会议、不分配角色、不报轮次。
 */
export function buildRelayPrompt(
  question: string,
  chain: readonly MeetingTranscriptEntry[],
  options?: { summarize?: boolean; react?: boolean },
): string {
  const lines = [question.trim()];

  if (chain.length > 0) {
    lines.push('');
    for (const entry of chain) {
      const body = (entry.content || '').trim();
      if (!body) {
        continue;
      }
      lines.push(`${entry.speaker}说：${body}`);
    }
  }

  // 接力的人被问了一句"你怎么看"，所以他会真的回应上面那些话，
  // 而不是从头再答一遍。收口那位则只要总结。
  if (options?.react) {
    lines.push('');
    lines.push('你觉得怎么样');
  }
  if (options?.summarize) {
    lines.push('');
    lines.push('总结一下他们的内容。');
  }

  return lines.join('\n');
}

export function formatReasoningTranscript(entries: MeetingTranscriptEntry[]): string {
  return entries
    .filter((entry) => entry.stage !== 'summary')
    .map((entry) => {
      const roundPrefix = entry.round ? `第 ${entry.round} 轮 · ` : '';
      const providerSuffix = entry.provider ? ` · ${entry.provider}` : '';
      return `### ${roundPrefix}${entry.speaker}${providerSuffix}\n${entry.content}`;
    })
    .join('\n\n');
}

export async function runMeetingCompletion(
  payload: CompletionPayload,
  template: MeetingTemplate,
  completeWithProvider: (
    payload: CompletionPayload & {
      provider: ProviderId;
      model: string;
      messages: ChatMessage[];
      conversationId?: string;
    },
    options?: {
      /** 逐字增量。只有走 WebSocket 的 provider（Grok）真推得出来。 */
      onDelta?: (delta: { contentDelta?: string; reasoningDelta?: string }) => void;
    },
  ) => Promise<{
    provider: ProviderId;
    model: string;
    conversationId?: string;
    url?: string;
    content?: string;
    reasoningContent?: string;
    dryRun?: boolean;
    prompt?: string;
    debug?: unknown;
  }>,
  options?: {
    onProgress?: (event: MeetingProgressEvent) => Promise<void> | void;
    /**
     * 之前几轮的全部发言。**多轮的关键**：新一轮的每个成员都要带着旧发言开场，
     * 否则"接着聊"就退化成"每次都是新会议"。
     */
    priorTranscript?: MeetingTranscriptEntry[];
  },
) {
  /**
   * 发进度，但不等、不抛。
   *
   * 进度是"尽力而为"的旁路：客户端断开后靠轮询也能对上，所以这里绝不能 await
   * （delta 是热路径，串行等会拖慢流速），也不能裸 void（回调一旦 reject 就是
   * unhandled rejection，半夜能把整个进程带走）。吞掉异常，只留一条 warn。
   */
  const fireProgress = (event: MeetingProgressEvent): void => {
    try {
      const result = options?.onProgress?.(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((error: unknown) => {
          console.warn(`[meeting] 进度回调失败（已忽略）: ${String(error).slice(0, 120)}`);
        });
      }
    } catch (error) {
      console.warn(`[meeting] 进度回调抛错（已忽略）: ${String(error).slice(0, 120)}`);
    }
  };
  const plan = resolveMeetingPlan(template, payload);
  const policy = buildMeetingPolicy(plan);
  const seedMessages = payload.messages.map((message) => ({ ...message }));
  // 旧发言在前、本轮用户消息在后。新开一场时 priorTranscript 为空，行为不变。
  const transcript: MeetingTranscriptEntry[] = [
    ...(options?.priorTranscript ?? []).map((entry) => ({ ...entry })),
    ...toMeetingTranscriptSeed(seedMessages),
  ];
  // 本轮新增的发言从这里开始算起——存储时要单独存成"一轮"，
  // 而不是把整场会议反复叠加进历史。
  const turnStartIndex = transcript.length;
  const effectiveConversationId = payload.conversationId ?? `meeting-${randomUUID()}`;
  // 接力链永远从"用户这个问题"开始。取最后一条 user 消息，多轮提问时就是本轮那条。
  const latestQuestion =
    [...seedMessages]
      .reverse()
      .find((message) => message.role === 'user')
      ?.content.trim() ?? '';
  const pageUrls: Array<{ speaker: string; provider: ProviderId; url?: string }> = [];

  await options?.onProgress?.({
    type: 'meeting.started',
    meeting: {
      conversationId: effectiveConversationId,
      template: plan.id,
      label: plan.label,
      mode: plan.mode,
      rounds: plan.rounds,
      participants: plan.participants,
      summarizer: plan.summarizer,
      policy,
    },
  });

  // 没有"分工"阶段了。第一个发言的人直接回答用户的问题。
  const runParticipantTurn = async (
    participant: MeetingParticipantPlan,
    round: number,
    chain: MeetingTranscriptEntry[],
  ) => {
    // 接力链：问题 + 前面每个人说过的话，一行一个「某某说：……」。
    // 顺序模式下第一个人只看到问题，从第二个起被问一句"你觉得怎么样"，
    // 于是会真的回应上面那些话。并行模式下同轮所有人看到的都一样（只有问题），
    // 也就没有可回应的内容，所以不加那句。
    const discussionPrompt = buildRelayPrompt(latestQuestion, chain, {
      react: plan.mode === 'round-robin' && chain.length > 0,
    });

    // 先报"他开始写了"，页面上对应的气泡立刻出现，不用等第一段文字。
    fireProgress({
      type: 'meeting.speaking',
      meeting: { conversationId: effectiveConversationId, template: plan.id },
      speaker: participant.alias,
      provider: participant.provider,
      round,
    });

    const result = await completeWithProvider(
      {
        ...payload,
        provider: participant.provider,
        model: `${participant.provider}-web`,
        conversationId: `${effectiveConversationId}:${participant.alias}:${participant.provider}`,
        messages: buildDiscussionMessages(seedMessages, chain, discussionPrompt),
        enableSearch: participant.enableSearch,
        enableReasoning: participant.enableReasoning,
        promptMode: 'full-messages',
        sessionTranscriptMode: 'context-window',
        injectSystemOnFirstTurn: true,
        // 逐字往外推。Grok 走 WebSocket，帧是一帧一帧到的，于是用户能看到
        // 首字就冒出来；HTTP 的 provider 推不出增量，这个回调根本不会被调，
        // 页面会一直等到下面那条 meeting.entry 才一次性显示。
        stream: true,
      },
      {
        onDelta: (delta) => {
          fireProgress({
            type: 'meeting.delta',
            meeting: { conversationId: effectiveConversationId, template: plan.id },
            speaker: participant.alias,
            provider: participant.provider,
            round,
            ...(delta.contentDelta ? { contentDelta: delta.contentDelta } : {}),
            ...(delta.reasoningDelta ? { reasoningDelta: delta.reasoningDelta } : {}),
          });
        },
      },
    );

    pageUrls.push({ speaker: participant.alias, provider: participant.provider, url: result.url });

    return {
      role: 'assistant' as const,
      speaker: participant.alias,
      provider: participant.provider,
      stage: 'discussion' as const,
      round,
      content: result.content || '',
    } satisfies MeetingTranscriptEntry;
  };

  /**
   * 跑一个人的发言，失败不往外抛，而是变成一条"他没成"的发言。
   *
   * 以前是直接抛：并行时 `Promise.all` 里任何一个人失败，整场会议立刻结束，
   * 已经跑完的人���发言全被丢掉——用户看到的是"生成到一半弹了个错，
   * 记录里一条都没有"。顺序模式也一样，中间一个人挂了后面全都不跑。
   *
   * 一场会议本来就有冗余：少一个人发言，总结照样能收口，总比整场白跑强。
   */
  const runParticipantTurnSafely = async (
    participant: MeetingParticipantPlan,
    round: number,
    chain: MeetingTranscriptEntry[],
  ): Promise<MeetingTranscriptEntry> => {
    try {
      return await runParticipantTurn(participant, round, chain);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        role: 'assistant' as const,
        speaker: participant.alias,
        provider: participant.provider,
        stage: 'discussion' as const,
        round,
        content: `（${participant.alias} 这一轮没能完成：${reason}）`,
      } satisfies MeetingTranscriptEntry;
    }
  };

  if (payload.dryRun) {
    const response = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: template.id,
      provider: 'meeting',
      dryRun: true,
      meeting: {
        conversationId: effectiveConversationId,
        template: plan.id,
        label: plan.label,
        description: plan.description,
        mode: plan.mode,
        rounds: plan.rounds,
        participants: plan.participants,
        summarizer: plan.summarizer,
        policy,
        transcript,
        // dryRun 不真的发消息，所以本轮没有任何新增发言。字段仍要给全，
        // 否则调用方要按"字段可能不存在"来处理，徒增分支。
        turnEntries: [],
      },
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'dry run',
            reasoning_content: formatReasoningTranscript(transcript),
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    await options?.onProgress?.({
      type: 'meeting.completed',
      meeting: {
        conversationId: effectiveConversationId,
        template: plan.id,
      },
      response,
    });

    return response;
  }

  for (let round = 1; round <= plan.rounds; round += 1) {
    const roundParticipants = getDiscussionParticipantsForRound(plan, policy, round);
    // 上一轮（含更早）说过的话，作为本轮的起点。顺序模式下同轮内还要一个个追加，
    // 并行模式下同轮所有人看到的完全一样——所以谁也引用不了谁。
    const beforeRound = transcript
      .filter((entry) => entry.stage === 'discussion')
      .map((e) => ({ ...e }));

    if (plan.mode === 'parallel') {
      const roundEntries = await startStaggered(roundParticipants, (participant) =>
        runParticipantTurnSafely(participant, round, beforeRound),
      );
      transcript.push(...roundEntries);
      for (const entry of roundEntries) {
        await options?.onProgress?.({
          type: 'meeting.entry',
          meeting: {
            conversationId: effectiveConversationId,
            template: plan.id,
          },
          entry,
        });
      }
    } else {
      for (const participant of roundParticipants) {
        // 传 transcript 本身：它一直在增长，于是每个人拿到的链都是"到这儿为止的
        // 全部发言"。这就是接力。
        const entry = await runParticipantTurnSafely(participant, round, [
          ...beforeRound,
          ...transcript.filter((e) => e.stage === 'discussion' && e.round === round),
        ]);
        transcript.push(entry);
        await options?.onProgress?.({
          type: 'meeting.entry',
          meeting: {
            conversationId: effectiveConversationId,
            template: plan.id,
          },
          entry,
        });
      }
    }
  }

  const summaryPrompt = buildRelayPrompt(
    latestQuestion,
    transcript.filter((e) => e.stage === 'discussion'),
    {
      summarize: true,
    },
  );

  fireProgress({
    type: 'meeting.speaking',
    meeting: { conversationId: effectiveConversationId, template: plan.id },
    speaker: plan.summarizer.alias,
    provider: plan.summarizer.provider,
    round: 0,
  });

  let summaryResult: {
    content?: string;
    url?: string;
    provider?: ProviderId;
    model?: string;
  };
  try {
    summaryResult = await completeWithProvider(
      {
        ...payload,
        provider: plan.summarizer.provider,
        model: `${plan.summarizer.provider}-web`,
        conversationId: `${effectiveConversationId}:${plan.summarizer.alias}:${plan.summarizer.provider}`,
        messages: buildDiscussionMessages(seedMessages, transcript, summaryPrompt),
        enableReasoning: plan.summarizer.enableReasoning,
        promptMode: 'full-messages',
        sessionTranscriptMode: 'context-window',
        injectSystemOnFirstTurn: true,
        stream: true,
      },
      {
        // 总结同样是逐字推，用户不用对着空白等它写完。
        onDelta: (delta) => {
          fireProgress({
            type: 'meeting.delta',
            meeting: { conversationId: effectiveConversationId, template: plan.id },
            speaker: plan.summarizer.alias,
            provider: plan.summarizer.provider,
            round: 0,
            ...(delta.contentDelta ? { contentDelta: delta.contentDelta } : {}),
            ...(delta.reasoningDelta ? { reasoningDelta: delta.reasoningDelta } : {}),
          });
        },
      },
    );
  } catch (error) {
    // 总结挂了也别把前面所有人的发言一起带走。落一条说明，至少时间线还在，
    // 用户还能看到大家说了什么、总结者为什么没成。
    const reason = error instanceof Error ? error.message : String(error);
    summaryResult = {
      provider: plan.summarizer.provider,
      model: `${plan.summarizer.provider}-web`,
      content: `（总结者 ${plan.summarizer.alias} 这一步没能完成：${reason}）`,
    };
  }

  transcript.push({
    role: 'assistant',
    speaker: plan.summarizer.alias,
    provider: plan.summarizer.provider,
    stage: 'summary',
    round: 0,
    content: summaryResult.content || '',
  });
  // 总结也要发 meeting.entry。原先只 push 进 transcript，靠末尾补发的 OpenAI 形状
  // chunk 让页面单独渲染一张"统一答复"卡片——于是同一段话在页面上出现两次，
  // 而且 meeting.speaking 占出来的那张气泡**永远没人替换**，收尾还留着
  // 一个"正在写…"。
  await options?.onProgress?.({
    type: 'meeting.entry',
    meeting: {
      conversationId: effectiveConversationId,
      template: plan.id,
    },
    entry: transcript[transcript.length - 1],
  });
  pageUrls.push({
    speaker: plan.summarizer.alias,
    provider: plan.summarizer.provider,
    url: summaryResult.url,
  });

  const response = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: template.id,
    provider: 'meeting',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: summaryResult.content || '',
          reasoning_content: formatReasoningTranscript(transcript),
        },
        finish_reason: 'stop',
      },
    ],
    meeting: {
      conversationId: effectiveConversationId,
      template: plan.id,
      label: plan.label,
      description: plan.description,
      mode: plan.mode,
      rounds: plan.rounds,
      participants: plan.participants,
      summarizer: plan.summarizer,
      policy,
      transcript,
      /** 只有本轮新增的发言。存储层用它来划出"一轮"。 */
      turnEntries: transcript.slice(turnStartIndex),
    },
    page: {
      urls: pageUrls,
    },
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };

  await options?.onProgress?.({
    type: 'meeting.completed',
    meeting: {
      conversationId: effectiveConversationId,
      template: plan.id,
    },
    response,
  });

  return response;
}

export function listMeetingModels() {
  return Object.values(meetingModelTemplates).map((template) => ({
    id: template.id,
    object: 'model' as const,
    created: 0,
    owned_by: 'browser-ai-bridge',
    provider: 'meeting',
    label: template.label,
    description: template.description,
    kind: 'meeting',
  }));
}

export function buildMeetingDetailsText(payload: unknown, reasoningText: string): string {
  return [
    'meeting:',
    JSON.stringify((payload as { meeting?: unknown })?.meeting || {}, null, 2),
    '',
    'reasoning transcript:',
    reasoningText || '(空)',
    '',
    'full response:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

export function buildMeetingErrorText(): string {
  return [
    '会议请求失败。常见原因:',
    '1. 某个 provider 当前未登录。',
    '2. 某个网页要求手动选择候选回答。',
    '3. 某个网页正在限额、掉线或网络异常。',
    '4. 某个 selector 变化导致无法发送。',
  ].join('\n');
}

export function ensureMeetingMessages(messages: ChatMessage[]): ChatMessage[] {
  return normalizeMessages(messages).nonSystemMessages.map((message) => ({
    role: message.role,
    content: message.content,
    name: message.name,
  }));
}
