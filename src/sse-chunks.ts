/**
 * SSE 兼容输出。
 *
 * 重要前提：这里**不是**真流式。bridge 是驱动 DOM 再轮询的，本身没有 token 流
 * 可以转发（见 README「流式」一节）。所以本模块的语义是：
 *
 *   等答案完全稳定之后，再把它切块吐出去。
 *
 * 目的是**协议兼容**——有些客户端硬要求 `text/event-stream` 才肯连接。收益是
 * API 形状对得上，代价是没有首字延迟（TTFT）。别把它当成流式来宣传。
 *
 * 另外，SSE 的 delta 语义是只追加，而网页 DOM 在生成过程中会重排、改写、
 * 插入再替换思考块。因此**不能**靠"对比前后两次快照"来伪造增量：那会要求
 * 表达"删除/替换"，而 delta 格式里没有这个操作。要么重复发全文，要么假装
 * 没发生过，两种都是错的。真流式只能去读网页自己收到的那条流。
 */

/** 每块大致多少个 Unicode 码点。 */
export const DEFAULT_CHUNK_CODE_POINTS = 60;

/**
 * 按码点切块。
 *
 * 必须按码点而不是按 `String.slice` 的 UTF-16 码元切，否则会把 emoji、
 * 增补平面汉字这类代理对劈成两半，客户端拼出来就是乱码。
 */
export function splitIntoChunks(text: string, size: number = DEFAULT_CHUNK_CODE_POINTS): string[] {
  if (!text) {
    return [];
  }

  const effectiveSize = Math.max(1, Math.floor(size));
  const codePoints = Array.from(text);
  const chunks: string[] = [];

  for (let index = 0; index < codePoints.length; index += effectiveSize) {
    chunks.push(codePoints.slice(index, index + effectiveSize).join(''));
  }

  return chunks;
}

export type ChatCompletionChunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  provider?: string;
  conversationId?: string | null;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      reasoning_content?: string;
    };
    finish_reason: 'stop' | null;
  }>;
  page?: { url: string };
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

/**
 * 生成完整的 chunk 序列：role 首块 →（可选）思考内容块 → 内容块 → 收尾块。
 *
 * 调用方负责逐个写出，最后再补 `data: [DONE]`。
 */
export function buildChatCompletionChunks(args: {
  id: string;
  created: number;
  model: string;
  provider?: string;
  conversationId?: string | null;
  url?: string;
  content?: string | null;
  reasoningContent?: string | null;
  chunkSize?: number;
}): ChatCompletionChunk[] {
  const { id, created, model, provider, conversationId, url, content, reasoningContent } = args;
  const chunkSize = args.chunkSize ?? DEFAULT_CHUNK_CODE_POINTS;

  const base = {
    id,
    object: 'chat.completion.chunk' as const,
    created,
    model,
    ...(provider ? { provider } : {}),
    ...(conversationId !== undefined ? { conversationId: conversationId ?? null } : {}),
  };

  const chunks: ChatCompletionChunk[] = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
  ];

  for (const piece of splitIntoChunks(reasoningContent ?? '', chunkSize)) {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
    });
  }

  for (const piece of splitIntoChunks(content ?? '', chunkSize)) {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    });
  }

  chunks.push({
    ...base,
    ...(url ? { page: { url } } : {}),
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

  return chunks;
}
