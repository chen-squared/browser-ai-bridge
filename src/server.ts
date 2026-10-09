import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { appConfig } from './config.js';
import { BrowserManager } from './browser/browser-manager.js';
import { ProviderClient } from './browser/provider-client.js';
import { normalizeMessages } from './prompt.js';
import { createSyncPlan } from './session-sync.js';
import { buildChatCompletionChunks } from './sse-chunks.js';
import { buildAllowedHosts, extractToken, isAllowedHost, isTokenValid } from './http-access.js';
import {
  listMeetingModels,
  resolveMeetingPlan,
  resolveMeetingTemplate,
  runMeetingCompletion,
} from './meeting.js';
import {
  getProvider,
  getSelectorOverridesPath,
  listProviders,
  reloadProviders,
} from './providers/registry.js';
import type { ChatMessage, ProviderId } from './types.js';

const providerSchema = z.enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek']);

const requestSchema = z.object({
  model: z.string().optional(),
  provider: z.enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek']).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string().min(1),
        name: z.string().optional(),
      }),
    )
    .min(1),
  temperature: z.number().optional(),
  conversationId: z.string().optional(),
  enableSearch: z.boolean().optional(),
  enableReasoning: z.boolean().optional(),
  promptMode: z.enum(['latest-user', 'trailing-users', 'full-messages']).optional(),
  includeTrailingUserMessages: z.boolean().optional(),
  injectSystemOnFirstTurn: z.boolean().optional(),
  sessionTranscriptMode: z.enum(['raw', 'context-window']).optional(),
  dryRun: z.boolean().optional(),
  stream: z.boolean().optional(),
  meeting: z
    .object({
      participants: z
        .array(z.enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek']))
        .min(2)
        // 上限 6：六家 provider 全选也只是再多一个会话。
        // 原先限制 4，但注册表里恰好六个 provider，界面上会出现
        // 「有 provider 却选不进来」的荒唐状态。
        .max(6)
        .optional(),
      rounds: z.number().int().min(1).max(4).optional(),
      summarizer: z.enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek']).optional(),
      /**
       * 总结者复用哪个参与者席位（形如 deepseek1 / deepseek2）。
       * 留空 = 开新会话。这是"复用之前的会话"与"开新的会话"的唯一开关。
       */
      summarizerSeat: z.string().min(1).max(32).optional(),
    })
    .optional(),
});

