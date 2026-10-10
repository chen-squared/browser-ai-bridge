import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { appConfig } from '../config.js';
import type { ProviderConfig, ProviderId } from '../types.js';

const providerIds = ['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek'] as const;

const selectorOverrideSchema = z.object({
  inputSelectors: z.array(z.string()).optional(),
  sendButtonSelectors: z.array(z.string()).optional(),
  copyButtonSelectors: z.array(z.string()).optional(),
  responseSelectors: z.array(z.string()).optional(),
  busySelectors: z.array(z.string()).optional(),
  url: z.string().optional(),
  newChatUrl: z.string().optional(),
  conversationUrlPattern: z.string().optional(),
  /**
   * 用户消息的祖先标记。凡是**同时**命中这些选择器的元素，都不当作模型回复。
   *
   * 有些站点给用户提问和 AI 回复共用同一个 class，只靠 responseSelectors 区分不开。
   * 实测 Grok 就是这样：`.response-content-markdown` 同时命中两者，
   * 于是"取最后一个可见块"会取到用户自己刚发的那句话——接口原样返回提示词。
   * 有真流捕获时这个问题被掩盖了（流优先），一旦流捕获失败退回 DOM 就会暴露。
   */
  excludeUserMessageSelectors: z.array(z.string()).optional(),
  streamCapture: z
    .object({
      endpointPattern: z.string(),
      /**
       * CDP `Fetch.enable` 要的是 glob 而不是正则。配了就走**增量捕获**那条路：
       * 站点把流一直挂着不关闭时，`response.finished()` 永远不 resolve，
       * `response.body()` 直接抛 `No data found`，整条真流就废了。
       * 不配则只走 finished()+body()（对会正常收尾的响应仍然够用）。
       */
      endpointGlob: z.string().optional(),
      transport: z.enum(['http', 'websocket']),
      /**
       * 每个 reducer 对应一套协议，**不能跨 provider 复用**：
       *   qwen     OpenAI 兼容 SSE，靠 phase 区分思考/正文
       *   deepseek 带路径的补丁协议（p/o/v），先应用补丁再按 fragments[].type 分类
       *   grok     WebSocket，OpenAI Responses 形状，靠 text.channel 区分，纯 token 追加
       *   chatgpt  补丁协议（与 deepseek 同族但语义不同：空 p + add 是新增 message）
       *   claude   会话快照 JSON，**不是 SSE**；它的 SSE 中文编码损坏，故不用
       *   gemini   Google 私有 batchexecute 封装；每帧是累积快照，取最后一帧即可
       */
      reducer: z.enum(['qwen', 'deepseek', 'grok', 'chatgpt', 'claude', 'gemini']),
    })
    .optional(),
  readyTimeoutMs: z.number().int().positive().optional(),
  submissionSignalTimeoutMs: z.number().int().positive().optional(),
  progressIdleTimeoutMs: z.number().int().positive().optional(),
  maxGenerationTimeoutMs: z.number().int().positive().optional(),
  toggles: z
    .object({
      search: z
        .object({
          buttonSelectors: z.array(z.string()),
          activeSelectors: z.array(z.string()).optional(),
        })
        .optional(),
      reasoning: z
        .object({
          buttonSelectors: z.array(z.string()),
          activeSelectors: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});

const overridesFileSchema = z.record(z.enum(providerIds), selectorOverrideSchema.partial());

const defaultProviders: Record<ProviderId, ProviderConfig> = {
  chatgpt: {
    id: 'chatgpt',
    // 实测：https://chatgpt.com/c/<uuid>；新版本地会话是
    // https://chatgpt.com/c/local-chatgpt%3A<uuid>（前缀里的冒号被 URL 编码）。
    // 旧模式要求 /c/ 后面紧跟十六进制，于是本地会话一个都匹配不上，
    // conversationId 恒为 null，多轮对话直接断掉。
    conversationUrlPattern: '\\/c\\/(?:local-chatgpt(?::|%3A))?([0-9a-f-]{20,})',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    urlPatterns: ['chatgpt.com'],
    titleHints: ['chatgpt'],
    inputSelectors: [
      // 2026-10 实测：`id="prompt-textarea"` 也**已被移除**，输入框现在只剩
      // contenteditable + role=textbox。旧的 #prompt-textarea 选择器命中数为 0，
      // 靠列表末尾那条兜底还能打字，但排在前面会白白多等一轮超时。
      'div[data-composer-markdown][contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"][aria-label*="询问"]',
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror[contenteditable="true"]',
      'div.ProseMirror#prompt-textarea',
      'div#prompt-textarea[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-testid="composer"]',
    ],
    sendButtonSelectors: [
      // 2026-10 实测：`data-testid="send-button"` **已被移除**（命中数为 0），
      // 发送按钮现在只靠 aria-label 标识。保留旧写法只是无害的前缀匹配，
      // 但真正起作用的是后面这两条——改版时只按 testid 找会直接静默失效。
      'button[aria-label="发送"]',
      'button[aria-label="Send message"]',
      'button[data-testid="send-button"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
    ],
    copyButtonSelectors: [
      'button[data-testid*="copy"]',
      '[data-testid*="copy"]',
      'button[aria-label*="Copy"]',
      'button[aria-label*="复制"]',
      '[role="button"][aria-label*="Copy"]',
      '[role="button"][aria-label*="复制"]',
      'button[title*="Copy"]',
      'button[title*="复制"]',
    ],
    responseSelectors: [
      // 2026-10 实测：新版把整篇对话换成了新组件——`article`、
      // `data-message-author-role`、`conversation-turn-*`、`.markdown` 全部命中 0。
      // 现在正文是 `p[class*="TextBase"]`（尾号是构建哈希，前缀稳定）。
      'p[class*="TextBase"]',
      '[class*="TextBase"]',
      '[data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
    ],
    busySelectors: ['button[data-testid="stop-button"]'],
    // 实测：POST /backend-api/f/conversation，返回 text/event-stream。
    // 正文在 `event: delta` 的补丁帧里（p=/message/content/parts/0, o=append），
    // 所以切帧必须 event/data 成对，不能只取块首的 data:。
    streamCapture: {
      endpointPattern: '\\/backend-api\\/f\\/conversation$',
      // 2026-10 实测：ChatGPT 不再关闭这条 SSE——答案 +15s 就完成，连接还挂着，
      // 于是 finished() 一直不 resolve、body() 抛 No data found，真流整条丢失，
      // 只能退回 DOM（而新 DOM 里连 article / data-message-author-role 都没了）。
      // 所以这里必须走 CDP Fetch 的增量读，逐块取，不等它结束。
      endpointGlob: '*backend-api/f/conversation',
      transport: 'http',
      reducer: 'chatgpt',
    },
    toggles: {
      search: {
        buttonSelectors: [
          'button[aria-label*="Search"]',
          'button[aria-label*="搜索"]',
          'button[data-testid*="search"]',
        ],
      },
      reasoning: {
        buttonSelectors: [
          'button[aria-label*="Reason"]',
          'button[aria-label*="Thinking"]',
          'button[aria-label*="思考"]',
          'button[data-testid*="reason"]',
        ],
      },
    },
  },
  gemini: {
    id: 'gemini',
    // 实测：https://gemini.google.com/app/<id>
    conversationUrlPattern: '\\/app\\/([A-Za-z0-9_-]{6,})',
    // **尚未接入真流捕获**，故这里没有 streamCapture。原因见下：
    //
    // 端点已经找到——POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/
    // StreamGenerate，回包是 Google 的 batchexecute 封装（`)]}'` 前缀 + 长度前缀分帧 +
    // 每帧 `["wrb.fr",null,"<转义后的JSON字符串>"]`）。技术上 body 能取到（它会正常结束），
    // 正文就埋在那层转义 JSON 里。
    //
    // 但两件事挡住了：
    //   1. 抓到的只有错误码 `BardErrorInfo [1099]` —— 账号配额已耗尽，连一个真实
    //      答案样本都拿不到，归约器无法验证，只能靠猜Google 的内部结构写代码。
    //   2. 这是 Google 私有格式，随意变；没有真实样本就没法确认写对了。
    // 与其留一个没验证过的解析器，不如等配额重置、拿到样本再写。
    // 在那之前 Gemini 走 DOM 路径。
    // 已接真流捕获（2026-10 实测，通配符用 BardFrontendService/StreamGenerate）：
    // 注意**前面不要加 "/"**——真实路径是 `…/assistant.lamda.BardFrontendService/
    // StreamGenerate`，`BardFrontendService` 前面是点号不是斜杠，加了斜杠就永远匹配不上。
    // 回包是 Google 私有 batchexecute 封装 —— )]}' 前缀 + 「<数字>\n<JSON 数组>」并列。
    // **那个数字不可信**（声明 177 实际 175，后续帧也都对不上），所以归约器
    // 按方括号配平切帧。每帧都是**累积的完整状态**而非增量，取最后一帧即完整答案，
    // 因此不需要拼接也不需要去重——这与 DeepSeek/ChatGPT 的补丁协议正好相反。
    streamCapture: {
      endpointPattern: 'BardFrontendService\\/StreamGenerate',
      transport: 'http',
      reducer: 'gemini',
    },
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    urlPatterns: ['gemini.google.com'],
    titleHints: ['gemini'],
    inputSelectors: [
      'div[aria-label*="为 Gemini 输入提示"][role="textbox"]',
      'rich-textarea .ql-editor',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[aria-label*="prompt"]',
    ],
    sendButtonSelectors: [
      'button[aria-label*="发送"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Send"]',
      'button[mattooltip*="Send"]',
      'button[title*="Send"]',
      'button.send-button',
    ],
    copyButtonSelectors: [
      'button[aria-label*="Copy"]',
      'button[aria-label*="复制"]',
      '[role="button"][aria-label*="Copy"]',
      '[role="button"][aria-label*="复制"]',
      'button[mattooltip*="Copy"]',
      'button[title*="Copy"]',
      'button[title*="复制"]',
      '[data-testid*="copy"]',
    ],
    responseSelectors: [
      'model-response [id^="model-response-message-content"]',
      '[id^="model-response-message-content"]',
      'model-response .markdown-main-panel',
      'model-response message-content',
      '[data-response-id]',
    ],
    busySelectors: ['button[aria-label*="Stop"]'],
    submitWithEnterFallback: true,
    keyboardSubmitShortcuts: ['Enter', 'ControlOrMeta+Enter'],
    toggles: {
      search: {
        buttonSelectors: [
          'button[aria-label*="Search"]:not(.search-button)',
          'button[aria-label*="搜索"]:not(.search-button)',
          'button[mattooltip*="Search"]:not(.search-button)',
        ],
      },
      reasoning: {
        buttonSelectors: [
          'button[aria-label*="Deep Research"]',
          'button[aria-label*="Reason"]',
          'button[aria-label*="思考"]',
        ],
      },
    },
  },
  claude: {
    id: 'claude',
    // 实测：https://claude.ai/chat/<uuid>（/new 不是会话页）
    newChatUrl: 'https://claude.ai/new',
    conversationUrlPattern: '\\/chat\\/([0-9a-f-]{20,})',
    label: 'Claude',
    url: 'https://claude.ai/new',
    urlPatterns: ['claude.ai'],
    titleHints: ['claude'],
    inputSelectors: [
      'div[contenteditable="true"][data-testid="composer-input"]',
      'div[contenteditable="true"][aria-label*="Talk to Claude"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ],
    sendButtonSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Send Message"]',
    ],
    copyButtonSelectors: [
      'button[data-testid*="copy"]',
      '[data-testid*="copy"]',
      'button[aria-label*="Copy"]',
      'button[aria-label*="复制"]',
      '[role="button"][aria-label*="Copy"]',
      '[role="button"][aria-label*="复制"]',
      'button[title*="Copy"]',
      'button[title*="复制"]',
    ],
    responseSelectors: [
      'div[data-test-render-count] div.font-claude-message',
      'div.font-claude-message',
      'div[data-testid*="message"] div.prose',
      'main div.prose',
      '[data-testid="conversation-turn-assistant"]',
      '[data-is-streaming]',
    ],
    busySelectors: ['button[aria-label*="Stop response"]'],
    // 实测：GET /api/organizations/{org}/chat_conversations/{id}，返回会话快照 JSON
    // （chat_messages[].content[]），**不是 SSE**。
    // 不用它的 SSE 是因为中文在 SSE 里编码损坏（UTF-8 被按 CP1252 误解码）。
    streamCapture: {
      endpointPattern: '\\/chat_conversations\\/',
      transport: 'http',
      reducer: 'claude',
    },
    toggles: {
      search: {
        buttonSelectors: [
          'button[aria-label*="Web search"]',
          'button[aria-label*="Search the web"]',
          'button:has-text("Search")',
        ],
      },
      reasoning: {
        buttonSelectors: [
          'button[aria-label*="Extended thinking"]',
          'button[aria-label*="Think"]',
          'button:has-text("Thinking")',
        ],
      },
    },
  },
  grok: {
    id: 'grok',
    // 实测：https://grok.com/c/<uuid>
    conversationUrlPattern: '\\/c\\/([0-9a-f-]{20,})',
    // 实测：走 WebSocket wss://grok.com/ws/mgw/，帧是 OpenAI Responses API 形状
    //（response.created / response.chunk / response.done）。
    // 正文是纯 token 增量、只追加，因此不需要任何去重启发式；
    // 思考与回答靠 chunk.text.channel 区分。
    // 帧是实时事件，所以这条路径具备真首字延迟的可能。
    streamCapture: {
      endpointPattern: '\\/ws\\/mgw\\/',
      transport: 'websocket',
      reducer: 'grok',
    },
    label: 'Grok',
    url: 'https://grok.com/',
    urlPatterns: ['grok.com'],
    titleHints: ['grok'],
    inputSelectors: [
      'div[contenteditable="true"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[contenteditable="true"][data-testid*="composer"]',
      'textarea[aria-label*="Grok"]',
      'textarea[placeholder*="想知道什么"]',
      'textarea[placeholder*="知道什么"]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
    ],
    sendButtonSelectors: [
      'button[aria-label*="Grok anything"]',
      'button[aria-label*="Ask Grok"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Submit"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="提交"]',
      'button[aria-label*="Send"]',
      'button[type="submit"]',
    ],
    copyButtonSelectors: [
      'button[data-testid*="copy"]',
      '[data-testid*="copy"]',
      'button[aria-label*="Copy"]',
      'button[aria-label*="复制"]',
      '[role="button"][aria-label*="Copy"]',
      '[role="button"][aria-label*="复制"]',
      'button[title*="Copy"]',
      'button[title*="复制"]',
    ],
    submitWithEnterFallback: false,
    keyboardSubmitShortcuts: ['ControlOrMeta+Enter'],
    responseSelectors: ['.last-response .response-content-markdown', '.response-content-markdown'],
    // 实测：Grok 给用户提问和 AI 回复**共用 `.response-content-markdown`**，
    // 唯一区别是用户气泡额外带 `data-testid="user-message"` 和
    // `bg-surface-user-bubble`。不排除的话，"取最后一个可见块"拿到的是
    // 用户自己刚发的那句话，接口就会原样返回提示词。
    // （原先第一条 `[data-testid="conversation-item-assistant"]` 实测一个都匹配不到，
    // 属于完全失效的选择器，已删除。）
    excludeUserMessageSelectors: ['[data-testid="user-message"]', '.bg-surface-user-bubble'],
    busySelectors: ['button[aria-label*="Stop"]'],
    toggles: {
      search: {
        buttonSelectors: [
          'button[aria-label*="Search"]',
          'button[aria-label*="DeepSearch"]',
          'button:has-text("Search")',
        ],
      },
      reasoning: {
        buttonSelectors: [
          'button[aria-label*="Think"]',
          'button[aria-label*="Reason"]',
          'button:has-text("Think")',
        ],
      },
    },
  },
  qwen: {
    id: 'qwen',
    // 实测：https://chat.qwen.ai/c/<uuid>
    conversationUrlPattern: '\\/c\\/([0-9a-f-]{20,})',
    // 实测：POST /api/v2/chat/completions?chat_id=...，返回 text/event-stream，
    // 帧是 OpenAI 兼容形状，靠 phase 区分 thinking_summary 与 answer。
    streamCapture: {
      endpointPattern: '\\/api\\/v2\\/chat\\/completions',
      transport: 'http',
      reducer: 'qwen',
    },
    label: 'Qwen',
    url: 'https://chat.qwen.ai/',
    urlPatterns: ['chat.qwen.ai'],
    titleHints: ['qwen', '通义'],
    inputSelectors: [
      'textarea[placeholder*="帮您"]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
    ],
    sendButtonSelectors: [
      'button[type="submit"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
    ],
    copyButtonSelectors: [
      '.qwen-chat-package-comp-new-action-control-container-copy',
      '[class*="qwen-chat-package-comp-new-action-control-container-copy"]',
      'button[aria-label*="复制"]',
      'button[aria-label*="Copy"]',
      'button[title*="复制"]',
      'button[title*="Copy"]',
      '[role="button"][aria-label*="复制"]',
      '[role="button"][aria-label*="Copy"]',
      '[role="button"][title*="复制"]',
      '[role="button"][title*="Copy"]',
      'button[data-testid*="copy"]',
      '[role="button"][data-testid*="copy"]',
    ],
    submitWithEnterFallback: false,
    keyboardSubmitShortcuts: ['ControlOrMeta+Enter'],
    responseSelectors: [
      '.response-message-content.phase-answer .custom-qwen-markdown',
      '.response-message-content.phase-answer .qwen-markdown',
      '.response-message-content.phase-answer',
      '.custom-qwen-markdown',
      '.qwen-markdown',
      '.response-message-content .custom-qwen-markdown',
      '.response-message-content .qwen-markdown',
      '.response-message-content',
      '.qwen-chat-message-assistant',
      '.message-assistant',
      '[class*="assistant"]',
    ],
    busySelectors: [
      'button[aria-label*="停止"]',
      'button[aria-label*="Stop"]',
      '.qwen-chat-message-assistant:has-text("正在思考")',
      '.qwen-chat-message-assistant:has-text("思考中")',
    ],
    toggles: {
      search: {
        buttonSelectors: [
          'button[aria-label*="联网搜索"]',
          'button[aria-label*="搜索"]',
          'button:has-text("联网")',
        ],
      },
      reasoning: {
        buttonSelectors: [
          'button[aria-label*="深度思考"]',
          'button[aria-label*="思考"]',
          'button:has-text("思考")',
        ],
      },
    },
  },
  deepseek: {
    id: 'deepseek',
    // 实测：https://chat.deepseek.com/a/chat/s/<uuid>
    conversationUrlPattern: '\\/a\\/chat\\/s\\/([0-9a-f-]{20,})',
    // 实测：POST /api/v0/chat/completion，返回 text/event-stream。
    // 帧是**带路径的补丁协议**（p/o/v），不是裸 delta：先应用补丁得到最终状态，
    // 再按 fragments[].type 区分 THINK / RESPONSE。因此不需要任何去重启发式。
    streamCapture: {
      endpointPattern: '\\/api\\/v0\\/chat\\/completion',
      transport: 'http',
      reducer: 'deepseek',
    },
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    urlPatterns: ['chat.deepseek.com'],
    titleHints: ['deepseek'],
    inputSelectors: ['textarea', 'div[contenteditable="true"][role="textbox"]'],
    sendButtonSelectors: [
      'button[type="submit"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
    ],
    copyButtonSelectors: [
      'button[aria-label*="复制"]',
      'button[aria-label*="Copy"]',
      'button[title*="复制"]',
      'button[title*="Copy"]',
      '[role="button"][aria-label*="复制"]',
      '[role="button"][aria-label*="Copy"]',
      '[role="button"][title*="复制"]',
      '[role="button"][title*="Copy"]',
      'button[data-testid*="copy"]',
      '[role="button"][data-testid*="copy"]',
    ],
    responseSelectors: ['.ds-markdown', '[class*="assistant"]'],
    busySelectors: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
    toggles: {
      search: {
        buttonSelectors: [
          '[role="button"].ds-toggle-button:has-text("智能搜索")',
          'button[aria-label*="联网搜索"]',
          'button[aria-label*="搜索"]',
          '[role="button"][aria-label*="联网搜索"]',
          '[role="button"]:has-text("智能搜索")',
          'button:has-text("联网搜索")',
        ],
        activeSelectors: [
          '[role="button"].ds-toggle-button.ds-toggle-button--selected:has-text("智能搜索")',
          'button[aria-pressed="true"][aria-label*="联网搜索"]',
          'button[aria-checked="true"][aria-label*="联网搜索"]',
          '[role="button"][aria-pressed="true"][aria-label*="联网搜索"]',
          '[role="button"][data-state="on"][aria-label*="联网搜索"]',
        ],
      },
      reasoning: {
        buttonSelectors: [
          '[role="button"].ds-toggle-button:has-text("深度思考")',
          'button[aria-label*="深度思考(R1)"]',
          'button[aria-label*="深度思考"]',
          'button[aria-label*="思考"]',
          '[role="button"][aria-label*="深度思考"]',
          '[role="button"]:has-text("深度思考")',
          'button:has-text("深度思考")',
        ],
        activeSelectors: [
          '[role="button"].ds-toggle-button.ds-toggle-button--selected:has-text("深度思考")',
          'button[aria-pressed="true"][aria-label*="深度思考"]',
          'button[aria-checked="true"][aria-label*="深度思考"]',
          '[role="button"][aria-pressed="true"][aria-label*="深度思考"]',
          '[role="button"][data-state="on"][aria-label*="深度思考"]',
          'button[class*="active"][aria-label*="深度思考"]',
        ],
      },
    },
  },
};

let providers = applyOverrides(defaultProviders);

function applyOverrides(
  baseProviders: Record<ProviderId, ProviderConfig>,
): Record<ProviderId, ProviderConfig> {
  const overrides = loadOverrides();

  return Object.fromEntries(
    Object.entries(baseProviders).map(([providerId, config]) => {
      const override = overrides[providerId as ProviderId];
      return [
        providerId,
        override
          ? {
              ...config,
              ...override,
            }
          : config,
      ];
    }),
  ) as Record<ProviderId, ProviderConfig>;
}

function loadOverrides(): Partial<Record<ProviderId, Partial<ProviderConfig>>> {
  try {
    const raw = readFileSync(appConfig.selectorOverridesPath, 'utf8');
    return overridesFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }

    throw new Error(`selector 覆盖文件无效: ${appConfig.selectorOverridesPath}`, { cause: error });
  }
}

export function listProviders(): ProviderConfig[] {
  return Object.values(providers);
}

export function getProvider(providerId: ProviderId): ProviderConfig {
  return providers[providerId];
}

export function reloadProviders(): ProviderConfig[] {
  providers = applyOverrides(defaultProviders);
  return listProviders();
}

export function getSelectorOverridesPath(): string {
  return appConfig.selectorOverridesPath;
}
