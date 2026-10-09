/**
 * 标签页 transcript 与请求消息历史的对齐规划（"prompt cache"）。
 *
 * 抽成独立模块是为了能脱离 express/Playwright 单测——这里每一处分支都是踩坑
 * 踩出来的判定，没测试就没人敢动。
 *
 * 核心问题：请求带过来的 messages，和当前标签页里已经存在的对话历史是什么关系？
 * 决定复用标签页只发增量，还是丢弃重开。
 */

export type NonSystemMessage = { role: 'user' | 'assistant'; content: string; name?: string };

export type SyncMode = 'fresh' | 'append' | 'rebuild';

export type SyncPlan = {
  mode: SyncMode;
  effectiveMessages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
    name?: string;
  }>;
  effectivePromptMode: 'latest-user' | 'trailing-users' | 'full-messages';
  injectSystemOnFirstTurn: boolean;
  cachedMessages: NonSystemMessage[];
  nextCachedMessages: NonSystemMessage[];
  debug: {
    reason:
      | 'no-existing-session'
      | 'empty-cache-with-existing-session'
      | 'strict-append'
      | 'context-window-append'
      | 'stateless-continuation'
      | 'append-blocked-by-assistant-delta'
      | 'context-diverged';
    matchedPrefixCount: number;
    divergenceIndex: number | null;
    deltaCount: number;
    containsSyntheticAssistant: boolean;
    /** 判定为"客户端没有在维护 transcript"的依据。 */
    statelessClient: boolean;
    transcriptMode: 'raw' | 'context-window';
  };
};

/**
 * 比较消息内容时的归一化。
 *
 * bridge 记录的 assistant 内容是**网页里模型实际产出的那段文本**，而调用方
 * 记录的是它自己那份副本。两者只要在空白或 Markdown 排版上有任何差异
 * （尾随空格、CRLF、`**` 强调、列表缩进…），逐字节比较就会判不等，于是
 * 前缀匹配失败 → 误判成换了话题 → 丢弃标签页重开。
 *
 * 这正是"连续消息却每轮重开新会话"的真实成因：不是复用规则不对，
 * 而是等值判定太脆。
 *
 * 只做空白层面的归一化，不动语义内容——`u2` 与 `u3`、`a1` 与 `a2`
 * 依然必然判为不等，换话题的判定不会被削弱。
 */
function normalizeComparableContent(content: string): string {
  // 快速路径：绝大多数消息本来就是干净的，不含 \r、行尾空白或连续空行。
  // 直接返回原字符串，避免 4 个正则扫描 + 一次字符串分配。
  // 在 90 万字符的 transcript 上，这一项省掉约七成开销。
  const needsWork =
    content.includes('\r') ||
    content.includes('\n\n\n') ||
    /[ \t]+\n/.test(content) ||
    content !== content.trim();

  if (!needsWork) {
    return content;
  }

  return content
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function messagesEqual(left: NonSystemMessage, right: NonSystemMessage): boolean {
  if (left.role !== right.role) {
    return false;
  }

  if (normalizeComparableContent(left.content) !== normalizeComparableContent(right.content)) {
    return false;
  }

  if (left.role === 'assistant' && right.role === 'assistant') {
    return true;
  }

  return (left.name ?? '') === (right.name ?? '');
}

function isPrefix(prefix: NonSystemMessage[], all: NonSystemMessage[]): boolean {
  if (prefix.length > all.length) {
    return false;
  }

  return prefix.every((message, index) => messagesEqual(message, all[index]));
}

function getDivergenceIndex(left: NonSystemMessage[], right: NonSystemMessage[]): number | null {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (!messagesEqual(left[index], right[index])) {
      return index;
    }
  }

  return left.length === right.length ? null : commonLength;
}

function getSubsequenceMatchIndexes(
  sequence: NonSystemMessage[],
  target: NonSystemMessage[],
): number[] | null {
  if (sequence.length > target.length) {
    return null;
  }

  const matchedIndexes: number[] = [];
  let sequenceIndex = 0;

  for (
    let targetIndex = 0;
    targetIndex < target.length && sequenceIndex < sequence.length;
    targetIndex += 1
  ) {
    if (messagesEqual(sequence[sequenceIndex], target[targetIndex])) {
      matchedIndexes.push(targetIndex);
      sequenceIndex += 1;
    }
  }

  return sequenceIndex === sequence.length ? matchedIndexes : null;
}

function buildEffectiveMessages(
  system: string | undefined,
  nonSystemMessages: NonSystemMessage[],
): SyncPlan['effectiveMessages'] {
  const messages: SyncPlan['effectiveMessages'] = [];
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  messages.push(...nonSystemMessages);
  return messages;
}

/**
 * 调用方是不是"无状态客户端"（每次只发最新一句 user 消息）。
 *
 * **仅用于诊断上报，不参与任何复用决策。**
 *
 * 曾经有个版本在这里加过规则：判定为无状态客户端时，前缀接不上也不算换话题，
 * 按续聊处理。结果是每发一条新消息都复用上一个标签页——那么 `u1` 之后发
 * `u2` 这种完全无关的两句话也会被塞进同一条对话。
 *
 * 复用与否应当由客户端带回来的历史决定，而不是由 bridge 替客户端猜。
 */
export function isStatelessClient(comparisonMessages: NonSystemMessage[]): boolean {
  return (
    comparisonMessages.length <= 1 && comparisonMessages.every((message) => message.role === 'user')
  );
}

