/**
 * 真流捕获：直接读网页自己收到的那条 SSE，而不是从 DOM 里猜哪个块是答案。
 *
 * 为什么不注入 JS：`page.addInitScript` 劫持 `window.fetch` 会被指纹检测发现
 * （`String(window.fetch)` 暴露的不是 native code）。这里走 Playwright 自己的
 * `page.on('response')` + `response.body()`，页面里一行代码都不插，站点无从检测。
 *
 * 代价：拿不到"进行中"的帧，只能等请求结束，所以**没有真首字延迟**。
 * 但换来的三样东西很值：
 *   1. 正文与思考内容由协议里的 phase 字段区分，不再靠猜 DOM 块
 *   2. 拿到真实 token 计数（原来硬编码为 0）
 *   3. 能拿到站点自己的会话 id
 *
 * 真 TTFT 需要别的路子（页面注入，或不用 Playwright 自带的网络层），
 * 属于另一个决策，暂不在此实现。
 */

export type StreamUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
};

export type ReducedStream = {
  content: string;
  reasoningContent: string;
  usage?: StreamUsage;
  conversationId?: string;
  /** 站点是否明确表示这一轮生成结束。比"DOM 连续三轮不变"可靠得多。 */
  finished: boolean;
};

/**
 * 从完整的 SSE 响应体里取出各个 `data:` 负载。
 *
 * 实测帧尾会带一个空格（`...}} \n\n`），所以每段都要 trim。
 */
export function parseSseFrames(text: string): string[] {
  if (!text) {
    return [];
  }

  const frames: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const trimmed = block.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    frames.push(payload);
  }

  return frames;
}

/**
 * 按 `event:` / `data:` 配对切分 SSE 块。
 *
 * 与 `parseSseFrames` 的区别：那个假设 `data:` 在块首（Qwen / DeepSeek / Grok 确实如此），
 * 但 ChatGPT 的补丁帧前面还带一行 `event: delta`，按块首过滤会把**正文帧整个丢掉**。
 * 这里把两者都取出来，事件名放进 `event`。
 */
export function parseSseEvents(text: string): SseEvent[] {
  if (!text) {
    return [];
  }

  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    let event = '';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length === 0) {
      continue;
    }
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') {
      continue;
    }
    events.push({ event, data });
  }

  return events;
}

/**
 * 归约 Qwen 的帧序列。
 *
 * 帧形态（2026-10 实测 `POST /api/v2/chat/completions?chat_id=...`）：
 *   {"response.created":{"chat_id":"…","response_id":"…"}}
 *   {"choices":[{"delta":{"role":"assistant","content":"",
 *      "phase":"thinking_summary",
 *      "extra":{"summary_title":{"content":["…"]},
 *               "summary_thought":{"content":["…"]}},
 *      "status":"typing"}}],"usage":{…}}
 *   {"choices":[{"delta":{…,"phase":"thinking_summary","status":"finished"}}]}
 *   {"choices":[{"delta":{"content":"蓝","phase":"answer","status":"typing"}}],"usage":{…}}
 *   {"choices":[{"delta":{…,"phase":"answer","status":"finished"}}]}
 *
 * **去重必须按 `extra` 的内容，而不是按整帧。** 实测同一段思考会以近乎相同的帧
 * 重复下发（只有 usage 在增长），按整帧去重会漏掉新的思考片段，按 extra 内容去重
 * 才既不重复累加、又不会丢内容。
 */