/** `/meeting/plan` 的入参：只要编排相关的字段，其余一律不接受。 */
const meetingPlanSchema = z.object({
  template: z.string().min(1),
  participants: z
    .array(z.enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek']))
    .max(6)
    .optional(),
  summarizer: z.enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek']).optional(),
  summarizerSeat: z.string().min(1).max(32).optional(),
  rounds: z.number().int().min(1).max(4).optional(),
});

type CompletionPayload = z.infer<typeof requestSchema>;

function listChatModels() {
  const providerModels = listProviders().map((provider) => ({
    id: provider.id,
    object: 'model' as const,
    created: 0,
    owned_by: 'browser-ai-bridge',
    provider: provider.id,
    label: provider.label,
    url: provider.url,
    kind: 'provider',
  }));

  return [...providerModels, ...listMeetingModels()];
}

async function completeWithProvider(
  payload: CompletionPayload & {
    provider: ProviderId;
    model: string;
    messages: ChatMessage[];
    conversationId?: string;
  },
  /**
   * 真流式出口。只有当 provider 走 WebSocket 传输且调用方要求 stream 时才会被触发
   * （HTTP SSE 的流只能在生成结束后一次性取到 body，做不到逐帧推送）。
   */
  options?: {
    onDelta?: (delta: { contentDelta?: string; reasoningDelta?: string }) => void;
  },
): Promise<{
  provider: ProviderId;
  model: string;
  conversationId?: string;
  url?: string;
  content?: string;
  reasoningContent?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
  };
  capturedFromStream?: boolean;
  dryRun?: boolean;
  prompt?: string;
  debug?: unknown;
}> {
  const provider = payload.provider;
  const normalizedPrompt = normalizeMessages(payload.messages);
  const latestUser = [...normalizedPrompt.nonSystemMessages]
    .reverse()
    .find((message) => message.role === 'user');
  if (!latestUser) {
    throw new Error('至少需要一条 user 消息');
  }

  const client = new ProviderClient(provider, {
    take: (page, since) => browserManager.takeCapturedStream(page, provider, since),
    frames: (page, since) => browserManager.streamFrames(page, provider, since),
  });
  const hasExistingSession = browserManager.hasSession(provider, payload.conversationId);
  const desiredPromptMode = resolvePromptMode(payload);
  const cachedMessages = browserManager.getSyncedMessages(provider, payload.conversationId);
  const transcriptMode = payload.sessionTranscriptMode ?? 'raw';
  const syncPlan = createSyncPlan({
    system: normalizedPrompt.system,
    currentMessages: normalizedPrompt.nonSystemMessages,
    currentContextMessages: normalizedPrompt.nonSystemMessages.slice(0, -1),
    latestUserMessage: latestUser,
    cachedMessages,
    hasExistingSession,
    desiredPromptMode,
    injectSystemOnFirstTurn: Boolean(payload.injectSystemOnFirstTurn) && !hasExistingSession,
    transcriptMode,
  });
  const effectiveNormalizedPrompt = normalizeMessages(syncPlan.effectiveMessages);
  const useContinuationMode =
    syncPlan.mode === 'append' && effectiveNormalizedPrompt.historyCount > 1;
  const promptPreview = client.previewPrompt(effectiveNormalizedPrompt, {
    isContinuation: useContinuationMode,
    enableSearch: payload.enableSearch,
    enableReasoning: payload.enableReasoning,
    promptMode: syncPlan.effectivePromptMode,
    includeTrailingUserMessages: payload.includeTrailingUserMessages,
    injectSystemOnFirstTurn: syncPlan.injectSystemOnFirstTurn,
  });

  if (payload.dryRun) {
    return {
      provider,
      model: payload.model,
      conversationId: payload.conversationId,
      dryRun: true,
      prompt: promptPreview,
      debug: {
        hasExistingSession,
        useContinuationMode,
        desiredPromptMode,
        syncMode: syncPlan.mode,
        syncDebug: syncPlan.debug,
        injectSystemOnFirstTurn: syncPlan.injectSystemOnFirstTurn,
        effectivePromptMode: syncPlan.effectivePromptMode,
        historyCount: effectiveNormalizedPrompt.historyCount,
        latestUserMessage: effectiveNormalizedPrompt.latestUserMessage,
        trailingUserMessages: effectiveNormalizedPrompt.trailingUserMessages,
        nonSystemMessages: effectiveNormalizedPrompt.nonSystemMessages,
        cachedMessages,
        nextCachedMessages: syncPlan.nextCachedMessages,
      },
    };
  }

  if (syncPlan.mode === 'rebuild') {
    await browserManager.clearSession(provider, payload.conversationId).catch(() => false);
  }

  const content = await browserManager.runExclusive(
    provider,
    payload.conversationId,
    async (page) => {
      try {
        return await client.sendMessage(page, effectiveNormalizedPrompt, {
          onDelta: options?.onDelta,
          isContinuation: useContinuationMode,
          enableSearch: payload.enableSearch,
          enableReasoning: payload.enableReasoning,
          promptMode: syncPlan.effectivePromptMode,
          includeTrailingUserMessages: payload.includeTrailingUserMessages,
          injectSystemOnFirstTurn: syncPlan.injectSystemOnFirstTurn,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldFallbackToLatestResponse =
          /未能稳定提取 .*回复内容|未提取到 .*有效回复文本/u.test(message);
        if (!shouldFallbackToLatestResponse) {
          throw error;
        }

        const fallbackResult = await client.extractLatestResponse(page);
        const extractionItems = fallbackResult.debug?.extraction?.items;
        if (extractionItems && extractionItems.length > 0) {
          extractionItems[0] = {
            ...extractionItems[0],
            detail:
              `发送后稳定提取失败，已回退为 latest-response 抓取: ${message}; ${extractionItems[0].detail ?? ''}`.trim(),
          };
        }
        return fallbackResult;
      }
    },
  );

  browserManager.setSyncedMessages(provider, payload.conversationId, [
    ...syncPlan.nextCachedMessages,
    { role: 'assistant', content: content.content },
  ]);

  // 调用方没传 conversationId 时，从页面 URL 里抽真实会话 id 回传。
  // 有了它，调用方下一次带上这个 id 就等于"继续这条对话"，bridge 会复用
  // 同一个标签页；不带 id 则表示"开新对话"，bridge 新建标签页并导航到新对话页。
  // 这样"是否连续"由调用方显式决定，而不需要 bridge 靠启发式去猜。
  const resolvedConversationId =
    payload.conversationId ??
    browserManager.recordDetectedConversationId(provider, payload.conversationId);

  return {
    provider,
    model: payload.model,
    conversationId: resolvedConversationId,
    url: content.url,
    content: content.content,
    reasoningContent: content.reasoningContent,
    ...(content.usage ? { usage: content.usage } : {}),
    ...(content.capturedFromStream ? { capturedFromStream: true } : {}),
    debug: content.debug,
  };
}

const browserManager = new BrowserManager();
const app = express();
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const markedVendorDir = path.resolve(runtimeDir, '../node_modules/marked/lib');
const consoleHtmlPath = path.resolve(runtimeDir, 'console/index.html');
const CONSOLE_HTML = readFileSync(consoleHtmlPath, 'utf8');

// 1) Host 白名单：防 DNS rebinding。
//    只监听 127.0.0.1 并不能自保——浏览器按主机名判断同源，恶意域名解析到
//    127.0.0.1 之后，请求对浏览器而言是同源的，CORS 也拦不住。这是先决关卡，
//    任何情况下都启用。
const allowedHosts = buildAllowedHosts(appConfig.allowedHosts, appConfig.host);
app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host, allowedHosts)) {
    res.status(421).json({
      error: {
        message:
          `Host ${req.headers.host ?? '<缺失>'} 不在允许列表内。` +
          '这是为防止 DNS rebinding 攻击；如需从其他主机名访问，请设置 ALLOWED_HOSTS。',
      },
    });
    return;
  }
  next();
});

