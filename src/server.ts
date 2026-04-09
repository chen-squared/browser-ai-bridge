import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { appConfig } from './config.js';
import { BrowserManager } from './browser/browser-manager.js';
import { ProviderClient } from './browser/provider-client.js';
import { normalizeMessages } from './prompt.js';
import {
  buildMeetingHintMapScript,
  buildMeetingOptionsHtml,
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

type NonSystemMessage = { role: 'user' | 'assistant'; content: string; name?: string };

type SyncPlan = {
  mode: 'fresh' | 'append' | 'rebuild';
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
      | 'append-blocked-by-assistant-delta'
      | 'context-diverged';
    matchedPrefixCount: number;
    divergenceIndex: number | null;
    deltaCount: number;
    containsSyntheticAssistant: boolean;
    transcriptMode: 'raw' | 'context-window';
  };
};

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
        .max(4)
        .optional(),
      rounds: z.number().int().min(1).max(4).optional(),
      summarizer: z.enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek']).optional(),
    })
    .optional(),
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
): Promise<{
  provider: ProviderId;
  model: string;
  conversationId?: string;
  url?: string;
  content?: string;
  reasoningContent?: string;
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

  const client = new ProviderClient(provider);
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

  return {
    provider,
    model: payload.model,
    conversationId: payload.conversationId,
    url: content.url,
    content: content.content,
    reasoningContent: content.reasoningContent,
    debug: content.debug,
  };
}

const browserManager = new BrowserManager();
const app = express();
const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const markedVendorDir = path.resolve(runtimeDir, '../node_modules/marked/lib');

app.use(cors());
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