export function reduceQwenStream(frames: readonly string[]): ReducedStream | undefined {
  let content = '';
  const reasoningLines: string[] = [];
  /**
   * 只记住**上一条** extra 的内容，用来识别相邻重复帧。
   *
   * 为什么不做全局去重：实测 Qwen 会把累积状态原样重发（相邻两帧 extra 完全相同，
   * 只有 usage 在增长），但思考真正增长时又会给出一个**不同的** extra——
   * 冒泡那次标题逐帧变化就是证据。用全局 Set 会把模型在不同阶段合法重复的句子
   * 也吞掉，甚至拼出一段"从未真实存在过"的思考记录。
   *
   * 相邻去重既能消掉重复下发，又不会误伤非相邻的重复。
   */
  let lastExtraKey: string | undefined;
  /**
   * 生成与键顺序无关的规范键。
   *
   * `JSON.stringify` 是**键顺序敏感**的：站点把同一个对象换个键序序列化，
   * key 就对不上，相邻去重会直接失效（重复的思考被记两遍）。所以这里先递归排序。
   */
  const canonicalize = (input: unknown): string => {
    if (Array.isArray(input)) {
      return `[${input.map(canonicalize).join(',')}]`;
    }
    if (input && typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
    }
    return JSON.stringify(input) ?? 'null';
  };
  /**
   * 标题按"相邻去重"处理，而思考内容不做。
   *
   * `summary_title` 是当前阶段的**标签**，不是累积内容——跨阶段重复同一句标题
   * 就是噪声。而 `summary_thought` 是内容，模型在不同阶段说出同一句话是合法的，
   * 吞掉会造成失真。两者用不同规则，是按字段性质区分，不是随手定的。
   */
  let lastTitleLine: string | undefined;
  let usage: StreamUsage | undefined;
  let conversationId: string | undefined;
  let finished = false;
  let parsedAny = false;

  for (const frame of frames) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      continue;
    }
    parsedAny = true;

    const created = parsed['response.created'] as { chat_id?: string } | undefined;
    if (created?.chat_id) {
      conversationId = created.chat_id;
    }

    const rawUsage = parsed['usage'];
    if (rawUsage && typeof rawUsage === 'object') {
      const u = rawUsage as Record<string, unknown>;
      const outputDetails = u['output_tokens_details'] as { reasoning_tokens?: number } | undefined;
      usage = {
        prompt_tokens: Number(u['input_tokens'] ?? 0),
        completion_tokens: Number(u['output_tokens'] ?? 0),
        total_tokens: Number(u['total_tokens'] ?? 0),
        ...(typeof outputDetails?.reasoning_tokens === 'number'
          ? { reasoning_tokens: outputDetails.reasoning_tokens }
          : {}),
      };
    }

    const choices = parsed['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      continue;
    }

    const delta = (choices[0] as { delta?: Record<string, unknown> } | undefined)?.delta;
    if (!delta) {
      continue;
    }

    const phase = typeof delta['phase'] === 'string' ? delta['phase'] : '';
    const status = delta['status'];

    if (status === 'finished') {
      finished = true;
    }

    const extra = delta['extra'];
    if (extra && typeof extra === 'object') {
      const key = canonicalize(extra);
      if (key !== lastExtraKey) {
        lastExtraKey = key;
        for (const field of ['summary_title', 'summary_thought'] as const) {
          const bucket = (extra as Record<string, unknown>)[field] as
            | { content?: unknown }
            | undefined;
          const items = bucket?.content;
          if (!Array.isArray(items)) {
            continue;
          }
          for (const item of items) {
            if (typeof item !== 'string') {
              continue;
            }
            const text = item.trim();
            if (!text) {
              continue;
            }
            if (field === 'summary_title') {
              if (text === lastTitleLine) {
                continue;
              }
              lastTitleLine = text;
            }
            reasoningLines.push(text);
          }
        }
      }
    }

    if (phase === 'answer' && typeof delta['content'] === 'string' && delta['content']) {
      content += delta['content'];
    }
  }

  if (!parsedAny) {
    return undefined;
  }

  return {
    content,
    reasoningContent: reasoningLines.join('\n'),
    ...(usage ? { usage } : {}),
    ...(conversationId ? { conversationId } : {}),
    finished,
  };
}

type DeepseekFragment = { id?: number; type?: string; content?: string };

/**
 * 归约 DeepSeek 的帧序列——**补丁状态机，不做累加猜测**。
 *
 * DeepSeek 的协议（2026-10 实测 `POST /api/v0/chat/completion`，184 帧）：
 *   {"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"我们需要"}],"status":"WIP"}}}
 *   {"v":"用户"} {"v":"中文"} …                     ← 179 个裸值帧，逐 token 追加到最后一个 fragment
 *   {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"碧"}]}
 *   {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":64}]}
 *   {"p":"response/status","o":"SET","v":"FINISHED"}
 *
 * 关键在于它是**带路径的补丁**，不是裸 delta：路径能精确定位到
 * `response/fragments/-1/content`。所以做法是"应用补丁得到最终状态、再读状态"，
 * 而不是"累加 token 再想办法去重"——后者才是需要启发式、也是最容易出错的地方。
 *
 * `fragments[].type` 原生区分 THINK / RESPONSE，思考与回答不用猜。
 */