// 2) CORS：默认关闭（= 仅同源）。之前是 cors() 全开，任何网页都能读走响应，
//    甚至用你的登录态驱动这个浏览器发消息。
const corsOrigin = appConfig.corsOrigin?.trim();
if (corsOrigin) {
  const allowedOrigins = new Set(
    corsOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`CORS origin 不被允许: ${origin}`));
      },
    }),
  );
}

// 3) 可选 token：未配置时完全不影响现有行为。
//    /health 和控制台本体放行，否则健康检查和首次打开页面会直接不可用。
if (appConfig.bridgeToken) {
  const isPublicPath = (pathname: string) =>
    pathname === '/health' || pathname === '/' || pathname.startsWith('/vendor/');

  app.use((req, res, next) => {
    if (isPublicPath(req.path)) {
      next();
      return;
    }

    const providedToken = extractToken(
      req.headers.authorization,
      req.headers['x-bridge-token'] as string | undefined,
      typeof req.query.token === 'string' ? req.query.token : undefined,
    );

    if (!isTokenValid(providedToken, appConfig.bridgeToken)) {
      res.status(401).json({
        error: { message: '缺少或错误的 BRIDGE_TOKEN，请通过 Authorization: Bearer 传入。' },
      });
      return;
    }

    next();
  });
}

app.use(express.json({ limit: '1mb' }));
app.use('/vendor/marked', express.static(markedVendorDir));

