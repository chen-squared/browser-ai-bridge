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