export function reduceDeepseekStream(frames: readonly string[]): ReducedStream | undefined {
  type ResponseState = {
    status?: string;
    accumulated_token_usage?: number;
    fragments?: DeepseekFragment[];
  };

  let state: ResponseState | undefined;
  let sawFrame = false;

  /** 补丁寻址过程中会被当作普通容器读写的值。 */
  type PatchContainer = Record<string, unknown> | unknown[];

  function lengthOf(container: PatchContainer): number {
    return Array.isArray(container) ? container.length : 0;
  }

  function readKey(container: PatchContainer, key: string | number): unknown {
    if (Array.isArray(container)) {
      return typeof key === 'number' ? container[key] : undefined;
    }
    return container[String(key)];
  }

  function writeKey(container: PatchContainer, key: string | number, value: unknown): void {
    if (Array.isArray(container)) {
      container[Number(key)] = value;
      return;
    }
    container[String(key)] = value;
  }

  const resolvePath = (
    root: ResponseState,
    rawPath: unknown,
  ): { holder: PatchContainer; key: string | number } => {
    if (typeof rawPath !== 'string') {
      return { holder: {}, key: '' };
    }
    // 注意：不能用 path.trim('/') —— String.prototype.trim 的标准签名是零参数，
    // 传字符集是非标准行为（V8 能跑，但类型不过且语义可疑）。
    const parts = rawPath
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean);
    if (parts[0] === 'response') {
      parts.shift();
    }
    let holder = root as unknown as PatchContainer;
    for (const part of parts.slice(0, -1)) {
      const next = readKey(holder, part.startsWith('-') ? lengthOf(holder) + Number(part) : part);
      if (next === null || typeof next !== 'object') {
        return { holder: {}, key: '' };
      }
      holder = next as PatchContainer;
    }
    const last = parts[parts.length - 1] ?? '';
    const key = last.startsWith('-') ? lengthOf(holder) + Number(last) : last;
    return { holder, key };
  };

  for (const frame of frames) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      continue;
    }
    const value = parsed?.v;
    if (value === undefined) {
      continue;
    }
    sawFrame = true;

    // 完整快照：重置状态
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const snapshot = (value as Record<string, unknown>)['response'];
      if (snapshot && typeof snapshot === 'object') {
        state = snapshot as ResponseState;
        continue;
      }
    }

    if (!state) {
      continue;
    }

    // 裸值帧：追加到最后一个 fragment 的 content
    if (!parsed.p) {
      if (typeof value === 'string') {
        const fragments = state.fragments;
        const lastFragment = Array.isArray(fragments) ? fragments[fragments.length - 1] : undefined;
        if (lastFragment && typeof lastFragment === 'object') {
          lastFragment.content = `${lastFragment.content ?? ''}${value}`;
        }
      }
      continue;
    }

    const operation = parsed.o as string | undefined;

    if (operation === 'BATCH' && Array.isArray(value)) {
      for (const item of value) {
        if (!item?.p) {
          continue;
        }
        const { holder, key } = resolvePath(state, item.p);
        writeKey(holder, key, item.v);
      }
      continue;
    }

    const { holder, key } = resolvePath(state, parsed.p);
    const current = readKey(holder, key);

    // 列表追加：实测 `APPEND response/fragments` 的值本身是数组。
    // 这一步必须排在字符串分支之前，否则会把整个 fragments 数组拼成字符串。
    if (Array.isArray(current)) {
      if (Array.isArray(value)) {
        current.push(...value);
      } else {
        current.push(value);
      }
      continue;
    }
    if (operation === 'SET') {
      writeKey(holder, key, value);
    } else if (operation === 'APPEND') {
      const appended = typeof value === 'string' ? value : JSON.stringify(value);
      writeKey(holder, key, `${typeof current === 'string' ? current : ''}${appended}`);
    }
  }

  if (!sawFrame || !state) {
    return undefined;
  }

  const fragments = state.fragments ?? [];
  const thinking = fragments
    .filter((fragment) => fragment.type === 'THINK')
    .map((fragment) => (fragment.content ?? '').trim())
    .filter(Boolean)
    .join('\n');
  const answer = fragments
    .filter((fragment) => fragment.type !== 'THINK')
    .map((fragment) => (fragment.content ?? '').trim())
    .filter(Boolean)
    .join('\n');

  const totalTokens =
    typeof state.accumulated_token_usage === 'number' ? state.accumulated_token_usage : undefined;

  return {
    content: answer,
    reasoningContent: thinking,
    ...(totalTokens !== undefined
      ? {
          usage: {
            prompt_tokens: 0,
            completion_tokens: totalTokens,
            total_tokens: totalTokens,
          },
        }
      : {}),
    finished: state.status === 'FINISHED',
  };
}

