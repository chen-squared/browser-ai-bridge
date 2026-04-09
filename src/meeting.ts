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
  meeting?: {
    participants?: ProviderId[];
    rounds?: number;
    summarizer?: ProviderId;
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
      type: 'meeting.completed';
      meeting: {
        conversationId: string;
        template: string;
      };
      response: unknown;
    };

export const meetingModelTemplates: Record<string, MeetingTemplate> = {
  'meeting-round-robin-web': {
    id: 'meeting-round-robin-web',
    label: '轮流讨论会议',
    description: '统筹者先拆题并做自己的第一段分析，其他成员按顺序补充，最后由统筹者统一收口。',
    mode: 'round-robin',
    rounds: 2,
    participants: [
      {
        alias: 'member-1',
        provider: 'chatgpt',
        brief: '沿着统筹者拆出来的子问题推进，补足事实、实现路径或反例',
      },
      {
        alias: 'member-2',
        provider: 'qwen',
        brief: '沿着统筹者拆出来的子问题推进，补足事实、实现路径或反例',
        enableReasoning: true,
      },
    ],
    summarizer: {
      provider: 'deepseek',
      alias: 'lead',
      brief: '先拆解用户问题并完成自己的那部分分析，最后负责把结论收束成一条答复',
      enableReasoning: true,
    },
  },
  'meeting-parallel-web': {
    id: 'meeting-parallel-web',
    label: '并行讨论会议',
    description: '统筹者先拆题并做自己的第一段分析，其他成员并行推进，最后由统筹者统一汇总。',
    mode: 'parallel',
    rounds: 2,
    participants: [
      {
        alias: 'member-1',
        provider: 'gemini',
        brief: '沿着统筹者拆出来的子问题推进，补足事实、实现路径或反例',
      },
      {
        alias: 'member-2',
        provider: 'qwen',
        brief: '沿着统筹者拆出来的子问题推进，补足事实、实现路径或反例',
        enableReasoning: true,
      },
    ],
    summarizer: {
      provider: 'deepseek',
      alias: 'lead',
      brief: '先拆解用户问题并完成自己的那部分分析，最后负责把结论收束成一条答复',
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
  const participants = (
    overrideParticipants && overrideParticipants.length > 0
      ? overrideParticipants
      : template.participants.map((item) => item.provider)
  ).map((provider, index) => {
    const base = personaPool[index % personaPool.length];
    return {
      alias: `member-${index + 1}`,
      provider,
      brief: base.brief,
      enableSearch: base.enableSearch,
      enableReasoning: base.enableReasoning,
    } satisfies MeetingParticipantPlan;
  });
  const embeddedSummarizer = participants.find(
    (participant) => participant.provider === summarizerProvider,
  );

  return {
    ...template,
    rounds,
    participants,
    summarizer: {
      ...template.summarizer,
      alias: embeddedSummarizer?.alias ?? template.summarizer.alias,
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
  const summarizerUsesParticipantSlot = plan.participants.some(
    (participant) =>
      participant.alias === plan.summarizer.alias &&
      participant.provider === plan.summarizer.provider,
  );
  const discussionParticipants = plan.participants.map((participant) => participant.alias);
  const discussionParticipantsByRound = Array.from(
    { length: plan.rounds },
    (_unused, roundIndex) => {
      if (!summarizerUsesParticipantSlot || roundIndex > 0) {
        return discussionParticipants;
      }

      return discussionParticipants.filter((alias) => alias !== plan.summarizer.alias);
    },
  );

  return {
    summarizerRole: summarizerUsesParticipantSlot ? 'participant-lead' : 'separate-lead',
    summarizerSpeaksFirst: true,
    summarizerSpeaksLast: true,
    participantOrderControlsTurnOrder: true,
    duplicateProvidersAllowed: true,
    summarizerMayAlsoUseParticipantProvider: true,
    summarizerUsesParticipantSlot,
    coordinatorAlias: plan.summarizer.alias,
    discussionParticipants,
    discussionParticipantsByRound,
    note: summarizerUsesParticipantSlot
      ? '如果 summarizer provider 同时出现在 participants 里，则第一个匹配到的 member 会兼任统筹者：它固定先发言并最后总结；第 1 轮的个人分析已经并入 assignment，因此第 1 轮 discussion 从其他成员开始；从第 2 轮起统筹者重新加入讨论。participants 的顺序决定轮次顺序。重复 provider 仍会被视为不同 member 会话。'
      : '如果 summarizer provider 没有出现在 participants 里，则会额外创建一个独立的统筹者会话：它固定先发言并最后总结；participants 的顺序决定 member-1/member-2... 的轮次顺序；重复 provider 会被视为不同 member 会话。',
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

export function buildDiscussionMessages(
  seedMessages: ChatMessage[],
  transcript: MeetingTranscriptEntry[],
  prompt: string,
): ChatMessage[] {
  const historyMessages: ChatMessage[] = transcript.map((entry) => ({
    role: entry.role,
    name: entry.speaker,
    content: entry.content,
  }));

  return [
    ...seedMessages.filter((message) => message.role === 'system'),
    ...historyMessages,
    { role: 'user', content: prompt },
  ];
}

export function formatReasoningTranscript(entries: MeetingTranscriptEntry[]): string {
  return entries
    .filter((entry) => entry.stage !== 'summary')
    .map((entry) => {
      const stagePrefix = entry.stage === 'assignment' ? '分工 · ' : '';
      const roundPrefix = entry.round ? `第 ${entry.round} 轮 · ` : '';
      const providerSuffix = entry.provider ? ` · ${entry.provider}` : '';
      return `### ${stagePrefix}${roundPrefix}${entry.speaker}${providerSuffix}\n${entry.content}`;
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
  },
) {
  const plan = resolveMeetingPlan(template, payload);
  const policy = buildMeetingPolicy(plan);
  const seedMessages = payload.messages.map((message) => ({ ...message }));
  const transcript = toMeetingTranscriptSeed(seedMessages);
  const effectiveConversationId = payload.conversationId ?? `meeting-${randomUUID()}`;
  const roster = buildMeetingRoster(plan);
  const _discussionParticipants = plan.participants.filter((participant) =>
    policy.discussionParticipants.includes(participant.alias),
  );
  const assignmentParticipants = plan.participants.filter(
    (participant) => participant.alias !== plan.summarizer.alias,
  );
  const memberAliasList = assignmentParticipants.map((participant) => participant.alias).join('、');
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

  const assignmentPrompt = [
    `你是这场会议的负责人 ${plan.summarizer.alias}，底层 provider 是 ${plan.summarizer.provider}。`,
    `本场会议总共有 ${plan.rounds} 轮成员讨论。你的职责是先给其他成员分工，同时先完成你自己负责的那部分分析，再在最后统一总结。`,
    `固定成员只有：${roster}。不要创造新成员，不要让成员继续无限制地互相指派任务。`,
    assignmentParticipants.length > 0
      ? `请先逐一给 ${memberAliasList} 分工，明确每个人应该从什么角度推进。`
      : '本场没有其他成员需要分工，请直接说明这一点，然后继续完成你自己负责的分析。',
    '要求：分工要足够抽象，不要把方案内容替他们直接写完；要让他们在有限轮次内能推进。',
    `请显式提醒：他们只有 ${plan.rounds} 轮可用，需要在轮次内完成推进，不要把任务留到轮次结束后。`,
    '在分工之后，立刻继续输出你自己负责的部分：给出你的初步判断、整体框架、关键分歧或风险点。不要等待下一条消息再开始做你自己的部分。',
    '输出顺序要求：先写“分工”，再写“lead 的初步分析”。',
  ].join('\n');

  const assignmentResult = await completeWithProvider({
    ...payload,
    provider: plan.summarizer.provider,
    model: `${plan.summarizer.provider}-web`,
    conversationId: `${effectiveConversationId}:${plan.summarizer.alias}:${plan.summarizer.provider}`,
    messages: buildDiscussionMessages(seedMessages, transcript, assignmentPrompt),
    enableReasoning: plan.summarizer.enableReasoning,
    promptMode: 'full-messages',
    sessionTranscriptMode: 'context-window',
    injectSystemOnFirstTurn: true,
  });

  transcript.push({
    role: 'assistant',
    speaker: plan.summarizer.alias,
    provider: plan.summarizer.provider,
    stage: 'assignment',
    content: assignmentResult.content || '',
  });
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
    url: assignmentResult.url,
  });

  const runParticipantTurn = async (
    participant: MeetingParticipantPlan,
    round: number,
    priorTranscript: MeetingTranscriptEntry[],
    turnPosition?: number,
    turnTotal?: number,
  ) => {
    const remainingRounds = Math.max(plan.rounds - round, 0);
    const discussionPrompt = [
      `你正在参加一个多 AI 会议。你的固定身份是 ${participant.alias}，底层 provider 是 ${participant.provider}。`,
      `你的职责：${participant.brief}。`,
      `固定参会成员：${roster}。`,
      `当前是第 ${round} / ${plan.rounds} 轮，本轮结束后还剩 ${remainingRounds} 轮。请直接延续上面的完整聊天历史作答，不要假装自己是最终客服，不要重复转述全部上下文。`,
      plan.mode === 'round-robin' && turnPosition && turnTotal
        ? `本轮按顺序轮流发言。你是本轮第 ${turnPosition} / ${turnTotal} 位发言者，请只推进你负责的那一部分，并显式承接前面已出现的观点。`
        : null,
      '请优先执行总结者刚才分配给你的任务，不要重新给其他成员派新任务。',
      plan.mode === 'round-robin'
        ? '这是轮流讨论模板。请在吸收前面发言后，推进你负责的部分，长度控制在 3 到 6 句。'
        : '这是并行讨论模板。请基于已有聊天与会议历史，推进你负责的部分，长度控制在 3 到 6 句。',
      remainingRounds === 0
        ? '这是最后一轮。请把你负责的部分尽量收束清楚，不要再要求别人后续补充。'
        : '如果需要其他成员配合，只能提出非常有限的补充点，避免把任务拖到最后一轮之后。',
      plan.mode === 'round-robin'
        ? '除非这是最后总结阶段，否则不要把自己写成会议最终答复人，也不要提前替全场收尾。'
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const result = await completeWithProvider({
      ...payload,
      provider: participant.provider,
      model: `${participant.provider}-web`,
      conversationId: `${effectiveConversationId}:${participant.alias}:${participant.provider}`,
      messages: buildDiscussionMessages(seedMessages, priorTranscript, discussionPrompt),
      enableSearch: participant.enableSearch,
      enableReasoning: participant.enableReasoning,
      promptMode: 'full-messages',
      sessionTranscriptMode: 'context-window',
      injectSystemOnFirstTurn: true,
    });

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
    if (plan.mode === 'parallel') {
      const roundSeed = transcript.map((entry) => ({ ...entry }));
      const roundEntries = await Promise.all(
        roundParticipants.map((participant) => runParticipantTurn(participant, round, roundSeed)),
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
      for (const [participantIndex, participant] of roundParticipants.entries()) {
        const entry = await runParticipantTurn(
          participant,
          round,
          transcript,
          participantIndex + 1,
          roundParticipants.length,
        );
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

  const summaryPrompt = [
    `你是本场会议的总结人 ${plan.summarizer.alias}，底层 provider 是 ${plan.summarizer.provider}。`,
    `你前面已经给其他成员做过任务分工，并完成了自己的初步分析。现在请基于用户消息、你的首轮分工与分析，以及 ${plan.rounds} 轮讨论结果收束最终答复。`,
    '请基于上面的全部聊天历史与会议讨论，只输出最后给用户的正式回答。',
    '要求：保留结论、关键依据和建议动作；不要复述会议流程；不要再模拟其他参会者。',
  ].join('\n');

  const summaryResult = await completeWithProvider({
    ...payload,
    provider: plan.summarizer.provider,
    model: `${plan.summarizer.provider}-web`,
    conversationId: `${effectiveConversationId}:${plan.summarizer.alias}:${plan.summarizer.provider}`,
    messages: buildDiscussionMessages(seedMessages, transcript, summaryPrompt),
    enableReasoning: plan.summarizer.enableReasoning,
    promptMode: 'full-messages',
    sessionTranscriptMode: 'context-window',
    injectSystemOnFirstTurn: true,
  });

  transcript.push({
    role: 'assistant',
    speaker: plan.summarizer.alias,
    provider: plan.summarizer.provider,
    stage: 'summary',
    content: summaryResult.content || '',
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

export function buildMeetingOptionsHtml() {
  return Object.values(meetingModelTemplates)
    .map((template) => `<option value="${template.id}">${template.label}</option>`)
    .join('');
}

export function buildMeetingHintMapScript() {
  return JSON.stringify(
    Object.fromEntries(
      Object.values(meetingModelTemplates).map((template) => [
        template.id,
        template.mode === 'round-robin'
          ? '轮流推进模板：统筹者先拆题并先做自己的部分，其余成员按顺序补充，最后由统筹者收束。'
          : '并行推进模板：统筹者先拆题并先做自己的部分，其余成员并行补充，最后由统筹者统一汇总。',
      ]),
    ),
  );
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
