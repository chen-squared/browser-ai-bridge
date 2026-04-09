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
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    urlPatterns: ['chatgpt.com'],
    titleHints: ['chatgpt'],
    inputSelectors: [
      'div.ProseMirror#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'div#prompt-textarea[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]#prompt-textarea',
      'div[contenteditable="true"][data-testid="composer"]',
      'div[role="textbox"][contenteditable="true"]',
    ],
    sendButtonSelectors: [
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
      '[data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
    ],
    busySelectors: ['button[data-testid="stop-button"]'],
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
    responseSelectors: [
      '.last-response .response-content-markdown',
      '[data-testid="conversation-item-assistant"]',
      '.response-content-markdown',
    ],
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