/**
 * 归约 Grok 的 WebSocket 帧——**OpenAI Responses API 形状**。
 *
 * Grok 走 `wss://grok.com/ws/mgw/`，每帧是一个 JSON 事件（2026-10 实测 30 帧）：
 *   {"event":{"type":"conversation.attached","conversation":{"id":"a995b242-…"}}}
 *   {"event":{"type":"response.created","response":{"status":"in_progress"}}}
 *   {"event":{"type":"response.chunk","chunk":{"text":{"text":"**","channel":"CHANNEL_ASSISTANT_RESPONSE"}}}}
 *   {"event":{"type":"response.chunk","chunk":{"phase_marker":{"kind":"KIND_THINKING_START"}}}}
 *   {"event":{"type":"response.done","response":{"status":"completed"}}}
 *
 * 两个关键性质：
 *
 * 1. **正文是纯 token 增量、只追加。** 实测连续三帧是 `**`、`白`、`**`。
 *    没有 Qwen 那种"原样重发累积状态"，所以**完全不需要去重启发式**——
 *    这正是 WebSocket 协议相对 HTTP SSE 的优势。
 *
 * 2. **思考与回答靠 `channel` 原生区分**：
 *    `CHANNEL_ASSISTANT_RESPONSE` 是正文，`CHANNEL_ASSISTANT_NOTETAKER_HEADER` 是思考摘要，
 *    另有 `phase_marker` 显式标记 THINKING_START / RESPONSE_START 作双保险。
 *
 * 另外，WebSocket 帧是**实时事件**（Playwright 的 `framereceived`），
 * 所以这条路径存在真首字延迟的可能——与 Qwen / DeepSeek 不同。
 */
export function reduceGrokStream(frames: readonly string[]): ReducedStream | undefined {
  let content = '';
  const reasoningLines: string[] = [];
  let conversationId: string | undefined;
  let finished = false;
  let sawFrame = false;

  for (const frame of frames) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawFrame = true;

    const envelope = parsed['event'];
    if (!envelope || typeof envelope !== 'object') {
      continue;
    }
    const event = envelope as Record<string, unknown>;
    const type = event['type'];

    if (type === 'conversation.attached') {
      const conversation = event['conversation'] as { id?: string } | undefined;
      if (conversation?.id) {
        conversationId = conversation.id;
      }
      continue;
    }

    if (type === 'response.done') {
      const response = event['response'] as { status?: string } | undefined;
      finished = response?.status === 'completed' || finished;
      continue;
    }

    if (type !== 'response.chunk') {
      continue;
    }

    const chunk = event['chunk'] as { text?: { text?: string; channel?: string } } | undefined;
    const text = chunk?.text?.text;
    if (typeof text !== 'string' || !text) {
      continue;
    }

    if (chunk?.text?.channel === 'CHANNEL_ASSISTANT_NOTETAKER_HEADER') {
      // 同样按行拆开：实测单帧可能含多行，整帧 push 会让 join('\n') 多出一层换行。
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          reasoningLines.push(trimmed);
        }
      }
      continue;
    }

    // 其余 channel 一律当正文：只追加，不做任何去重或替换
    content += text;
  }

  if (!sawFrame) {
    return undefined;
  }

  return {
    content,
    reasoningContent: reasoningLines.join('\n'),
    ...(conversationId ? { conversationId } : {}),
    finished,
  };
}

