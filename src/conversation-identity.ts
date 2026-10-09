/**
 * 会话身份与标签页生命周期的纯逻辑。
 *
 * 背景：这个bridge 之前完全依赖调用方传 conversationId，自己既不检测、
 * 也不校验，于是「第一条新消息开新标签、连续消息复用旧标签」这个预期
 * 实际上并不成立——不传 id 的调用方会把所有消息挤进同一个标签页。
 *
 * 这里抽出的三个函数都是纯函数，方便脱离 Playwright 单测。
 */

/**
 * 从页面 URL 里抽出会话 id。
 *
 * 各家的会话 URL 形态（均为实测值）：
 * - chatgpt   https://chatgpt.com/c/<uuid>
 * - gemini    https://gemini.google.com/app/<id>
 * - claude    https://claude.ai/chat/<uuid>   （/new 不是会话页）
 * - grok      https://grok.com/c/<uuid>
 * - qwen      https://chat.qwen.ai/c/<uuid>
 * - deepseek  https://chat.deepseek.com/a/chat/s/<uuid>
 *
 * 抽到 id 的意义：bridge 可以把它回给调用方，调用方下一次带上它就等于
 * "继续这条对话"，bridge 据此复用同一个标签页。这样「是否连续」由调用方
 * 显式决定，而不需要 bridge 靠启发式去猜。
 */
export function extractConversationId(
  url: string | undefined | null,
  conversationUrlPattern?: string,
): string | undefined {
  if (!url || !conversationUrlPattern) {
    return undefined;
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(conversationUrlPattern);
  } catch {
    // 配置写坏了不应该让整次请求失败，只是拿不到会话 id。
    return undefined;
  }

  const matched = pattern.exec(url);
  const captured = matched?.[1];
  return captured ? captured : undefined;
}

function hostname(url: string): string {
  const value = url.trim().toLowerCase();
  const schemeEnd = value.indexOf('://');
  const afterScheme = schemeEnd === -1 ? value : value.slice(schemeEnd + 3);
  const slash = afterScheme.indexOf('/');
  const hostAndPort = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  const lastColon = hostAndPort.lastIndexOf(':');
  const withoutPort = lastColon === -1 ? hostAndPort : hostAndPort.slice(0, lastColon);
  return withoutPort.replace(/^\[|\]$/g, '');
}

/**
 * 判断某个 URL 是否还属于该 provider 的站点。
 *
 * 用途：复用一个已存在的标签页之前必须校验。用户完全可能手动在那个标签页里
 * 点进别的对话，或者导航到别的站点；不校验就会静默往错误的页面里写消息，
 * 而 bridge 自己的 transcript 还以为一切正常。
 */
export function isSameProviderHost(url: string | undefined | null, providerUrl: string): boolean {
  if (!url) {
    return false;
  }

  return hostname(url) === hostname(providerUrl);
}

export type EvictableSession = {
  key: string;
  providerId: string;
  lastUsedAt: number;
  pageClosed: boolean;
};

export type EvictionPolicy = {
  now: number;
  /** 闲置超过此时长的会话会被回收。 */
  idleMs: number;
  /** 每个 provider 最多保留多少个标签页。 */
  maxPerProvider: number;
  /** 永不回收的 key（通常是正在使用的那个）。 */
  keepKey?: string;
};

/**
 * 选出应该被回收的会话 key。
 *
 * 之前 createdAt / lastUsedAt 只是记下来给 /sessions 列表看，从不参与任何
 * 决策，于是标签页无限累积。这里给出回收策略：
 * 1. 页面已经关掉的条目直接清掉（Map 里留着就是纯粹的内存泄漏）
 * 2. 闲置超时的回收
 * 3. 仍然超过上限时，按最久未使用从旧到新继续回收
 *
 * keepKey 指向的会话永远不回收，避免把正在用的页面关掉。
 */
export function selectSessionsToEvict(
  sessions: readonly EvictableSession[],
  policy: EvictionPolicy,
): string[] {
  const { now, idleMs, maxPerProvider, keepKey } = policy;
  const evicted = new Set<string>();

  for (const session of sessions) {
    if (session.pageClosed && session.key !== keepKey) {
      evicted.add(session.key);
    }
  }

  const byProvider = new Map<string, EvictableSession[]>();
  for (const session of sessions) {
    if (evicted.has(session.key) || session.key === keepKey) {
      continue;
    }
    const list = byProvider.get(session.providerId) ?? [];
    list.push(session);
    byProvider.set(session.providerId, list);
  }

  for (const list of byProvider.values()) {
    const oldestFirst = [...list].sort((left, right) => left.lastUsedAt - right.lastUsedAt);

    for (const session of oldestFirst) {
      if (now - session.lastUsedAt >= idleMs) {
        evicted.add(session.key);
      }
    }

    const remaining = oldestFirst.filter((session) => !evicted.has(session.key));
    const overflow = remaining.length - Math.max(maxPerProvider, 0);
    if (overflow > 0) {
      for (const session of remaining.slice(0, overflow)) {
        evicted.add(session.key);
      }
    }
  }

  return [...evicted];
}
