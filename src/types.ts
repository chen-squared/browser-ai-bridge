export type ProviderId = 'chatgpt' | 'gemini' | 'claude' | 'grok' | 'qwen' | 'deepseek';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
};

export type ChatCompletionRequest = {
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
};

export type ToggleConfig = {
  buttonSelectors: string[];
  activeSelectors?: string[];
};

export type ProviderConfig = {
  id: ProviderId;
  label: string;
  url: string;
  /**
   * "新建对话"页面。建标签页时导航到这里而不是 `url`——`url` 往往是首页，
   * 而不少站点在首页会自动恢复上一次对话，于是"第一条新消息"会被追加进一个
   * 无关的旧对话里。不填则退回 `url`。
   */
  newChatUrl?: string;
  /**
   * 从页面 URL 里抽会话 id 的正则（需含一个捕获组）。抽到的 id 会随响应返回，
   * 调用方下一次带上它就等于"继续这条对话"，bridge 据此复用同一标签页。
   */
  conversationUrlPattern?: string;
  /**
   * 真流捕获配置。启用后直接读网页自己收到的 SSE，而不是从 DOM 里猜哪个块是答案。
   *
   * 不往页面里注入任何 JS（走 Playwright 的 response 事件），因此没有指纹风险；
   * 代价是等请求结束才能拿到完整 body，**没有真首字延迟**。捕获失败会自动退回
   * 原来的 DOM 轮询路径，功能不受影响。
   */
  streamCapture?: {
    /**
     * 只捕获 URL 匹配此模式的响应。
     * `websocket` 传输下匹配的是 `wss://` 地址。
     */
    endpointPattern: string;
    /**
     * 传输方式。
     *
     * `http` 的流走 fetch，只能在请求结束后一次性取到完整 body，**没有首字延迟**。
     * `websocket` 的帧是实时事件，**具备真 TTFT 的可能**，且同样不需要注入页面。
     */
    transport: 'http' | 'websocket';
    /**
     * 帧归约器名，对应 src/stream-capture.ts 里的实现。
     *
     * 每个 reducer 对应一套协议，不能跨 provider 复用：
     *   qwen     OpenAI 兼容 SSE，靠 phase 区分思考/正文
     *   deepseek 带路径的补丁协议（p/o/v），先应用补丁再按 fragments[].type 分类
     *   grok     WebSocket，OpenAI Responses 形状，靠 text.channel 区分，纯 token 追加
     *   chatgpt  补丁协议（与 deepseek 同族，但空 p + add 表示新增 message）
     *   claude   会话快照 JSON，**不是 SSE**；它的 SSE 中文编码损坏，故不用
     *   gemini   Google 私有 batchexecute 封装；每帧是累积快照，取最后一帧即可
     */
    reducer: 'qwen' | 'deepseek' | 'grok' | 'chatgpt' | 'claude' | 'gemini';
  };
  /**
   * 用户消息的祖先标记。凡是同时命中这些选择器的元素，都不当作模型回复。
   *
   * 存在的理由：有些站点给用户提问和 AI 回复共用同一个 class，只靠
   * `responseSelectors` 区分不开。实测 Grok 的 `.response-content-markdown`
   * 同时命中两者，"取最后一个可见块"就可能取到用户自己刚发的那句话，
   * 接口于是原样返回提示词。
   */
  excludeUserMessageSelectors?: string[];
  inputSelectors: string[];
  sendButtonSelectors: string[];
  copyButtonSelectors?: string[];
  submitWithEnterFallback?: boolean;
  keyboardSubmitShortcuts?: string[];
  responseSelectors: string[];
  busySelectors?: string[];
  readyTimeoutMs?: number;
  /** 提交确认信号等待时长（毫秒）：等待 URL 变化/Stop 按钮出现/响应数增加/输入框清空任意一种信号。默认 8000。 */
  submissionSignalTimeoutMs?: number;
  /** 空闲超时：内容无变化且不处于忙碌状态超过此时长则放弃，毫秒。默认 30000。 */
  progressIdleTimeoutMs?: number;
  /** 总时长上限：单次生成不得超过此时长，毫秒。默认 600000。 */
  maxGenerationTimeoutMs?: number;
  urlPatterns?: string[];
  titleHints?: string[];
  toggles?: {
    search?: ToggleConfig;
    reasoning?: ToggleConfig;
  };
};

export type NormalizedPrompt = {
  system?: string;
  latestUserMessage: string;
  trailingUserMessages: Array<{ role: 'user'; content: string; name?: string }>;
  trailingUserBlock: string;
  nonSystemMessages: Array<{ role: 'user' | 'assistant'; content: string; name?: string }>;
  fullMessagesBlock: string;
  historyCount: number;
  hasSystem: boolean;
};

export type ChatResult = {
  provider: ProviderId;
  content: string;
  reasoningContent?: string;
  /** 站点自己上报的 token 计数；只有走真流捕获时才有。 */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
  };
  /** 正文来自真流捕获而非 DOM 抓取。 */
  capturedFromStream?: boolean;
  url: string;
  debug?: {
    extraction?: {
      items: Array<{
        index: number;
        method: 'copy' | 'html' | 'innerText';
        detail?: string;
        preview?: string;
      }>;
    };
  };
};