export type LiveDelta = {
  /** 这一帧新增的正文片段 */
  contentDelta?: string;
  /** 这一帧新增的思考片段（按行） */
  reasoningDelta?: string;
};

/**
 * Grok 帧的增量累加器：**边到边出 delta**。
 *
 * 这是真流式的关键。`reduceGrokStream` 是一次性归约整批帧，适合"生成完了才取"
 * 的场景；而 WebSocket 帧是实时事件，所以要能一帧一帧喂进来、立刻吐出新增文本。
 *
 * Grok 的正文是纯 token 增量且只追加，所以"这一帧新增了什么"就是这一帧的 text，
 * 不需要任何 diff 或去重。思考通道同理。
 */
export function createGrokAccumulator(): {
  push: (frame: string) => LiveDelta & { finished?: boolean };
  snapshot: () => ReducedStream;
} {
  let content = '';
  const reasoningLines: string[] = [];
  let conversationId: string | undefined;
  let finished = false;

  return {
    push(frame: string) {
      const before = { contentLength: content.length, reasoningLineCount: reasoningLines.length };

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(frame) as Record<string, unknown>;
      } catch {
        return {};
      }
      const envelope = parsed['event'];
      if (!envelope || typeof envelope !== 'object') {
        return {};
      }
      const event = envelope as Record<string, unknown>;
      const type = event['type'];

      if (type === 'conversation.attached') {
        const conversation = event['conversation'] as { id?: string } | undefined;
        if (conversation?.id) {
          conversationId = conversation.id;
        }
        return {};
      }
      if (type === 'response.done') {
        const response = event['response'] as { status?: string } | undefined;
        if (response?.status === 'completed') {
          finished = true;
        }
        return finished ? { finished: true } : {};
      }
      if (type !== 'response.chunk') {
        return {};
      }

      const chunk = event['chunk'] as { text?: { text?: string; channel?: string } } | undefined;
      const text = chunk?.text?.text;
      if (typeof text !== 'string' || !text) {
        return {};
      }

      const isReasoning = chunk?.text?.channel === 'CHANNEL_ASSISTANT_NOTETAKER_HEADER';
      if (isReasoning) {
        // 实测 Grok 的思考通道**单帧可能含多行**。按整帧 push 会把多行当成一个
        // 数组元素，后面 join('\n') 就多出一层换行。这里先按行拆开。
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            reasoningLines.push(trimmed);
          }
        }
      } else {
        content += text;
      }

      const delta: LiveDelta = {};
      if (content.length > before.contentLength) {
        delta.contentDelta = content.slice(before.contentLength);
      }
      // 思考是"按行追加"的，一帧就是一行，所以这一帧新增的思考就是最后一行。
      if (reasoningLines.length > before.reasoningLineCount && reasoningLines.at(-1)) {
        delta.reasoningDelta = reasoningLines.at(-1);
      }
      return delta;
    },

    snapshot() {
      return {
        content,
        reasoningContent: reasoningLines.join('\n'),
        ...(conversationId ? { conversationId } : {}),
        finished,
      };
    },
  };
}

/**
 * ChatGPT 的 SSE 分帧。
 *
 * ChatGPT 的帧是 `event:` 与 `data:` 成对的，**且 `data:` 常常不在块首**。只按
 * "块首是 data:" 来切会漏掉带 `event: delta` 的补丁帧——而正文恰好就在那些帧里。
 * 所以这里按 event/data 配对切，并单独给出事件名。
 */
export type SseEvent = {
  event: string;
  data: string;
};