function messagesEqual(left: NonSystemMessage, right: NonSystemMessage): boolean {
  if (left.role !== right.role || left.content !== right.content) {
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

function createSyncPlan(args: {
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
        transcriptMode,
      },
    };
  }

  const comparisonMessages =
    transcriptMode === 'context-window' ? currentContextMessages : currentMessages;
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
      transcriptMode,
    },
  };
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>browser-ai-bridge</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe5;
      --bg-2: #efe6d6;
      --panel: rgba(255, 252, 245, 0.86);
      --ink: #16181a;
      --muted: #596063;
      --line: rgba(126, 105, 78, 0.25);
      --accent: #0f766e;
      --accent-2: #b45309;
      --accent-3: #1d4ed8;
      --warn: #9a3412;
      --ok: #166534;
      --danger: #991b1b;
      --shadow: 0 24px 60px rgba(56, 43, 24, 0.10);
    }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      background:
        radial-gradient(circle at top left, rgba(255, 247, 223, 0.95), transparent 34%),
        radial-gradient(circle at top right, rgba(191, 219, 254, 0.45), transparent 28%),
        linear-gradient(180deg, var(--bg-2), var(--bg));
      color: var(--ink);
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 36px 20px 72px;
    }
    h1 {
      margin: 0;
      font-size: 48px;
      letter-spacing: -0.03em;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 28px;
    }
    h3 {
      margin: 0 0 10px;
      font-size: 20px;
    }
    p, li {
      font-size: 18px;
      line-height: 1.6;
      color: var(--muted);
    }
    .hero {
      display: grid;
      gap: 14px;
      padding: 28px;
      border-radius: 28px;
      background:
        linear-gradient(135deg, rgba(255,255,255,0.72), rgba(255,250,240,0.62)),
        radial-gradient(circle at top right, rgba(13, 148, 136, 0.14), transparent 30%);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .hero p {
      margin: 0;
      max-width: 820px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 22px;
      margin-top: 18px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
      margin-top: 18px;
    }
    code, pre {
      font-family: "SFMono-Regular", Menlo, Consolas, monospace;
      font-size: 14px;
    }
    pre {
      overflow: auto;
      background: #f5efe1;
      border-radius: 12px;
      padding: 14px;
      border: 1px solid var(--line);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 14px;
    }
    button, .button {
      border-radius: 999px;
      padding: 11px 17px;
      font-weight: 700;
      color: white;
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, white), var(--accent));
      border: 0;
      cursor: pointer;
      text-decoration: none;
      box-shadow: 0 8px 18px rgba(15, 118, 110, 0.22);
    }
    button.secondary, .button.secondary {
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent-2) 88%, white), var(--accent-2));
      box-shadow: 0 8px 18px rgba(180, 83, 9, 0.18);
    }
    button.tertiary, .button.tertiary {
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent-3) 88%, white), var(--accent-3));
      box-shadow: 0 8px 18px rgba(29, 78, 216, 0.18);
    }
    button:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .stack {
      display: grid;
      gap: 12px;
    }
    label {
      display: grid;
      gap: 8px;
      font-size: 15px;
      color: var(--muted);
      font-weight: 700;
    }
    textarea, input, select {
      width: 100%;
      box-sizing: border-box;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.78);
      padding: 12px 14px;
      font: inherit;
      color: var(--ink);
    }
    textarea {
      min-height: 120px;
      resize: vertical;
    }
    .status {
      border-left: 5px solid var(--accent-3);
      padding: 12px 14px;
      border-radius: 10px;
      background: rgba(37, 81, 122, 0.08);
      color: var(--ink);
      font-size: 16px;
      line-height: 1.5;
    }
    .status.ok {
      border-left-color: var(--ok);
      background: rgba(37, 89, 61, 0.09);
    }
    .status.warn {
      border-left-color: var(--warn);
      background: rgba(141, 75, 31, 0.1);
    }
    .status.error {
      border-left-color: var(--danger);
      background: rgba(138, 47, 47, 0.09);
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .pill {
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 13px;
      font-weight: 700;
      background: rgba(255,255,255,0.65);
      border: 1px solid var(--line);
      color: var(--ink);
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .small {
      font-size: 14px;
      color: var(--muted);
    }
    .meeting-app {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
      gap: 18px;
      align-items: stretch;
    }
    .meeting-sidebar {
      display: grid;
      gap: 14px;
      align-content: start;
    }
    .meeting-chat-panel {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 760px;
      overflow: hidden;
      padding: 0;
    }
    .meeting-chat-header {
      padding: 20px 22px 16px;
      border-bottom: 1px solid rgba(126, 105, 78, 0.14);
      background: linear-gradient(180deg, rgba(255,255,255,0.78), rgba(255,252,245,0.6));
    }
    .meeting-chat-header p {
      margin: 8px 0 0;
      font-size: 14px;
    }
    .meeting-chat-scroll {
      padding: 26px 22px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 18px;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.9), transparent 34%),
        linear-gradient(180deg, rgba(248, 244, 236, 0.45), rgba(255, 255, 255, 0.82));
    }
    .meeting-bubble-row {
      display: flex;
      gap: 12px;
      align-items: flex-end;
    }
    .meeting-bubble-row.user {
      justify-content: flex-end;
      flex-direction: row-reverse;
    }
    .meeting-bubble-row.assistant {
      justify-content: flex-start;
    }
    .meeting-avatar {
      width: 34px;
      height: 34px;
      border-radius: 999px;
      flex: 0 0 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font: 700 11px/1 "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
      letter-spacing: 0.08em;
      box-shadow: 0 8px 18px rgba(37, 31, 22, 0.10);
    }
    .meeting-avatar.user {
      background: linear-gradient(180deg, #0f172a, #1e293b);
      color: #f8fafc;
    }
    .meeting-avatar.assistant {
      background: linear-gradient(180deg, #fff, #e8edf4);
      border: 1px solid rgba(126, 105, 78, 0.16);
      color: #111827;
    }
    .meeting-bubble-stack {
      max-width: min(78%, 740px);
      display: grid;
      gap: 7px;
    }
    .meeting-bubble-row.user .meeting-bubble-stack {
      margin-left: auto;
      justify-items: end;
      text-align: right;
    }
    .meeting-bubble-row.assistant .meeting-bubble-stack {
      margin-right: auto;
      justify-items: start;
      text-align: left;
    }
    .meeting-bubble-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      font: 600 12px/1.4 "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      color: #6b7280;
      padding: 0 4px;
    }
    .meeting-bubble {
      border-radius: 22px;
      padding: 15px 17px;
      border: 1px solid rgba(126, 105, 78, 0.14);
      box-shadow: 0 16px 34px rgba(56, 43, 24, 0.08);
      font-size: 15px;
      line-height: 1.74;
      overflow-wrap: anywhere;
    }
    .meeting-bubble-row.user .meeting-bubble {
      background: linear-gradient(180deg, #1f2937, #111827);
      color: #f9fafb;
      border-bottom-right-radius: 8px;
      border-color: rgba(17, 24, 39, 0.8);
    }
    .meeting-bubble-row.assistant .meeting-bubble {
      background: linear-gradient(180deg, #ffffff, #f8fafc);
      color: #111827;
      border-bottom-left-radius: 8px;
    }
    .meeting-reasoning {
      width: 100%;
      border: 1px solid rgba(126, 105, 78, 0.14);
      border-radius: 16px;
      background: rgba(255, 251, 245, 0.86);
      overflow: hidden;
    }
    .meeting-reasoning summary {
      cursor: pointer;
      list-style: none;
      padding: 12px 14px;
      font: 600 13px/1.4 "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      color: #5b4630;
      user-select: none;
    }
    .meeting-reasoning summary::-webkit-details-marker {
      display: none;
    }
    .meeting-reasoning summary::after {
      content: '展开';
      float: right;
      color: #8b7355;
      font-weight: 500;
    }
    .meeting-reasoning[open] summary::after {
      content: '收起';
    }
    .meeting-reasoning-body {
      display: grid;
      gap: 10px;
      padding: 0 14px 14px;
      border-top: 1px solid rgba(126, 105, 78, 0.1);
      background: linear-gradient(180deg, rgba(255,255,255,0.72), rgba(250,245,236,0.82));
    }
    .meeting-reasoning-entry {
      display: grid;
      gap: 6px;
      padding: 12px 0 0;
    }
    .meeting-reasoning-entry + .meeting-reasoning-entry {
      border-top: 1px dashed rgba(126, 105, 78, 0.16);
    }
    .meeting-reasoning-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      font: 600 12px/1.4 "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      color: #6b7280;
    }
    .meeting-reasoning-chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      background: rgba(219, 199, 167, 0.28);
      color: #6b4f30;
    }
    .meeting-reasoning-content {
      font-size: 14px;
      line-height: 1.7;
      color: #1f2937;
    }
    .meeting-markdown {
      display: grid;
      gap: 0.8em;
    }
    .meeting-markdown > :first-child {
      margin-top: 0;
    }
    .meeting-markdown > :last-child {
      margin-bottom: 0;
    }
    .meeting-markdown p,
    .meeting-markdown ul,
    .meeting-markdown ol,
    .meeting-markdown pre,
    .meeting-markdown blockquote,
    .meeting-markdown table,
    .meeting-markdown h1,
    .meeting-markdown h2,
    .meeting-markdown h3,
    .meeting-markdown h4 {
      margin: 0;
    }
    .meeting-markdown h1,
    .meeting-markdown h2,
    .meeting-markdown h3,
    .meeting-markdown h4 {
      line-height: 1.25;
      letter-spacing: -0.01em;
    }
    .meeting-markdown ul,
    .meeting-markdown ol {
      padding-left: 1.3rem;
    }
    .meeting-markdown li + li {
      margin-top: 0.28rem;
    }
    .meeting-markdown code {
      font-family: "SFMono-Regular", "JetBrains Mono", Consolas, monospace;
      font-size: 0.92em;
      padding: 0.14em 0.36em;
      border-radius: 8px;
      background: rgba(148, 163, 184, 0.18);
    }
    .meeting-markdown pre {
      overflow-x: auto;
      padding: 0.9rem 1rem;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.94);
      color: #e5eef8;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
    }
    .meeting-markdown pre code {
      padding: 0;
      background: transparent;
      color: inherit;
    }
    .meeting-markdown table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.94em;
      border-radius: 14px;
      overflow: hidden;
      border: 1px solid rgba(126, 105, 78, 0.16);
    }
    .meeting-markdown th,
    .meeting-markdown td {
      padding: 0.6rem 0.72rem;
      border-bottom: 1px solid rgba(126, 105, 78, 0.12);
      text-align: left;
      vertical-align: top;
    }
    .meeting-markdown th {
      background: rgba(219, 199, 167, 0.2);
      font-weight: 700;
    }
    .meeting-markdown blockquote {
      padding-left: 0.9rem;
      border-left: 3px solid rgba(217, 119, 6, 0.45);
      color: #6b4f30;
    }
    .meeting-markdown a {
      color: #0f766e;
    }
    .meeting-markdown-user {
      color: inherit;
    }
    .meeting-bubble-row.user .meeting-markdown,
    .meeting-bubble-row.user .meeting-markdown p,
    .meeting-bubble-row.user .meeting-markdown li,
    .meeting-bubble-row.user .meeting-markdown ul,
    .meeting-bubble-row.user .meeting-markdown ol,
    .meeting-bubble-row.user .meeting-markdown strong,
    .meeting-bubble-row.user .meeting-markdown em,
    .meeting-bubble-row.user .meeting-markdown h1,
    .meeting-bubble-row.user .meeting-markdown h2,
    .meeting-bubble-row.user .meeting-markdown h3,
    .meeting-bubble-row.user .meeting-markdown h4,
    .meeting-bubble-row.user .meeting-markdown h5,
    .meeting-bubble-row.user .meeting-markdown h6,
    .meeting-bubble-row.user .meeting-markdown td,
    .meeting-bubble-row.user .meeting-markdown th {
      color: #f8fafc;
    }
    .meeting-bubble-row.user .meeting-markdown code {
      background: rgba(255,255,255,0.12);
      color: #f8fafc;
    }
    .meeting-bubble-row.user .meeting-markdown blockquote {
      color: rgba(248, 250, 252, 0.88);
      border-left-color: rgba(255,255,255,0.35);
    }
    .meeting-bubble-row.user .meeting-markdown a {
      color: #dbeafe;
    }
    .meeting-bubble-row.user .meeting-markdown table,
    .meeting-bubble-row.user .meeting-markdown th,
    .meeting-bubble-row.user .meeting-markdown td {
      border-color: rgba(255,255,255,0.14);
    }
    .meeting-bubble-row.user .meeting-markdown th {
      background: rgba(255,255,255,0.1);
    }
    .meeting-bubble.pending {
      position: relative;
      overflow: hidden;
    }
    .meeting-bubble.pending::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.16) 50%, transparent 100%);
      transform: translateX(-100%);
      animation: meetingShimmer 1.4s infinite;
    }
    .meeting-spinner {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }
    .meeting-spinner-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.35;
      animation: meetingPulse 1.2s infinite;
    }
    .meeting-spinner-dot:nth-child(2) {
      animation-delay: 0.15s;
    }
    .meeting-spinner-dot:nth-child(3) {
      animation-delay: 0.3s;
    }
    @keyframes meetingPulse {
      0%, 80%, 100% { opacity: 0.28; transform: scale(0.92); }
      40% { opacity: 0.9; transform: scale(1); }
    }
    @keyframes meetingShimmer {
      from { transform: translateX(-100%); }
      to { transform: translateX(100%); }
    }
    .meeting-composer {
      display: grid;
      gap: 12px;
      padding: 18px 22px 22px;
      border-top: 1px solid rgba(126, 105, 78, 0.14);
      background: linear-gradient(180deg, rgba(255,255,255,0.68), rgba(255,252,245,0.92));
    }
    .meeting-composer textarea {
      min-height: 108px;
      border-radius: 18px;
      padding: 14px 16px;
      background: rgba(255,255,255,0.92);
    }
    .meeting-inline-actions {
      display: flex;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .meeting-detail-box {
      min-height: 220px;
      max-height: 320px;
    }
    @media (max-width: 960px) {
      .meeting-app {
        grid-template-columns: 1fr;
      }
      .meeting-chat-panel {
        min-height: 680px;
      }
      .meeting-bubble-stack {
        max-width: 100%;
      }
    }
  </style>
    <script src="/vendor/marked/marked.umd.js"></script>
</head>
<body>
  <main>
    <section class="hero">
      <h1>browser-ai-bridge</h1>
      <p>这是本地网页 AI 桥接控制台。你可以在这里打开任意 provider、查看当前会话、调试远端页面结构，并直接发送测试消息。</p>
    </section>

    <section class="panel stack">
      <h2>当前场景提示</h2>
      <div id="sshHint" class="status warn">如果服务运行在另一台带图形桌面的机器上，Playwright 打开的浏览器会出现在那台机器的桌面会话里。当前页面只负责触发打开动作和显示状态，不会直接嵌入远端浏览器窗口。</div>
      <div class="meta">
        <div class="pill">服务地址: http://${appConfig.host}:${appConfig.port}</div>
        <div class="pill">默认 provider: ${appConfig.defaultProvider}</div>
        <div class="pill">HEADLESS: ${String(appConfig.headless)}</div>
      </div>
    </section>

    <div class="grid">
      <section class="panel stack">
        <h3>服务状态</h3>
        <label>
          当前 Provider
          <select id="controlProviderSelect">
            <option value="deepseek" selected>deepseek</option>
            <option value="chatgpt">chatgpt</option>
            <option value="gemini">gemini</option>
            <option value="claude">claude</option>
            <option value="grok">grok</option>
            <option value="qwen">qwen</option>
          </select>
        </label>
        <div class="actions">
          <button id="refreshStatusBtn" type="button">刷新状态</button>
          <button id="reloadSelectorsBtn" type="button" class="secondary">重载 Selector</button>
          <button id="loadProviderBtn" type="button" class="tertiary">查看当前 Provider 配置</button>
          <button id="listSessionsBtn" type="button" class="secondary">查看当前会话</button>
        </div>
        <div id="statusBox" class="status">还没有加载状态。</div>
        <pre id="providerBox">点击“查看当前 Provider 配置”后，这里会显示格式化配置。</pre>
        <pre id="sessionBox">点击“查看当前会话”后，这里会显示当前内存中的会话和 conversationId。</pre>
      </section>

      <section class="panel stack">
        <h3>登录与会话</h3>
        <p class="small">日常发送默认在后台复用现有页签运行，不主动抢前台。只有你点这里，或者服务检测到需要人工登录/解风控时，才会把对应 provider 页签切到前台。</p>
        <div class="actions">
          <button id="openDeepSeekBtn" type="button">打开当前 Provider 页面</button>
          <button id="inspectPageBtn" type="button" class="tertiary">调试当前页面</button>
          <button id="clearSessionBtn" type="button" class="secondary">清理当前 conversationId</button>
        </div>
        <div id="openSessionBox" class="status">还没有执行打开操作。</div>
        <pre id="inspectBox">点击“调试当前页面”后，这里会显示当前远端页面上的按钮、输入框和标题。</pre>
      </section>
    </div>

    <section class="panel stack">
      <h3>测试消息</h3>
      <label>
        Provider
        <select id="providerSelect">
          <option value="deepseek" selected>deepseek</option>
          <option value="chatgpt">chatgpt</option>
          <option value="gemini">gemini</option>
          <option value="claude">claude</option>
          <option value="grok">grok</option>
          <option value="qwen">qwen</option>
        </select>
      </label>
      <label>
        conversationId
        <input id="conversationIdInput" placeholder="留空=OpenAI 兼容 best effort 模式；填写后=绑定到指定 conversationId" />
      </label>
      <div class="grid">
        <label>
          <span>智能搜索</span>
          <select id="searchModeSelect">
            <option value="auto">auto</option>
            <option value="on" selected>on</option>
            <option value="off">off</option>
          </select>
        </label>
        <label>
          <span>深度思考</span>
          <select id="reasoningModeSelect">
            <option value="auto">auto</option>
            <option value="on" selected>on</option>
            <option value="off">off</option>
          </select>
        </label>
      </div>
      <label>
        用户消息
        <textarea id="userPrompt">用一句话解释 TCP 和 UDP 的区别。</textarea>
      </label>
      <div class="actions">
        <button id="sendTestBtn" type="button">发送测试消息</button>
      </div>
      <div id="chatStatusBox" class="status">还没有发送测试消息。</div>
      <pre id="chatResponseBox">发送成功后，这里会显示格式化响应。</pre>
    </section>

    <section class="panel stack">
      <h2>轻量会议试玩</h2>
      <p class="small">这里直接调用特殊模型名。用户消息保持普通 user 消息格式，中间讨论作为 reasoning_content，最终汇总作为 assistant 回复。</p>
      <div class="meeting-app">
        <aside class="meeting-sidebar">
          <label>
            会议模型
            <select id="meetingModelSelect">
              ${buildMeetingOptionsHtml()}
            </select>
          </label>
          <label>
            conversationId
            <input id="meetingConversationIdInput" placeholder="留空时首次发送自动生成，之后页面会复用" />
          </label>
          <label>
            轮数
            <input id="meetingRoundsInput" type="number" min="1" max="4" value="2" />
          </label>
          <label>
            参与者（逗号分隔 provider）
            <input id="meetingParticipantsInput" value="deepseek,chatgpt,qwen" />
          </label>
          <label>
            总结人 provider
            <input id="meetingSummarizerInput" value="deepseek" />
          </label>
          <p class="small">规则：如果 summarizer provider 也出现在 participants 里，则第一个匹配到的 member 会兼任统筹者，固定先发言并最后总结；否则会额外创建独立统筹者会话。participants 的顺序决定其余 member 的发言顺序；重复 provider 会被视为不同 member 会话。</p>
          <div id="meetingStatusBox" class="status">还没有开始会议。</div>
          <pre id="meetingDetailsBox" class="meeting-detail-box">发送后这里会显示模板、参与者、会话号和 reasoning transcript。</pre>
        </aside>
        <div class="panel meeting-chat-panel">
          <div class="meeting-chat-header">
            <h3 style="margin:0;">Meeting Chat</h3>
            <p id="meetingTemplateHint">多个网页 AI 会围绕你的普通用户消息快速拆题协作，最后只返回统一答复。</p>
          </div>
          <div id="meetingChatScroll" class="meeting-chat-scroll"></div>
          <div class="meeting-composer">
            <textarea id="meetingComposerInput" placeholder="输入一条普通用户消息，例如：请帮我比较这三个实现方向的取舍。"></textarea>
            <div class="meeting-inline-actions">
              <div class="actions" style="margin-top:0;">
                <button id="meetingSendBtn" type="button">发送到会议</button>
                <button id="meetingResetBtn" type="button" class="secondary">重置对话</button>
              </div>
              <span class="small">当前页面会把最终总结显示成主对话，把中间会议过程放到 reasoning transcript。</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="panel stack">
      <h3>对应的 API</h3>
      <pre>POST /session/:provider/open
    POST /providers/reload
    GET  /providers/:provider
        <pre>GET  /health
      GET  /providers
      GET  /providers/:provider
      GET  /sessions
      POST /providers/reload
      POST /session/:provider/open
      GET  /session/:provider/inspect
      POST /session/:provider/clear
      POST /v1/chat/completions</pre>
    </section>
  </main>
  <script>
    const statusBox = document.getElementById('statusBox');
    const providerBox = document.getElementById('providerBox');
    const sessionBox = document.getElementById('sessionBox');
    const openSessionBox = document.getElementById('openSessionBox');
    const inspectBox = document.getElementById('inspectBox');
    const chatStatusBox = document.getElementById('chatStatusBox');
    const chatResponseBox = document.getElementById('chatResponseBox');
    const meetingStatusBox = document.getElementById('meetingStatusBox');
    const meetingDetailsBox = document.getElementById('meetingDetailsBox');
    const meetingChatScroll = document.getElementById('meetingChatScroll');

    const refreshStatusBtn = document.getElementById('refreshStatusBtn');
    const reloadSelectorsBtn = document.getElementById('reloadSelectorsBtn');
    const loadProviderBtn = document.getElementById('loadProviderBtn');
    const listSessionsBtn = document.getElementById('listSessionsBtn');
    const openDeepSeekBtn = document.getElementById('openDeepSeekBtn');
    const inspectPageBtn = document.getElementById('inspectPageBtn');
    const clearSessionBtn = document.getElementById('clearSessionBtn');
    const sendTestBtn = document.getElementById('sendTestBtn');
    const meetingSendBtn = document.getElementById('meetingSendBtn');
    const meetingResetBtn = document.getElementById('meetingResetBtn');

    const controlProviderSelect = document.getElementById('controlProviderSelect');
    const providerSelect = document.getElementById('providerSelect');
    const conversationIdInput = document.getElementById('conversationIdInput');
    const searchModeSelect = document.getElementById('searchModeSelect');
    const reasoningModeSelect = document.getElementById('reasoningModeSelect');
    const userPrompt = document.getElementById('userPrompt');
    const meetingModelSelect = document.getElementById('meetingModelSelect');
    const meetingConversationIdInput = document.getElementById('meetingConversationIdInput');
    const meetingRoundsInput = document.getElementById('meetingRoundsInput');
    const meetingParticipantsInput = document.getElementById('meetingParticipantsInput');
    const meetingSummarizerInput = document.getElementById('meetingSummarizerInput');
    const meetingComposerInput = document.getElementById('meetingComposerInput');
    const meetingTemplateHint = document.getElementById('meetingTemplateHint');

    let meetingMessages = [];
    let meetingPendingState = null;
    let meetingPendingTimer = null;
    let meetingLiveTranscript = [];
    let meetingLiveMeta = null;
    let meetingLiveReasoningKey = null;
    let meetingProgressMeta = null;
    const meetingExpandedReasoningKeys = new Set();
    const meetingTemplateHints = ${buildMeetingHintMapScript()};

    function setStatus(element, kind, text) {
      element.className = 'status' + (kind ? ' ' + kind : '');
      element.textContent = text;
    }

    function pretty(value) {
      return JSON.stringify(value, null, 2);
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    }

    function formatMeetingStage(entry) {
      if (entry.stage === 'assignment') {
        return '拆分任务 / 统筹初判';
      }
      if (entry.stage === 'summary') {
        return '最终总结';
      }
      if (entry.stage === 'discussion') {
        return entry.round ? '第 ' + entry.round + ' 轮讨论' : '讨论';
      }
      return '输入';
    }

    function renderMarkdownHtml(value, variant = 'default') {
      const safeSource = escapeHtml(value || '');
      const rendered = typeof globalThis.marked?.parse === 'function'
        ? globalThis.marked.parse(safeSource, {
            gfm: true,
            breaks: true,
          })
        : safeSource.split('\\n').join('<br>');
      return '<div class="meeting-markdown meeting-markdown-' + variant + '">' + rendered + '</div>';
    }

    function renderMeetingReasoningDetails(message, reasoningKey) {
      const transcript = Array.isArray(message.transcript) ? message.transcript : [];
      const visibleEntries = transcript.filter((entry) => entry && entry.role === 'assistant' && (entry.stage === 'assignment' || entry.stage === 'discussion'));

      if (visibleEntries.length === 0) {
        return '';
      }

      const entriesHtml = visibleEntries.map((entry) => {
        const metaParts = [
          '<span>' + escapeHtml(entry.speaker || 'assistant') + '</span>',
          '<span class="meeting-reasoning-chip">' + escapeHtml(formatMeetingStage(entry)) + '</span>',
        ];

        if (entry.provider) {
          metaParts.push('<span>' + escapeHtml(entry.provider) + '</span>');
        }

        return '<div class="meeting-reasoning-entry">'
          + '<div class="meeting-reasoning-meta">' + metaParts.join('') + '</div>'
          + '<div class="meeting-reasoning-content">' + renderMarkdownHtml(entry.content || '', 'reasoning') + '</div>'
          + '</div>';
      }).join('');

      const openAttr = reasoningKey && meetingExpandedReasoningKeys.has(reasoningKey) ? ' open' : '';
      const keyAttr = reasoningKey ? ' data-reasoning-key="' + escapeHtml(reasoningKey) + '"' : '';
      return '<details class="meeting-reasoning"' + keyAttr + openAttr + '><summary>查看本次会议里每个 AI 说了什么</summary><div class="meeting-reasoning-body">' + entriesHtml + '</div></details>';
    }

    function buildMeetingTranscriptText(transcript) {
      if (!Array.isArray(transcript) || transcript.length === 0) {
        return '(空)';
      }

      const visibleEntries = transcript.filter((entry) => entry && entry.role === 'assistant' && (entry.stage === 'assignment' || entry.stage === 'discussion'));
      if (visibleEntries.length === 0) {
        return '(空)';
      }

      return visibleEntries.map((entry) => {
        const suffix = entry.provider ? ' · ' + entry.provider : '';
        return '### ' + formatMeetingStage(entry) + ' · ' + (entry.speaker || 'assistant') + suffix + '\\n' + (entry.content || '');
      }).join('\\n\\n');
    }

    function refreshMeetingLiveDetails() {
      if (!meetingPendingState && !meetingLiveMeta && meetingLiveTranscript.length === 0) {
        return;
      }

      meetingDetailsBox.textContent = [
        'meeting:',
        pretty(meetingLiveMeta || {}),
        '',
        'reasoning transcript:',
        buildMeetingTranscriptText(meetingLiveTranscript),
        '',
        'status:',
        meetingPendingState ? meetingPendingState.label : 'completed',
      ].join('\\n');
    }

    async function requestEventStream(url, payload, onEvent) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        const errorPayload = contentType.includes('application/json') ? await response.json() : await response.text();
        const errorText = typeof errorPayload === 'string' ? errorPayload : errorPayload?.error?.message || pretty(errorPayload);
        throw new Error(errorText);
      }

      if (!response.body) {
        throw new Error('服务端没有返回可读取的流');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          buffer += decoder.decode();
        } else {
          buffer += decoder.decode(chunk.value, { stream: true });
        }

        let boundaryIndex = buffer.indexOf('\\n\\n');
        while (boundaryIndex >= 0) {
          const rawEvent = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          const data = rawEvent
            .split('\\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\\n');

          if (data) {
            if (data === '[DONE]') {
              return;
            }
            onEvent(JSON.parse(data));
          }

          boundaryIndex = buffer.indexOf('\\n\\n');
        }

        if (chunk.done) {
          return;
        }
      }
    }

    function renderMeetingChat() {
      const pendingTranscriptHtml = meetingLiveTranscript.length ? renderMeetingReasoningDetails({ transcript: meetingLiveTranscript }, meetingLiveReasoningKey) : '';
      const pendingHtml = meetingPendingState
        ? '<div class="meeting-bubble-row assistant">'
          + '<div class="meeting-avatar assistant">AI</div>'
          + '<div class="meeting-bubble-stack">'
          + '<div class="meeting-bubble-meta"><span>会议助手</span><span>' + escapeHtml(meetingPendingState.label) + '</span></div>'
          + '<div class="meeting-bubble pending"><span class="meeting-spinner"><span class="meeting-spinner-dot"></span><span class="meeting-spinner-dot"></span><span class="meeting-spinner-dot"></span></span> 正在开会，已等待 ' + meetingPendingState.seconds + ' 秒</div>'
          + pendingTranscriptHtml
          + '</div></div>'
        : '';

      if (meetingMessages.length === 0) {
        meetingChatScroll.innerHTML = '<div class="meeting-bubble-row assistant"><div class="meeting-avatar assistant">AI</div><div class="meeting-bubble-stack"><div class="meeting-bubble-meta"><span>会议助手</span><span>准备就绪</span></div><div class="meeting-bubble">从这里开始提问。系统会把你的消息当作普通 user 消息，然后调用特殊会议模型，让多个 provider 自动讨论并输出统一答复。</div></div></div>' + pendingHtml;
        return;
      }

      meetingChatScroll.innerHTML = meetingMessages.map((message, index) => {
        const kind = message.role === 'user' ? 'user' : 'assistant';
        const title = kind === 'user' ? '你' : '会议助手';
        const reasoningDetails = kind === 'assistant' ? renderMeetingReasoningDetails(message, message.reasoningKey || ('message-' + index)) : '';
        return '<div class="meeting-bubble-row ' + kind + '">' +
          '<div class="meeting-avatar ' + kind + '">' + (kind === 'user' ? 'YOU' : 'AI') + '</div>' +
          '<div class="meeting-bubble-stack ' + kind + '">' +
          '<div class="meeting-bubble-meta"><span>' + title + '</span><span>第 ' + (index + 1) + ' 条</span></div>' +
          '<div class="meeting-bubble">' + renderMarkdownHtml(message.content, kind) + '</div>' +
          reasoningDetails +
          '</div></div>';
      }).join('') + pendingHtml;
      meetingChatScroll.querySelectorAll('.meeting-reasoning').forEach((element) => {
        element.addEventListener('toggle', () => {
          const reasoningKey = element.getAttribute('data-reasoning-key');
          if (!reasoningKey) {
            return;
          }
          if (element.open) {
            meetingExpandedReasoningKeys.add(reasoningKey);
          } else {
            meetingExpandedReasoningKeys.delete(reasoningKey);
          }
        });
      });
      meetingChatScroll.scrollTop = meetingChatScroll.scrollHeight;
    }

    function stopMeetingPending() {
      meetingPendingState = null;
      if (meetingPendingTimer) {
        clearInterval(meetingPendingTimer);
        meetingPendingTimer = null;
      }
      meetingSendBtn.disabled = false;
      meetingResetBtn.disabled = false;
      refreshMeetingLiveDetails();
    }

    function startMeetingPending() {
      const startedAt = Date.now();
      meetingPendingState = { label: '正在启动协作', seconds: 0 };
      meetingProgressMeta = {
        discussionExpected: 0,
        discussionSeen: 0,
      };
      meetingSendBtn.disabled = true;
      meetingResetBtn.disabled = true;
      if (meetingPendingTimer) {
        clearInterval(meetingPendingTimer);
      }
      meetingPendingTimer = setInterval(() => {
        const elapsed = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
        meetingPendingState = {
          label: meetingPendingState ? meetingPendingState.label : '正在启动协作',
          seconds: elapsed,
        };
        refreshMeetingLiveDetails();
        renderMeetingChat();
      }, 1000);
    }

    function syncMeetingTemplateHint() {
      const value = meetingModelSelect.value;
      meetingTemplateHint.textContent = meetingTemplateHints[value] || '多个网页 AI 会围绕你的普通用户消息快速拆题协作，最后只返回统一答复。';
    }

    function buildMeetingDetailsText(payload, reasoningText) {
      return [
        'meeting:',
        pretty(payload.meeting || {}),
        '',
        'reasoning transcript:',
        reasoningText || '(空)',
        '',
        'full response:',
        pretty(payload),
      ].join('\\n');
    }

    function buildMeetingErrorText() {
      return [
        '会议请求失败。常见原因:',
        '1. 某个 provider 当前未登录。',
        '2. 某个网页要求手动选择候选回答。',
        '3. 某个网页正在限额、掉线或网络异常。',
        '4. 某个 selector 变化导致无法发送。',
      ].join('\\n');
    }

    async function requestJson(url, options) {
      const response = await fetch(url, options);
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json') ? await response.json() : await response.text();

      if (!response.ok) {
        const errorText = typeof payload === 'string' ? payload : payload?.error?.message || pretty(payload);
        throw new Error(errorText);
      }

      return payload;
    }

    async function refreshStatus() {
      setStatus(statusBox, '', '正在读取服务状态...');
      try {
        const health = await requestJson('/health');
        const lines = [
          '服务正常。',
          'defaultProvider: ' + health.defaultProvider,
          'headless: ' + health.headless,
        ];
        setStatus(statusBox, 'ok', lines.join('\\n'));
      } catch (error) {
        setStatus(statusBox, 'error', '读取服务状态失败: ' + error.message);
      }
    }

    async function loadProvider() {
      const provider = controlProviderSelect.value;
      providerBox.textContent = '正在读取 ' + provider + ' 配置...';
      try {
        const payload = await requestJson('/providers/' + provider);
        providerBox.textContent = pretty(payload);
      } catch (error) {
        providerBox.textContent = '读取配置失败:\\n' + error.message;
      }
    }

    async function reloadSelectors() {
      setStatus(statusBox, '', '正在重载 selector 配置...');
      try {
        const payload = await requestJson('/providers/reload', { method: 'POST' });
        setStatus(statusBox, 'ok', 'selector 已重载。覆盖文件路径: ' + payload.selectorOverridesPath);
        await loadProvider();
      } catch (error) {
        setStatus(statusBox, 'error', '重载 selector 失败: ' + error.message);
      }
    }

    async function loadSessions() {
      sessionBox.textContent = '正在读取当前会话...';
      try {
        const payload = await requestJson('/sessions');
        sessionBox.textContent = pretty(payload);
      } catch (error) {
        sessionBox.textContent = '读取会话失败:\\n' + error.message;
      }
    }

    async function openDeepSeek() {
      const provider = controlProviderSelect.value;
      setStatus(openSessionBox, '', '正在请求打开 ' + provider + ' 页面...');
      try {
        const payload = await requestJson('/session/' + provider + '/open', { method: 'POST' });
        const lines = [
          '已触发打开动作。',
          'provider: ' + payload.provider,
          'currentUrl: ' + payload.url,
          '注意: 浏览器会出现在当前服务所在机器的图形桌面会话中。',
        ];
        setStatus(openSessionBox, 'ok', lines.join('\\n'));
      } catch (error) {
        setStatus(openSessionBox, 'error', '打开 provider 失败: ' + error.message);
      }
    }

    async function inspectPage() {
      const provider = controlProviderSelect.value;
      const conversationId = conversationIdInput.value.trim();
      inspectBox.textContent = '正在抓取当前远端页面结构...';
      try {
        const query = conversationId ? '?conversationId=' + encodeURIComponent(conversationId) : '';
        const payload = await requestJson('/session/' + provider + '/inspect' + query);
        inspectBox.textContent = pretty(payload);
      } catch (error) {
        inspectBox.textContent = '抓取页面结构失败:\\n' + error.message;
      }
    }

    async function clearSession() {
      const provider = controlProviderSelect.value;
      const conversationId = conversationIdInput.value.trim();
      if (!conversationId) {
        setStatus(openSessionBox, '', '正在清理该 provider 的默认 best effort 会话...');
      } else {
        setStatus(openSessionBox, '', '正在清理当前 conversationId 对应的会话...');
      }
      try {
        const payload = await requestJson('/session/' + provider + '/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conversationId || undefined }),
        });
        setStatus(openSessionBox, 'ok', '会话已清理: ' + pretty(payload));
        await loadSessions();
      } catch (error) {
        setStatus(openSessionBox, 'error', '清理会话失败: ' + error.message);
      }
    }

    async function sendTest() {
      const provider = providerSelect.value;
      const conversationId = conversationIdInput.value.trim();
      const user = userPrompt.value.trim();
      const searchMode = searchModeSelect.value;
      const reasoningMode = reasoningModeSelect.value;

      if (!user) {
        setStatus(chatStatusBox, 'warn', '请先填写“用户消息”。');
        return;
      }

      setStatus(chatStatusBox, '', '正在发送消息，请等待网页 AI 回复...');
      chatResponseBox.textContent = '等待响应中...';

      try {
        const payload = await requestJson('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            model: provider + '-web',
            conversationId: conversationId || undefined,
            enableSearch: searchMode === 'auto' ? undefined : searchMode === 'on',
            enableReasoning: reasoningMode === 'auto' ? undefined : reasoningMode === 'on',
            messages: [
              { role: 'user', content: user },
            ],
          }),
        });

        const assistantText = payload?.choices?.[0]?.message?.content || '';
          const reasoningText = payload?.choices?.[0]?.message?.reasoning_content || '';
        setStatus(chatStatusBox, 'ok', assistantText ? '收到回复了。下面是完整响应和提取出的回复文本。' : '请求成功，但没有提取到回复文本。');
          chatResponseBox.textContent = 'reasoning:\\n' + (reasoningText || '(空)') + '\\n\\nassistant:\\n' + (assistantText || '(空)') + '\\n\\nfull response:\\n' + pretty(payload);
      } catch (error) {
        setStatus(chatStatusBox, 'error', '发送失败: ' + error.message);
        chatResponseBox.textContent = '请求失败。常见原因:\\n1. 浏览器会话还没登录。\\n2. 当前 provider 页面结构变了，selector 失效。\\n3. 服务所在机器的图形桌面会话不可用或未完成登录。';
      }
    }

    async function sendMeetingMessage() {
      const content = meetingComposerInput.value.trim();
      if (!content) {
        setStatus(meetingStatusBox, 'warn', '请先输入用户消息。');
        return;
      }

      const messageHistory = [...meetingMessages, { role: 'user', content }];
      meetingMessages = messageHistory;
      meetingLiveTranscript = [];
      meetingLiveMeta = null;
      meetingLiveReasoningKey = 'meeting-turn-' + Date.now();
      meetingProgressMeta = null;
      renderMeetingChat();
      meetingComposerInput.value = '';
      setStatus(meetingStatusBox, '', '会议进行中，请等待多个 provider 完成讨论和汇总...');
      startMeetingPending();
      refreshMeetingLiveDetails();
      renderMeetingChat();

      try {
        const rounds = Number(meetingRoundsInput.value) || 2;
        const participants = meetingParticipantsInput.value.split(',').map((item) => item.trim()).filter(Boolean);
        const summarizer = meetingSummarizerInput.value.trim() || undefined;
        let payload = null;
        await requestEventStream('/v1/chat/completions', {
          model: meetingModelSelect.value,
          stream: true,
          conversationId: meetingConversationIdInput.value.trim() || undefined,
          messages: messageHistory,
          meeting: {
            rounds,
            participants: participants.length ? participants : undefined,
            summarizer,
          },
        }, (event) => {
          if (event?.type === 'meeting.started') {
            meetingLiveMeta = event.meeting || null;
            if (event?.meeting?.conversationId) {
              meetingConversationIdInput.value = event.meeting.conversationId;
            }
            const discussionParticipantsByRound = Array.isArray(event?.meeting?.policy?.discussionParticipantsByRound)
              ? event.meeting.policy.discussionParticipantsByRound
              : [];
            const discussionParticipants = Array.isArray(event?.meeting?.policy?.discussionParticipants)
              ? event.meeting.policy.discussionParticipants
              : [];
            const discussionExpected = discussionParticipantsByRound.length > 0
              ? discussionParticipantsByRound.reduce((sum, participants) => sum + (Array.isArray(participants) ? participants.length : 0), 0)
              : discussionParticipants.length * (Number(event?.meeting?.rounds) || 0);
            meetingProgressMeta = {
              discussionExpected,
              discussionSeen: 0,
            };
            if (meetingPendingState) {
              meetingPendingState = { ...meetingPendingState, label: '统筹者正在拆分问题' };
            }
            refreshMeetingLiveDetails();
            renderMeetingChat();
            return;
          }

          if (event?.type === 'meeting.entry') {
            meetingLiveTranscript = [...meetingLiveTranscript, event.entry];
            if (meetingPendingState) {
              let nextLabel = '统筹者正在整理最终答复';
              if (event.entry?.stage === 'assignment') {
                const expected = meetingProgressMeta?.discussionExpected || 0;
                nextLabel = expected > 0 ? '其他成员正在推进各自部分（0/' + expected + '）' : '统筹者正在整理最终答复';
              } else if (event.entry?.stage === 'discussion') {
                if (meetingProgressMeta) {
                  meetingProgressMeta = {
                    ...meetingProgressMeta,
                    discussionSeen: meetingProgressMeta.discussionSeen + 1,
                  };
                }
                const seen = meetingProgressMeta?.discussionSeen || 0;
                const expected = meetingProgressMeta?.discussionExpected || 0;
                nextLabel = seen < expected
                  ? (event.entry?.speaker || '成员') + ' 已提交，本轮还剩 ' + (expected - seen) + ' 条讨论消息'
                  : '统筹者正在整理最终答复';
              }
              meetingPendingState = { ...meetingPendingState, label: nextLabel };
            }
            refreshMeetingLiveDetails();
            renderMeetingChat();
            return;
          }

          if (event?.type === 'meeting.completed') {
            payload = event.response;
            return;
          }

          if (event?.type === 'meeting.error') {
            throw new Error(event?.error?.message || '会议执行失败');
          }
        });

        if (!payload) {
          throw new Error('会议流已结束，但没有收到最终结果');
        }

        const assistantText = payload?.choices?.[0]?.message?.content || '';
        const reasoningText = payload?.choices?.[0]?.message?.reasoning_content || '';
        const nextConversationId = payload?.meeting?.conversationId || meetingConversationIdInput.value.trim();
        if (nextConversationId) {
          meetingConversationIdInput.value = nextConversationId;
        }
        meetingMessages = [...messageHistory, {
          role: 'assistant',
          content: assistantText,
          transcript: [...meetingLiveTranscript],
          reasoningKey: meetingLiveReasoningKey,
        }];
        stopMeetingPending();
        renderMeetingChat();
        meetingDetailsBox.textContent = buildMeetingDetailsText(payload, reasoningText);
        setStatus(meetingStatusBox, 'ok', assistantText ? '会议完成，已收到最终汇总。' : '会议完成，但最终汇总为空。');
      } catch (error) {
        stopMeetingPending();
        setStatus(meetingStatusBox, 'error', '会议失败: ' + error.message);
        meetingDetailsBox.textContent = buildMeetingErrorText();
      }
    }

    function resetMeetingChat() {
      stopMeetingPending();
      meetingMessages = [];
      meetingLiveTranscript = [];
      meetingLiveMeta = null;
      meetingLiveReasoningKey = null;
      meetingProgressMeta = null;
      meetingExpandedReasoningKeys.clear();
      meetingConversationIdInput.value = '';
      setStatus(meetingStatusBox, '', '已重置会议对话。');
      meetingDetailsBox.textContent = '发送后这里会显示模板、参与者、会话号和 reasoning transcript。';
      renderMeetingChat();
    }

    function syncProviderSelection() {
      providerSelect.value = controlProviderSelect.value;
    }

    refreshStatusBtn.addEventListener('click', refreshStatus);
    reloadSelectorsBtn.addEventListener('click', reloadSelectors);
    loadProviderBtn.addEventListener('click', loadProvider);
    listSessionsBtn.addEventListener('click', loadSessions);
    openDeepSeekBtn.addEventListener('click', openDeepSeek);
    inspectPageBtn.addEventListener('click', inspectPage);
    clearSessionBtn.addEventListener('click', clearSession);
    sendTestBtn.addEventListener('click', sendTest);
    meetingSendBtn.addEventListener('click', sendMeetingMessage);
    meetingResetBtn.addEventListener('click', resetMeetingChat);
    controlProviderSelect.addEventListener('change', () => {
      syncProviderSelection();
      loadProvider();
    });
    meetingModelSelect.addEventListener('change', syncMeetingTemplateHint);

    meetingChatScroll.addEventListener('toggle', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement) || !target.classList.contains('meeting-reasoning')) {
        return;
      }
      const reasoningKey = target.getAttribute('data-reasoning-key');
      if (!reasoningKey) {
        return;
      }
      if (target.open) {
        meetingExpandedReasoningKeys.add(reasoningKey);
      } else {
        meetingExpandedReasoningKeys.delete(reasoningKey);
      }
    });

    syncProviderSelection();
    syncMeetingTemplateHint();
    refreshStatus();
    loadProvider();
    loadSessions();
    renderMeetingChat();
  </script>
</body>
</html>`);
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
    })),
  });
});

app.get(['/models', '/v1/models'], (_req, res) => {
  res.json({
    object: 'list',
    data: listChatModels(),
  });
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
    const client = new ProviderClient(provider);
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

        await runMeetingCompletion(payload, meetingTemplate, completeWithProvider, {
          onProgress: async (event) => {
            if (event.type === 'meeting.started') {
              effectiveMeetingConversationId = event.meeting.conversationId;
            }
            writeSse(res, event);
          },
        });

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

    const provider = payload.provider ?? appConfig.defaultProvider;
    const result = await completeWithProvider({
      ...payload,
      provider,
      model: payload.model ?? `${provider}-web`,
      messages: payload.messages,
    });

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

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      provider,
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
      usage: {
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
      writeSse(res, {
        type: 'meeting.error',
        error: {
          message: `${message}；如果这是登录、风控、额度或网络问题，请查看已置前的浏览器页签并手动处理。`,
        },
      });
      finishSse(res);
      return;
    }

    res.status(status).json({
      error: {
        message: `${message}；如果这是登录、风控、额度或网络问题，请查看已置前的浏览器页签并手动处理。`,
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