function parseOptionalConversationId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function writeSse(res: express.Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function finishSse(res: express.Response): void {
  res.write('data: [DONE]\n\n');
  res.end();
}

function resolveRequestProvider(payload: Partial<CompletionPayload>): ProviderId | undefined {
  if (typeof payload.provider === 'string' && providerSchema.safeParse(payload.provider).success) {
    return payload.provider as ProviderId;
  }

  if (typeof payload.model === 'string') {
    const matched = providerSchema.options.find(
      (provider) => payload.model === provider || payload.model === `${provider}-web`,
    );
    if (matched) {
      return matched;
    }
  }

  return undefined;
}

async function resolveSessionConversationId(
  provider: ProviderId,
  conversationId?: string,
): Promise<string | undefined> {
  const normalizedConversationId = parseOptionalConversationId(conversationId);
  if (!normalizedConversationId) {
    return undefined;
  }

  const sessions = await browserManager.listSessions();
  const matchedSession = sessions
    .filter((session) => !session.isClosed)
    .filter((session) => session.providerId === provider)
    .filter(
      (session) =>
        typeof session.conversationId === 'string' &&
        session.conversationId.startsWith(`${normalizedConversationId}:`),
    )
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0];

  if (matchedSession?.conversationId) {
    return matchedSession.conversationId;
  }

  if (browserManager.hasSession(provider, normalizedConversationId)) {
    return normalizedConversationId;
  }

  return undefined;
}

async function revealRelevantSessionOnError(
  payload: Partial<CompletionPayload>,
  effectiveMeetingConversationId?: string,
): Promise<void> {
  // 默认不做。bringToFront 会激活标签页，在 macOS 上连带激活整个浏览器窗口；
  // 而错误并不罕见（未登录时的 90 秒超时就是典型），等于频繁打断同一台机器上的
  // 其他操作。卡住时想看一眼，用控制台的"打开"按钮即可（那条路径不受此开关影响）。
  if (!appConfig.revealOnError) {
    return;
  }

  const meetingTemplate = resolveMeetingTemplate(payload.model);
  if (meetingTemplate) {
    const baseConversationId =
      effectiveMeetingConversationId ?? parseOptionalConversationId(payload.conversationId);
    if (!baseConversationId) {
      return;
    }

    const plan = resolveMeetingPlan(meetingTemplate, payload as CompletionPayload);
    const candidates = [
      {
        provider: plan.summarizer.provider,
        conversationId: `${baseConversationId}:${plan.summarizer.alias}:${plan.summarizer.provider}`,
      },
      ...plan.participants.map((participant) => ({
        provider: participant.provider,
        conversationId: `${baseConversationId}:${participant.alias}:${participant.provider}`,
      })),
    ];

    for (const candidate of candidates) {
      const revealed = await browserManager
        .revealSession(candidate.provider, candidate.conversationId)
        .catch(() => undefined);
      if (revealed) {
        return;
      }
    }

    return;
  }

  const provider = resolveRequestProvider(payload);
  if (!provider) {
    return;
  }

  await browserManager
    .revealSession(provider, parseOptionalConversationId(payload.conversationId))
    .catch(() => undefined);
}

function resolvePromptMode(
  payload: z.infer<typeof requestSchema>,
): 'latest-user' | 'trailing-users' | 'full-messages' {
  if (payload.promptMode) {
    return payload.promptMode;
  }

  if (payload.includeTrailingUserMessages) {
    return 'trailing-users';
  }

  const nonSystemMessages = payload.messages.filter((message) => message.role !== 'system');
  const hasAssistantMessage = nonSystemMessages.some((message) => message.role === 'assistant');

  if (hasAssistantMessage) {
    return payload.conversationId ? 'trailing-users' : 'full-messages';
  }

  if (nonSystemMessages.length <= 1) {
    return 'latest-user';
  }

  return 'trailing-users';
}

app.get('/', (_req, res) => {
  res.type('html').send(CONSOLE_HTML);
});

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    defaultProvider: appConfig.defaultProvider,
    headless: appConfig.headless,
  });
});

app.get('/providers', (_req, res) => {
  res.json({
    selectorOverridesPath: getSelectorOverridesPath(),
    providers: listProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      url: provider.url,
      // 暴露捕获方式：控制台据此标注"这个 provider 的答案来自真流还是 DOM"。
      // 之前这个字段只出现在 /providers/:provider，列表端点缺了它，
      // 导致页面把六家全标成 DOM——标记错了还不如没有。
      ...(provider.streamCapture
        ? {
            streamCapture: {
              transport: provider.streamCapture.transport,
              reducer: provider.streamCapture.reducer,
            },
          }
        : {}),
    })),
  });
});