/**
 * 归约 ChatGPT 的帧序列。
 *
 * 端点是 `POST /backend-api/f/conversation`（`f` = 前端专用），返回 text/event-stream。
 * 帧形态（2026-10 实测）：
 *   event: delta_encoding   data: "v1"
 *   data: {"type":"resume_conversation_token","kind":"topic","token":"…","conversation_id":"…"}
 *   event: delta  data: {"p":"","o":"add","v":{"message":{"author":{"role":"user"},…}}}
 *   event: delta  data: {"v":{"message":{"author":{"role":"assistant"},…}}}      ← 无 p/o，整条替换当前 message
 *   event: delta  data: {"p":"/message/content/parts/0","o":"append","v":"**凛**。"}
 *   event: delta  data: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace",
 *                                                      "v":"finished_successfully"},…]}
 *   data: {"type":"message_stream_complete","conversation_id":"…"}
 *   data: [DONE]
 *
 * 与 DeepSeek 同为补丁协议，但有两处关键差异：
 *   1. `p` 为空字符串 + `o:"add"` 表示**新增一条 message**（换人/换角色），
 *      此时 `v.message.author.role` 决定这条是谁的。
 *   2. 正文会重新下发：先 `add` 一条 role=assistant 的 message（parts 为空串），
 *      之后正文靠 `/message/content/parts/0` 的 `append` 累积。
 *      所以**只认最后一条 assistant message**，并且要用补丁重建它，不能拼接所有 append。
 */
export function reduceChatgptStream(frames: readonly string[]): ReducedStream | undefined {
  type Message = {
    role?: string;
    parts: string[];
    reasoning: string[];
    status?: string;
  };

  const messages: Message[] = [];
  let conversationId: string | undefined;
  let finished = false;
  let sawFrame = false;

  const lastIndex = (role: string): number => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === role) {
        return i;
      }
    }
    return -1;
  };

  const blank = (role?: string): Message => ({ role, parts: [], reasoning: [] });

  /** 把一条补丁应用到目标 message 上。路径形如 `/message/content/parts/0`。 */
  const applyPatch = (message: Message, path: string, op: string | undefined, value: unknown) => {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'message') {
      return;
    }
    // /message/content/parts/N —— 正文
    if (parts[1] === 'content' && parts[2] === 'parts' && typeof parts[3] === 'string') {
      const index = Number(parts[3]);
      if (op === 'append' && typeof value === 'string') {
        message.parts[index] = (message.parts[index] ?? '') + value;
      } else if (op === 'replace' && typeof value === 'string') {
        message.parts[index] = value;
      }
      return;
    }
    // /message/content/reasoning/summary/N —— 思考摘要
    if (parts[1] === 'content' && parts[2] === 'reasoning') {
      const text = typeof value === 'string' ? value : '';
      if (!text) {
        return;
      }
      if (Array.isArray(value)) {
        message.reasoning.push(...value.filter((v): v is string => typeof v === 'string'));
      } else {
        message.reasoning.push(text);
      }
      return;
    }
    if (parts[1] === 'status' && typeof value === 'string') {
      message.status = value;
    }
  };

  const ingest = (raw: unknown): void => {
    if (typeof raw === 'string') {
      return;
    }
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const frame = raw as Record<string, unknown>;

    // 顶层类型帧
    const type = frame['type'];
    if (typeof type === 'string') {
      sawFrame = true;
      if (type === 'resume_conversation_token') {
        const id = frame['conversation_id'];
        if (typeof id === 'string') {
          conversationId = id;
        }
      }
      if (type === 'message_stream_complete') {
        finished = true;
      }
      return;
    }

    const path = frame['p'];
    const op = frame['o'];
    const value = frame['v'];

    // 整条新增 message
    if (path === '' && op === 'add' && value && typeof value === 'object') {
      sawFrame = true;
      const incoming = value as { message?: { author?: { role?: string }; status?: string } };
      messages.push(blank(incoming.message?.author?.role));
      return;
    }

    // 整条替换当前 message（无 p 无 o，只有 v.message）
    if (path === undefined && op === undefined && value && typeof value === 'object') {
      const incoming = value as { message?: { author?: { role?: string }; status?: string } };
      if (incoming.message?.author?.role) {
        sawFrame = true;
        messages.push(blank(incoming.message.author.role));
      }
      return;
    }

    // 批量补丁
    if (path === '' && op === 'patch' && Array.isArray(value)) {
      sawFrame = true;
      for (const item of value) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const patch = item as { p?: string; o?: string; v?: unknown };
        const index = lastIndex('assistant');
        if (index >= 0 && patch.p) {
          applyPatch(messages[index], patch.p, patch.o, patch.v);
        }
      }
      return;
    }

    // 单条补丁
    if (typeof path === 'string' && path.startsWith('/message/')) {
      sawFrame = true;
      const index = lastIndex('assistant');
      if (index >= 0) {
        applyPatch(messages[index], path, typeof op === 'string' ? op : undefined, value);
      }
    }
  };

  for (const frame of frames) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      continue;
    }
    ingest(parsed);
  }

  if (!sawFrame) {
    return undefined;
  }

  const index = lastIndex('assistant');
  const answer = index >= 0 ? messages[index] : undefined;
  const content = (answer?.parts[0] ?? '').trim();
  const reasoningContent = (answer?.reasoning ?? []).join('\n');

  if (!content && !reasoningContent && !finished) {
    return undefined;
  }

  return {
    content,
    reasoningContent,
    ...(conversationId ? { conversationId } : {}),
    finished: finished || answer?.status === 'finished_successfully',
  };
}