export function createSyncPlan(args: {
  system?: string;
  currentMessages: NonSystemMessage[];
  currentContextMessages: NonSystemMessage[];
  latestUserMessage: NonSystemMessage;
  cachedMessages: NonSystemMessage[];
  hasExistingSession: boolean;
  desiredPromptMode: 'latest-user' | 'trailing-users' | 'full-messages';
  injectSystemOnFirstTurn: boolean;
  transcriptMode: 'raw' | 'context-window';
}): SyncPlan {
  const {
    system,
    currentMessages,
    currentContextMessages,
    latestUserMessage,
    cachedMessages,
    hasExistingSession,
    desiredPromptMode,
    injectSystemOnFirstTurn,
    transcriptMode,
  } = args;

  const appendDeltaMessages =
    transcriptMode === 'context-window'
      ? [...currentContextMessages.slice(cachedMessages.length), latestUserMessage]
      : currentMessages.slice(cachedMessages.length);
  const rebuildNextCachedMessages =
    transcriptMode === 'context-window' ? currentContextMessages : currentMessages;

  if (!hasExistingSession) {
    return {
      mode: 'fresh',
      effectiveMessages: buildEffectiveMessages(system, currentMessages),
      effectivePromptMode: desiredPromptMode,
      injectSystemOnFirstTurn,
      cachedMessages,
      nextCachedMessages: rebuildNextCachedMessages,
      debug: {
        reason: 'no-existing-session',
        matchedPrefixCount: 0,
        divergenceIndex: null,
        deltaCount: currentMessages.length,
        containsSyntheticAssistant: currentMessages.some((message) => message.role === 'assistant'),
        statelessClient: isStatelessClient(currentMessages),
        transcriptMode,
      },
    };
  }

  if (cachedMessages.length === 0) {
    return {
      mode: 'rebuild',
      effectiveMessages: buildEffectiveMessages(system, currentMessages),
      effectivePromptMode: desiredPromptMode,
      injectSystemOnFirstTurn: Boolean(system),
      cachedMessages,
      nextCachedMessages: rebuildNextCachedMessages,
      debug: {
        reason: 'empty-cache-with-existing-session',
        matchedPrefixCount: 0,
        divergenceIndex: 0,
        deltaCount: currentMessages.length,
        containsSyntheticAssistant: currentMessages.some((message) => message.role === 'assistant'),
        statelessClient: isStatelessClient(currentMessages),
        transcriptMode,
      },
    };
  }

  const comparisonMessages =
    transcriptMode === 'context-window' ? currentContextMessages : currentMessages;
  const statelessClient = isStatelessClient(comparisonMessages);
  const matchedIndexes =
    transcriptMode === 'context-window'
      ? getSubsequenceMatchIndexes(cachedMessages, comparisonMessages)
      : isPrefix(cachedMessages, comparisonMessages)
        ? cachedMessages.map((_message, index) => index)
        : null;

  if (matchedIndexes) {
    const matchedIndexSet = new Set(matchedIndexes);
    const deltaMessages =
      transcriptMode === 'context-window'
        ? [
            ...comparisonMessages.filter((_message, index) => !matchedIndexSet.has(index)),
            latestUserMessage,
          ]
        : appendDeltaMessages;
    const containsSyntheticAssistant = deltaMessages.some(
      (message) => message.role === 'assistant',
    );
    const canAppendDelta =
      deltaMessages.length > 0 &&
      (transcriptMode === 'context-window' || !containsSyntheticAssistant);

    if (canAppendDelta) {
      return {
        mode: 'append',
        effectiveMessages: buildEffectiveMessages(undefined, deltaMessages),
        effectivePromptMode: 'trailing-users',
        injectSystemOnFirstTurn: false,
        cachedMessages,
        nextCachedMessages: rebuildNextCachedMessages,
        debug: {
          reason: transcriptMode === 'context-window' ? 'context-window-append' : 'strict-append',
          matchedPrefixCount: cachedMessages.length,
          divergenceIndex: null,
          deltaCount: deltaMessages.length,
          containsSyntheticAssistant,
          statelessClient,
          transcriptMode,
        },
      };
    }

    return {
      mode: 'rebuild',
      effectiveMessages: buildEffectiveMessages(system, currentMessages),
      effectivePromptMode: desiredPromptMode,
      injectSystemOnFirstTurn: Boolean(system),
      cachedMessages,
      nextCachedMessages: rebuildNextCachedMessages,
      debug: {
        reason: 'append-blocked-by-assistant-delta',
        matchedPrefixCount: cachedMessages.length,
        divergenceIndex: null,
        deltaCount: deltaMessages.length,
        containsSyntheticAssistant,
        statelessClient,
        transcriptMode,
      },
    };
  }

  const divergenceIndex = getDivergenceIndex(cachedMessages, comparisonMessages);

  return {
    mode: 'rebuild',
    effectiveMessages: buildEffectiveMessages(system, currentMessages),
    effectivePromptMode: desiredPromptMode,
    injectSystemOnFirstTurn: Boolean(system),
    cachedMessages,
    nextCachedMessages: rebuildNextCachedMessages,
    debug: {
      reason: 'context-diverged',
      matchedPrefixCount:
        divergenceIndex ?? Math.min(cachedMessages.length, comparisonMessages.length),
      divergenceIndex,
      deltaCount: Math.max(0, comparisonMessages.length - cachedMessages.length),
      containsSyntheticAssistant: currentMessages.some((message) => message.role === 'assistant'),
      statelessClient,
      transcriptMode,
    },
  };
}