app.get(['/models', '/v1/models'], (_req, res) => {
  res.json({
    object: 'list',
    data: listChatModels(),
  });
});

/**
 * 只算编排计划，不碰浏览器、不发任何消息。
 *
 * 存在的理由：席位名（deepseek1 / deepseek2）**同时是会话身份**——
 * 它会进 conversationId。若让前端自己算一遍，两边算法一旦漂移就会
 * 静默复用错会话，那是最难发现的一类 bug。所以这里让服务端算、前端照抄，
 * 前端不再自己实现命名逻辑。
 */
app.post('/meeting/plan', (req, res) => {
  try {
    const input = meetingPlanSchema.parse(req.body ?? {});
    const template = resolveMeetingTemplate(input.template);
    if (!template) {
      res.status(400).json({ error: { message: `未知的会议模板: ${input.template}` } });
      return;
    }
    const plan = resolveMeetingPlan(template, {
      model: template.id,
      messages: [],
      meeting: {
        ...(input.participants ? { participants: input.participants } : {}),
        ...(input.summarizer ? { summarizer: input.summarizer } : {}),
        ...(input.summarizerSeat ? { summarizerSeat: input.summarizerSeat } : {}),
        ...(input.rounds ? { rounds: input.rounds } : {}),
      },
    });
    res.json({
      mode: plan.mode,
      rounds: plan.rounds,
      participants: plan.participants.map((participant) => ({
        alias: participant.alias,
        provider: participant.provider,
      })),
      summarizer: { alias: plan.summarizer.alias, provider: plan.summarizer.provider },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '计算会议计划失败';
    res.status(400).json({ error: { message } });
  }
});

app.get('/sessions', async (_req, res) => {
  res.json({
    sessions: await browserManager.listSessions(),
  });
});

app.get('/providers/:provider', (req, res) => {
  try {
    const provider = providerSchema.parse(req.params.provider);
    res.json({
      selectorOverridesPath: getSelectorOverridesPath(),
      provider: getProvider(provider),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'provider 不存在';
    res.status(400).json({ error: { message } });
  }
});

app.post('/providers/reload', (_req, res) => {
  try {
    const providers = reloadProviders();
    res.json({
      ok: true,
      selectorOverridesPath: getSelectorOverridesPath(),
      providers: providers.map((provider) => provider.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '重载 selector 失败';
    res.status(400).json({ error: { message } });
  }
});

app.post('/session/:provider/open', async (req, res) => {
  try {
    const provider = providerSchema.parse(req.params.provider) as ProviderId;
    const page = await browserManager.openSession(provider);
    res.json({ ok: true, provider, url: page.url() });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : '打开 provider 失败',
    });
  }
});

app.get('/session/:provider/inspect', async (req, res) => {
  try {
    const provider = providerSchema.parse(req.params.provider) as ProviderId;
    const conversationId = parseOptionalConversationId(req.query.conversationId);
    const hoverLatestResponse = String(req.query.hoverLatestResponse || '').trim() === '1';
    const resolvedConversationId = await resolveSessionConversationId(provider, conversationId);
    if (conversationId && !resolvedConversationId) {
      throw new Error(`未找到 ${provider} 的现有会话: ${conversationId}`);
    }
    const payload = await browserManager.inspectSession(provider, resolvedConversationId, {
      hoverLatestResponse,
    });
    res.json({ ok: true, provider, conversationId, resolvedConversationId, ...payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : '调试页面失败';
    res.status(400).json({ error: { message } });
  }
});

app.post('/session/:provider/probe-input', async (req, res) => {
  try {
    const provider = providerSchema.parse(req.params.provider) as ProviderId;
    const conversationId = parseOptionalConversationId(req.body?.conversationId);
    const probeText = typeof req.body?.text === 'string' ? req.body.text : undefined;
    const payload = await browserManager.probeInputStrategies(provider, conversationId, probeText);
    res.json({ ok: true, provider, conversationId, ...payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : '探测输入框失败';
    res.status(400).json({ error: { message } });
  }
});

app.post('/session/:provider/extract-latest', async (req, res) => {
  try {
    const provider = providerSchema.parse(req.params.provider) as ProviderId;
    const conversationId = parseOptionalConversationId(req.body?.conversationId);
    const resolvedConversationId = await resolveSessionConversationId(provider, conversationId);
    if (conversationId && !resolvedConversationId) {
      throw new Error(`未找到 ${provider} 的现有会话: ${conversationId}`);
    }
    const client = new ProviderClient(provider, {
      take: (page, since) => browserManager.takeCapturedStream(page, provider, since),
      frames: (page, since) => browserManager.streamFrames(page, provider, since),
    });
    const latestAssistantHint = browserManager
      .getSyncedMessages(provider, resolvedConversationId)
      .slice()
      .reverse()
      .find((message) => message.role === 'assistant')?.content;
    const payload = await browserManager.runExclusive(
      provider,
      resolvedConversationId,
      async (page) => {
        return client.extractLatestResponse(page, { latestAssistantHint });
      },
    );
    res.json({
      ok: true,
      provider,
      conversationId,
      resolvedConversationId,
      url: payload.url,
      content: payload.content,
      reasoningContent: payload.reasoningContent,
      debug: payload.debug,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '重抓最新回复失败';
    res.status(400).json({ error: { message } });
  }
});

app.post('/session/:provider/clear', async (req, res) => {
  try {
    const provider = providerSchema.parse(req.params.provider) as ProviderId;
    const conversationId = parseOptionalConversationId(req.body?.conversationId);
    const cleared = await browserManager.clearSession(provider, conversationId);
    res.json({ ok: true, provider, conversationId, cleared });
  } catch (error) {
    const message = error instanceof Error ? error.message : '清理会话失败';
    res.status(400).json({ error: { message } });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  let effectiveMeetingConversationId: string | undefined;

  try {
    const payload = requestSchema.parse(req.body);
    const meetingTemplate = resolveMeetingTemplate(payload.model);
    if (meetingTemplate) {
      if (payload.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        // **必须接住返回值。** 会议进度事件（分工、逐个发言）是流式发出去的，
        // 但真正的总结答复只存在于返回值里——原先 await 完就丢弃、接着
        // finishSse，客户端于是只看到一堆 meeting.entry，永远等不到总结。
        // 表现就是"会议跑完了但没有答复"。
        const meetingResult = await runMeetingCompletion(
          payload,
          meetingTemplate,
          completeWithProvider,
          {
            onProgress: async (event) => {
              if (event.type === 'meeting.started') {
                effectiveMeetingConversationId = event.meeting.conversationId;
              }
              writeSse(res, event);
            },
          },
        );

        // 总结按 OpenAI 形状补发成 chunk，这样按 chat/completions 解析的客户端
        // （包括控制台）能用同一条 delta 逻辑把它读出来。
        for (const chunk of buildChatCompletionChunks({
          id: `chatcmpl-${Date.now()}`,
          created: Math.floor(Date.now() / 1000),
          model: String(req.body?.model ?? 'meeting'),
          content: meetingResult?.choices?.[0]?.message?.content ?? '',
          provider: 'meeting',
        })) {
          writeSse(res, chunk);
        }

        finishSse(res);
        return;
      }

      const meetingResponse = await runMeetingCompletion(
        payload,
        meetingTemplate,
        completeWithProvider,
        {
          onProgress: async (event) => {
            if (event.type === 'meeting.started') {
              effectiveMeetingConversationId = event.meeting.conversationId;
            }
          },
        },
      );
      res.json(meetingResponse);
      return;
    }

    const provider = resolveRequestProvider(payload) ?? appConfig.defaultProvider;
    // dryRun 是调试路径，保持返回普通 JSON，不进 SSE。
    const wantsStream = Boolean(payload.stream) && !payload.dryRun;

    // 必须先发响应头再开始那段可能长达数分钟的等待，否则客户端会一直等首字节
    // 而超时。头一发出去连接就建立了，后续写多少都不会被判定为无响应。
    if (wantsStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
    }

    const liveCompletionId = `chatcmpl-${Date.now()}`;
    let liveStreamed = false;
    const result = await completeWithProvider(
      {
        ...payload,
        provider,
        model: payload.model ?? `${provider}-web`,
        messages: payload.messages,
      },
      wantsStream
        ? {
            onDelta: (delta) => {
              if (liveStreamed) {
                return;
              }
              liveStreamed = true;
              writeSse(res, {
                id: liveCompletionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: payload.model ?? `${provider}-web`,
                provider,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant',
                      ...(delta.reasoningDelta ? { reasoning_content: delta.reasoningDelta } : {}),
                      ...(delta.contentDelta ? { content: delta.contentDelta } : {}),
                    },
                    finish_reason: null,
                  },
                ],
              });
            },
          }
        : undefined,
    );

    if (result.dryRun) {
      res.json({
        ok: true,
        dryRun: true,
        provider,
        model: result.model,
        conversationId: result.conversationId ?? null,
        prompt: result.prompt,
        debug: result.debug,
      });
      return;
    }

    if (wantsStream) {
      // 已经通过 onDelta 实时推过 delta 的话，就不要再把全文重推一遍。
      const completionId = liveStreamed ? liveCompletionId : `chatcmpl-${Date.now()}`;
      for (const chunk of buildChatCompletionChunks({
        id: completionId,
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        provider,
        conversationId: result.conversationId ?? null,
        url: result.url,
        content: result.content,
        reasoningContent: result.reasoningContent,
      })) {
        writeSse(res, chunk);
      }
      finishSse(res);
      return;
    }

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      provider,
      // 调用方没传 conversationId 时，这里是 bridge 从页面 URL 抽出的真实会话 id。
      // 把它带回去再发下一次，就等于"继续这条对话"，bridge 会复用同一个标签页；
      // 不带则表示"开新对话"，bridge 新建标签页并导航到新对话页。
      conversationId: result.conversationId ?? null,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content,
            reasoning_content: result.reasoningContent ?? null,
          },
          finish_reason: 'stop',
        },
      ],
      page: {
        url: result.url,
      },
      debug: result.debug,
      ...(result.capturedFromStream ? { capturedFromStream: true } : {}),
      usage: result.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  } catch (error) {
    await revealRelevantSessionOnError(req.body ?? {}, effectiveMeetingConversationId);
    const message = error instanceof Error ? error.message : '请求失败';
    const status = error instanceof z.ZodError ? 400 : 500;

    if (req.body?.stream) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
      }
      // 会议模式和非会议模式的错误帧形状不一样：
      // 会议是 bridge 自己在编排多 provider，事件里带 type；
      // 普通对话走 OpenAI 形状，错误放在 delta 里，否则按 OpenAI 协议解析的
      // 客户端会收到一个没有 choices 的陌生事件而报错。
      const detailedMessage = `${message}；如果这是登录、风控、额度或网络问题，请在控制台的「会话管理」里打开该 provider 的页面手动处理。`;
      if (effectiveMeetingConversationId) {
        writeSse(res, { type: 'meeting.error', error: { message: detailedMessage } });
      } else {
        writeSse(res, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: String(req.body?.model ?? appConfig.defaultProvider),
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
              error: { message: detailedMessage },
            },
          ],
        });
      }
      finishSse(res);
      return;
    }

    res.status(status).json({
      error: {
        message: `${message}；如果这是登录、风控、额度或网络问题，请在控制台的「会话管理」里打开该 provider 的页面手动处理。`,
      },
    });
  }
});

const server = app.listen(appConfig.port, appConfig.host, async () => {
  console.log(`browser-ai-bridge listening on http://${appConfig.host}:${appConfig.port}`);
});

async function shutdown() {
  server.close();
  await browserManager.shutdown();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