/**
 * 归约 Claude 的会话快照 JSON。
 *
 * **为什么 Claude 不用 SSE**：实测 `POST /chat_conversations/…` 那条 text/event-stream
 * 的 `content_block_delta` 里，中文是**坏的**——`静`（U+9759，UTF-8 为 E9 9D 99）
 * 取出来变成 `é<U+009D>™`，正是 UTF-8 字节被按 CP1252 逐字节误解码的特征
 * （CP1252 里 0x99 正是 ™）。而同一时刻的会话 JSON 端点里，文字完全正确。
 * 既然 JSON 端点更准，就不该再从坏掉的 SSE 里凑。
 *
 * 形态（2026-10 实测 `GET /api/organizations/{org}/chat_conversations/{id}?rendering_mode=raw`）：
 *   {
 *     "uuid":"…","model":"claude-sonnet-5-5",
 *     "current_leaf_message_uuid":"…",
 *     "chat_messages":[
 *       {"sender":"human","content":[{"type":"text","text":"用一个字形容雪"}],…},
 *       {"sender":"assistant","stop_reason":"end_turn",
 *        "content":[{"type":"text","text":"**静**\n\n雪落无声…"}],…}]}
 *
 * 思考内容在 `content[].type === "thinking"` 的块里，`thinking` 字段是正文
 * （可能带 `signature`）。因为 JSON 是完整快照，不需要任何归约——直接取最后一条
 * assistant 消息即可，这也是它比流式归约更可靠的地方。
 */
export function reduceClaudeConversation(body: string): ReducedStream | undefined {
  if (!body) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const conversation = parsed as {
    uuid?: unknown;
    chat_messages?: unknown;
    current_leaf_message_uuid?: unknown;
  };

  const messages = conversation.chat_messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }

  let assistant: { content?: unknown; stop_reason?: unknown } | undefined;
  for (const item of messages) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const message = item as { sender?: unknown; content?: unknown; stop_reason?: unknown };
    if (message.sender === 'assistant') {
      assistant = message;
    }
  }
  if (!assistant || !Array.isArray(assistant.content)) {
    return undefined;
  }

  const answerParts: string[] = [];
  const thinkingParts: string[] = [];
  for (const block of assistant.content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const typed = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      answerParts.push(typed.text);
    } else if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
      thinkingParts.push(typed.thinking);
    }
  }

  const content = answerParts.join('').trim();
  const reasoningContent = thinkingParts.join('\n').trim();
  if (!content && !reasoningContent) {
    return undefined;
  }

  const conversationId = typeof conversation.uuid === 'string' ? conversation.uuid : undefined;

  return {
    content,
    reasoningContent,
    ...(conversationId ? { conversationId } : {}),
    finished: true,
  };
}

/**
 * Gemini 的 `batchexecute` 分帧。
 *
 * 回包形状（2026-10 实测 `…/BardFrontendService/StreamGenerate`）：
 *   )]}'\n
 *   <若干个「<数字>\n<JSON 数组>」并列而成>
 *
 * **那个数字不能用。** 实测第一帧声明 177 字节、实际 175，后续帧也都对不上，
 * 没有任何统一偏移能让切出来的块成为合法 JSON。所以这里不按长度切，改成按
 * **方括号配平**找每个顶层数组的边界——JSON 字符串内部的括号会跳过。
 */
export function splitGeminiFrames(body: string): string[] {
  if (!body) {
    return [];
  }

  // )]}' 是 Google 的 XSSI 前缀，去掉后按 [[ 起始位置扫描
  const marker = body.indexOf(')]}');
  const region = marker === -1 ? body : body.slice(marker + 4);

  const frames: string[] = [];
  let cursor = 0;
  while (cursor < region.length) {
    const start = region.indexOf('[[', cursor);
    if (start === -1) {
      break;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < region.length; i += 1) {
      const ch = region[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '[') {
        depth += 1;
      } else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) {
      break;
    }
    frames.push(region.slice(start, end));
    cursor = end;
  }

  return frames;
}

/** 在内层结构里按形状找答案，而不是写死下标。 */
function findGeminiAnswer(inner: unknown): { text: string; conversationId?: string } {
  const isStringArrayPair = (value: unknown): value is string[] =>
    Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string';

  let answer = '';

  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      // 模型输出块的形状：["rc_xxxxxxxx", [ ..., [ "...正文..." ], ... ], ...]
      // 用 "rc_" 前缀定位，因为正文块的锚点是随机会话 id，而下标在
      // 不同字段之间并不一致（正文在 [4]，标题却在 [2]）。
      if (typeof node[0] === 'string' && node[0].startsWith('rc_')) {
        const payload = node[1];
        if (Array.isArray(payload) && typeof payload[0] === 'string') {
          if (payload[0].length > answer.length) {
            answer = payload[0];
          }
        }
      }
      for (const child of node) {
        walk(child, depth + 1);
      }
    }
  };

  walk(inner, 0);

  const pair = Array.isArray(inner) ? inner[1] : null;
  const conversationId = isStringArrayPair(pair) ? pair[0] : undefined;

  return { text: answer, ...(conversationId ? { conversationId } : {}) };
}

/**
 * 归约 Gemini 的 `batchexecute` 回包。
 *
 * **每一帧都是累积的完整状态**，不是增量（实测内层长度从 141 单调涨到 7217，
 * 正文越来越长）。所以取**最后一帧带正文的**就是完整答案——不需要拼接，
 * 也不需要任何去重启发式。
 *
 * 这与 DeepSeek/ChatGPT 的补丁协议正好相反：那两家要应用补丁重建状态，
 * Gemini 只要最后一份快照。
 */
export function reduceGeminiStream(body: string): ReducedStream | undefined {
  let best: { text: string; conversationId?: string } | undefined;
  let sawError: string | undefined;
  let sawFrame = false;

  for (const frame of splitGeminiFrames(body)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      continue;
    }

    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (!Array.isArray(row)) {
        continue;
      }
      // ["di", n] 是耗时统计；["e", n, ...] 是结束标记，都不是 wrb.fr
      if (row[0] === 'e') {
        continue;
      }
      const innerRaw = row[2];
      if (typeof innerRaw !== 'string') {
        continue;
      }
      sawFrame = true;

      // 配额/风控等错误也走这里：BardErrorInfo 会被塞进同一层
      if (innerRaw.includes('BardErrorInfo')) {
        const code = /BardErrorInfo",\s*\[(\d+)\]/.exec(innerRaw);
        sawError = `Gemini 返回错误码 ${code ? code[1] : '未知'}（配额、风控或网络）`;
        continue;
      }

      let inner: unknown;
      try {
        inner = JSON.parse(innerRaw);
      } catch {
        continue;
      }
      const found = findGeminiAnswer(inner);
      if (found.text && (!best || found.text.length > best.text.length)) {
        best = found;
      }
    }
  }

  if (!sawFrame) {
    return undefined;
  }

  if (!best?.text) {
    if (sawError) {
      throw new Error(sawError);
    }
    return undefined;
  }

  return {
    content: best.text,
    reasoningContent: '',
    ...(best.conversationId ? { conversationId: best.conversationId } : {}),
    finished: true,
  };
}
