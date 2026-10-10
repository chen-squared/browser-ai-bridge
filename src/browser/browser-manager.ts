import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../config.js';
import { getProvider } from '../providers/registry.js';
import type { ProviderId } from '../types.js';
import {
  extractConversationId,
  isSameProviderHost,
  selectSessionsToEvict,
} from '../conversation-identity.js';
import {
  parseSseEvents,
  parseSseFrames,
  reduceChatgptStream,
  reduceClaudeConversation,
  reduceDeepseekStream,
  reduceGeminiStream,
  reduceGrokStream,
  reduceQwenStream,
  type ReducedStream,
} from '../stream-capture.js';

/** 每个标签页已捕获的流响应体。 */
type CapturedStream = {
  url: string;
  text: string;
  capturedAt: number;
};

/** WebSocket 捕获到的单帧。逐帧记录是为了保留时间信息——这是 TTFT 的前提。 */
type CapturedFrame = {
  url: string;
  text: string;
  capturedAt: number;
};

/** 闲置超过此时长的标签页会被回收。 */
const SESSION_IDLE_EVICT_MS = 2 * 60 * 60 * 1000;

/** 增量捕获的单次响应最多读多少块。64KB 一块，几百块足够覆盖任何正常回答。 */
const INCREMENTAL_STREAM_MAX_READS = 500;
/**
 * 每个 provider 最多保留多少个标签页。
 *
 * 必须容得下**一次会议里同一 provider 的全部席位**：6 个参与者 + 1 个总结者
 * 若全选同一家，就是 7 个标签页。原来定 3，于是并发建页时后建的把先建的挤掉关闭，
 * 表现为"未找到回复节点"或"发送按钮未确认提交成功"——看起来像站点问题，
 * 实际是自己把标签页回收了。取 8 留一点余量。
 */
const MAX_SESSIONS_PER_PROVIDER = 8;

type SyncedMessage = {
  role: 'user' | 'assistant';
  content: string;
  name?: string;
};

type SessionEntry = {
  page: Page;
  queue: Promise<unknown>;
  key: string;
  providerId: ProviderId;
  conversationId?: string;
  /** 从页面 URL 抽出的真实会话 id（发送后才有）。 */
  detectedConversationId?: string;
  createdAt: number;
  lastUsedAt: number;
  syncedMessages: SyncedMessage[];
};

type PersistentContextOptions = Parameters<typeof chromium.launchPersistentContext>[1];

export class BrowserManager {
  private context?: BrowserContext;
  private sessions = new Map<string, SessionEntry>();
  /**
   * 正在创建中的会话。旧实现在 runExclusive 的队列之外调用 getPage，
   * 而 getPage 内部要 await 建页，于是两个并发的首请求会各自建一个页面，
   * 后者覆盖 sessions 记录，前者变成永不关闭的孤儿标签页。
   */
  private creatingSessions = new Map<string, Promise<SessionEntry>>();
  /**
   * 已知的 conversationId -> 会话页 URL。
   *
   * conversationId 之前只被当作 sessions 的 key，从来不用于导航，于是标签页
   * 不存在时（新开、或重启后）只能导航到入口 URL——而入口 URL 往往会自动
   * 恢复"上一次"的对话。结果是：调用方传了 A 的 id，却被丢进 B 的对话里，
   * 而且毫无提示。记住 URL 才能让"带上 id = 继续这条对话"真正成立。
   */
  private knownConversationUrls = new Map<string, string>();
  /** 落盘串行化，避免并发写互相覆盖。 */
  private conversationUrlsFlush: Promise<void> = Promise.resolve();
  /**
   * 每个标签页抓到的流响应体。
   *
   * 走 Playwright 自己的 response 事件，**不往页面注入任何 JS**，所以站点无从
   * 检测这层观察。这是"读真流"里风险最低的一种做法。
   */
  private capturedStreams = new WeakMap<Page, CapturedStream[]>();
  /**
   * WebSocket 捕获到的帧。
   *
   * 走 `page.on('websocket')` + `framereceived`——**同样是 Playwright 的公开 API，
   * 页面里一行 JS 都不注入**，但帧是**实时事件**，所以保留了逐帧时间戳。
   * 这是目前唯一能在不注入页面的前提下拿到真首字延迟的路径。
   */
  private capturedFrames = new WeakMap<Page, CapturedFrame[]>();
  /** 已经挂过流监听的标签页，避免重复挂。 */
  private streamListening = new WeakSet<Page>();

  async init(): Promise<void> {
    if (this.context) {
      return;
    }

    await mkdir(appConfig.userDataDir, { recursive: true });
    await this.loadConversationUrls();

    const options: PersistentContextOptions = {
      headless: appConfig.headless,
      viewport: { width: 1440, height: 960 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    };

    if (appConfig.chromeExecutablePath) {
      options.executablePath = appConfig.chromeExecutablePath;
    } else if (appConfig.browserChannel) {
      options.channel = appConfig.browserChannel;
    }

    try {
      this.context = await chromium.launchPersistentContext(appConfig.userDataDir, options);
    } catch (error) {
      if (!this.isProcessSingletonError(error)) {
        throw error;
      }

      await this.clearSingletonArtifacts();
      try {
        this.context = await chromium.launchPersistentContext(appConfig.userDataDir, options);
      } catch (retryError) {
        if (this.isProcessSingletonError(retryError)) {
          throw new Error(
            `检测到残留 Chromium 仍在占用会话目录 ${appConfig.userDataDir}，bridge 目前无法重新接管这个持久 profile。请先关闭残留的 “Google Chrome for Testing” 进程后再重试。`,
            { cause: retryError },
          );
        }
        throw retryError;
      }
    }
  }

  /**
   * 取已有页签，**没有就返回 undefined**——绝不新建。
   *
   * 给诊断用：诊断接口不该有副作用，用 `getPage` 会在"我只是看看"的场景下
   * 凭空开一个标签页。
   */
  peekPage(providerId: ProviderId, conversationId?: string): Page | undefined {
    const entry = this.sessions.get(this.getSessionKey(providerId, conversationId));
    if (!entry || entry.page.isClosed()) {
      return undefined;
    }
    return entry.page;
  }

  async getPage(providerId: ProviderId, conversationId?: string): Promise<Page> {
    const entry = await this.ensureSession(providerId, conversationId);
    return entry.page;
  }

  /**
   * 拿到（或创建）会话，并把创建过程按 key 串行化。
   *
   * 复用前必须校验页面还在该 provider 的站点上：用户完全可能手动在那个标签页里
   * 点进别的对话或导航到别处，不校验就会静默把消息写进错误的页面，而 bridge
   * 自己的 transcript 仍以为一切正常。
   */
  private async ensureSession(
    providerId: ProviderId,
    conversationId?: string,
  ): Promise<SessionEntry> {
    await this.init();

    const sessionKey = this.getSessionKey(providerId, conversationId);
    const current = this.sessions.get(sessionKey);

    if (current) {
      if (!current.page.isClosed() && this.isSessionReusable(current)) {
        current.lastUsedAt = Date.now();
        return current;
      }

      // 页面已关闭，或被用户导航到了别处：丢弃旧记录（含 transcript）重建。
      this.sessions.delete(sessionKey);
      await current.page.close().catch(() => undefined);
    }

    const inFlight = this.creatingSessions.get(sessionKey);
    if (inFlight) {
      return inFlight;
    }

    const creating = this.createSession(providerId, conversationId, sessionKey).finally(() => {
      this.creatingSessions.delete(sessionKey);
    });
    this.creatingSessions.set(sessionKey, creating);

    const entry = await creating;
    this.evictSessions(providerId, sessionKey);
    return entry;
  }

  private isSessionReusable(entry: SessionEntry): boolean {
    const provider = getProvider(entry.providerId);
    let currentUrl: string;

    try {
      currentUrl = entry.page.url();
    } catch {
      return false;
    }

    if (!currentUrl || currentUrl === 'about:blank') {
      return true;
    }

    if (!isSameProviderHost(currentUrl, provider.url)) {
      return false;
    }

    // 同域名还不够：用户可能在这个标签页里手动点进了另一个对话。
    // 会话 id 对不上就判定为脏 session，否则会静默把消息写进错误的对话，
    // 而 bridge 自己的 transcript 仍以为一切正常。
    if (entry.detectedConversationId) {
      const currentConversationId = extractConversationId(
        currentUrl,
        provider.conversationUrlPattern,
      );
      if (currentConversationId !== entry.detectedConversationId) {
        return false;
      }
    }

    return true;
  }

  private async createSession(
    providerId: ProviderId,
    conversationId: string | undefined,
    sessionKey: string,
  ): Promise<SessionEntry> {
    const provider = getProvider(providerId);
    const page = await this.createBackgroundPage().catch(() => this.context!.newPage());
    this.ensureStreamListener(page, providerId);

    // 导航目标分三种，优先级从高到低：
    // 1. 调用方带了 conversationId，且我们记得它对应的会话页 → 直接去那条对话
    // 2. provider 配了 newChatUrl → 去"新建对话"页
    // 3. 都没有 → 去入口 url
    //
    // 第 2/3 条是关键：入口页常常会自动恢复上一次的对话，于是"第一条新消息"
    // 会被追加进一个无关的旧对话，而且毫无提示。
    const rememberedUrl = conversationId
      ? this.knownConversationUrls.get(this.getSessionKey(providerId, conversationId))
      : undefined;
    const targetUrl = rememberedUrl ?? provider.newChatUrl ?? provider.url;

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      // 记住的会话页可能已被删除（返回 404 / 登录过期）。退回新对话页重来，
      // 而不是让整个请求失败。
      const fallbackUrl = provider.newChatUrl ?? provider.url;
      if (fallbackUrl !== targetUrl) {
        await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      }
    }

    const entry: SessionEntry = {
      page,
      queue: Promise.resolve(),
      key: sessionKey,
      providerId,
      conversationId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      syncedMessages: [],
    };
    this.sessions.set(sessionKey, entry);
    return entry;
  }

  /**
   * 回收长期不用的标签页。createdAt / lastUsedAt 以前只是记下来给 /sessions 看，
   * 从不参与决策，于是标签页会无限累积。
   */
  private evictSessions(providerId: ProviderId, keepKey: string): void {
    const evictableKeys = selectSessionsToEvict(
      [...this.sessions.values()]
        .filter((entry) => entry.providerId === providerId)
        .map((entry) => ({
          key: entry.key,
          providerId: entry.providerId,
          lastUsedAt: entry.lastUsedAt,
          pageClosed: entry.page.isClosed(),
        })),
      {
        now: Date.now(),
        idleMs: SESSION_IDLE_EVICT_MS,
        maxPerProvider: MAX_SESSIONS_PER_PROVIDER,
        keepKey,
      },
    );

    for (const key of evictableKeys) {
      const entry = this.sessions.get(key);
      if (!entry) {
        continue;
      }
      this.sessions.delete(key);
      entry.page.close().catch(() => undefined);
    }
  }

  /**
   * 开始监听某个标签页的流式响应。只对配了 streamCapture 的 provider 有意义。
   *
   * 监听器是**常驻**的而不是每次发送时临时挂的：response 事件必须在请求进行中
   * 就会被接住，事后补挂会错过。所以这里做幂等挂载，捕获到的内容按时间排序，
   * 由 `takeCapturedStream` 按"发送前的时间点"来切分。
   */
  private ensureStreamListener(page: Page, providerId: ProviderId): void {
    const provider = getProvider(providerId);
    if (!provider.streamCapture) {
      return;
    }
    if (this.streamListening.has(page)) {
      return;
    }
    this.streamListening.add(page);

    const pattern = new RegExp(provider.streamCapture.endpointPattern);

    if (provider.streamCapture.transport === 'websocket') {
      const frames = this.capturedFrames.get(page) ?? [];
      this.capturedFrames.set(page, frames);

      page.on('websocket', (socket) => {
        const url = socket.url();
        if (!pattern.test(url)) {
          return;
        }
        socket.on('framereceived', ({ payload }) => {
          frames.push({
            url,
            text: typeof payload === 'string' ? payload : payload.toString('utf8'),
            capturedAt: Date.now(),
          });
        });
      });
      return;
    }

    const recorded = this.capturedStreams.get(page) ?? [];
    this.capturedStreams.set(page, recorded);

    if (provider.streamCapture.endpointGlob) {
      void this.attachIncrementalStreamCapture(
        page,
        provider.streamCapture.endpointGlob,
        pattern,
        recorded,
      );
    }

    page.on('response', (response) => {
      if (!pattern.test(response.url())) {
        return;
      }
      // 时间基准必须是**响应开始**的时刻，不是响应结束的时刻。
      //
      // 记 finished() 之后的时刻会串轮：ChatGPT 的 SSE 实测要 11 秒才 resolve，
      // 于是一条「20 秒前发出、10 秒前就结束」的旧流会在新一轮请求发出之后才被记下来，
      // 它的 capturedAt 仍然 ≥ since，于是被当成本轮的答案——实际抓到的是上一轮的
      // 内容（ChatGPT 上体现为把上一轮的推荐追问「还可以这样形容雪」当成正文）。
      const startedAt = Date.now();
      void (async () => {
        try {
          await response.finished();
          const text = (await response.body()).toString('utf8');
          recorded.push({ url: response.url(), text, capturedAt: startedAt });
        } catch {
          // 流式响应取不到 body 是正常的（可能已断开或被浏览器回收）；忽略即可，
          // 上层会退回 DOM 轮询路径。
        }
      })();
    });
  }

  /**
   * 增量捕获：不等响应结束，边下边把正文取回来。
   *
   * 为什么需要这条：站点把 SSE 一直挂着不关闭时，`response.finished()` 永远不
   * resolve，`response.body()` 会直接抛 `Network.getResponseBody: No data found`。
   * ChatGPT 2026-10 就是这样——答案 15 秒就出来了，连接还挂着，真流整条丢失。
   * 走 CDP `Fetch` 域可以逐块读，不用等它收尾。
   *
   * 两个必须记住的坑：
   *   1. **先** `takeResponseBodyAsStream` **再** `continueResponse`。反过来
   *      拦截号立刻失效（`Invalid InterceptionId`）。
   *   2. 任何分支都必须把请求放行，否则页面会卡在那个响应上不动。
   */
  private async attachIncrementalStreamCapture(
    page: Page,
    endpointGlob: string,
    pattern: RegExp,
    recorded: CapturedStream[],
  ): Promise<void> {
    let cdp: CDPSession;
    try {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: endpointGlob, requestStage: 'Response' }],
      });
    } catch {
      // 这条路走不通不影响功能：上层照旧退回 response + DOM。
      return;
    }

    cdp.on('Fetch.requestPaused', (event) => {
      void (async () => {
        if (!pattern.test(event.request.url)) {
          await cdp
            .send('Fetch.continueResponse', { requestId: event.requestId })
            .catch(() => undefined);
          return;
        }

        // 时间基准同样是**响应开始**的时刻，理由见上面 page.on('response') 那段注释。
        const startedAt = Date.now();
        try {
          const { stream } = await cdp.send('Fetch.takeResponseBodyAsStream', {
            requestId: event.requestId,
          });
          // 放行与读流并行：页面要拿到数据，我们也要拿到正文。
          void cdp
            .send('Fetch.continueResponse', { requestId: event.requestId })
            .catch(() => undefined);

          // 先占位、边读边往里写，而不是读完再 push：上层只等一个窗口，
          // 等读完再登记的话，这一轮可能已经超时退回 DOM 了。同一对象原地更新，
          // 所以数组里不会堆积半成品条目。
          const entry: CapturedStream = { url: event.request.url, text: '', capturedAt: startedAt };
          recorded.push(entry);

          for (let read = 0; read < INCREMENTAL_STREAM_MAX_READS; read += 1) {
            const chunk = await cdp.send('IO.read', { handle: stream, size: 64 * 1024 });
            if (chunk.data) {
              entry.text += chunk.base64Encoded
                ? Buffer.from(chunk.data, 'base64').toString('utf8')
                : chunk.data;
            }
            if (chunk.eof) {
              break;
            }
          }
          await cdp.send('IO.close', { handle: stream }).catch(() => undefined);
        } catch {
          // 取流失败也要放行，否则页面永远等不到这个响应。
          await cdp
            .send('Fetch.continueResponse', { requestId: event.requestId })
            .catch(() => undefined);
        }
      })();
    });
  }

  /**
   * 取出发送之后捕获到的那一份流，归约成结果。
   *
   * `since` 是发送开始的时间戳：只认这之后捕获的响应，避免把上一轮的流算进来。
   */
  takeCapturedStream(page: Page, providerId: ProviderId, since: number): ReducedStream | undefined {
    const provider = getProvider(providerId);
    if (!provider.streamCapture) {
      return undefined;
    }

    const recorded = this.capturedStreams.get(page) ?? [];
    const matched = recorded
      .filter((item) => item.capturedAt >= since)
      .sort((left, right) => left.capturedAt - right.capturedAt);

    const reducer = provider.streamCapture.reducer;

    if (provider.streamCapture.transport === 'websocket') {
      // WebSocket 帧不是 SSE，没有 data: 前缀，每一帧本身就是一份负载。
      const frames = (this.capturedFrames.get(page) ?? [])
        .filter((item) => item.capturedAt >= since)
        .sort((left, right) => left.capturedAt - right.capturedAt)
        .map((item) => item.text);
      if (frames.length === 0) {
        return undefined;
      }
      const reduced = reduceGrokStream(frames);
      return reduced && (reduced.content || reduced.reasoningContent) ? reduced : undefined;
    }

    if (reducer === 'claude') {
      // Claude 走会话快照 JSON 而不是 SSE：它的 SSE 里中文是坏的
      // （UTF-8 被按 CP1252 逐字节误解码），而 JSON 端点的文字正确。
      // 从后往前找——快照是累积的，最后一份必然包含完整的这一轮。
      for (const item of [...matched].reverse()) {
        const reduced = reduceClaudeConversation(item.text);
        if (reduced && (reduced.content || reduced.reasoningContent)) {
          return reduced;
        }
      }
      return undefined;
    }

    if (reducer === 'gemini') {
      // 回包不是 SSE：)]}' 前缀 + 方括号配平的 JSON 数组，且每帧都是累积快照。
      // 从后往前找——最后一帧就是完整答案。
      for (const item of [...matched].reverse()) {
        const reduced = reduceGeminiStream(item.text);
        if (reduced?.content) {
          return reduced;
        }
      }
      return undefined;
    }

    if (reducer === 'chatgpt') {
      // ChatGPT 的正文帧带 `event: delta` 头，按块首过滤 data: 会把正文整个丢掉，
      // 所以必须用 event/data 成对切分的那一套。
      //
      // 优先返回"站点已标记结束"的那份：同一轮可能有多条 SSE（重试、续传），
      // 先拿到的那份 body 可能只有半句。
      let partial: ReducedStream | undefined;
      for (const item of matched) {
        const reduced = reduceChatgptStream(parseSseEvents(item.text).map((e) => e.data));
        if (!reduced || !(reduced.content || reduced.reasoningContent)) {
          continue;
        }
        if (reduced.finished) {
          return reduced;
        }
        partial ??= reduced;
      }
      return partial;
    }

    const reducers: Record<'qwen' | 'deepseek', typeof reduceQwenStream> = {
      qwen: reduceQwenStream,
      deepseek: reduceDeepseekStream,
    };
    const reduce = reducers[reducer as 'qwen' | 'deepseek'];

    for (const item of matched) {
      const reduced = reduce(parseSseFrames(item.text));
      if (reduced && (reduced.content || reduced.reasoningContent)) {
        return reduced;
      }
    }

    return undefined;
  }

  /**
   * 返回发送之后陆续到达的 WebSocket 帧，供"真流式"消费。
   *
   * 与 takeCapturedStream 的区别：这个方法是**边到边给**的，调用方可以在帧到达
   * 的同时就转成 SSE delta 推给客户端，从而拿到首字延迟。目前调用方仍是一次性
   * 取完整结果，所以 TTFT 尚未启用——但数据和时间戳已经在手上了。
   */
  async *streamFrames(
    page: Page,
    providerId: ProviderId,
    since: number,
  ): AsyncGenerator<string, void, void> {
    const provider = getProvider(providerId);
    if (provider.streamCapture?.transport !== 'websocket') {
      return;
    }
    const frames = this.capturedFrames.get(page) ?? [];
    let cursor = since;
    for (;;) {
      const fresh = frames.filter((item) => item.capturedAt >= cursor);
      if (fresh.length > 0) {
        cursor = (fresh[fresh.length - 1]?.capturedAt ?? cursor) + 1;
        for (const item of fresh) {
          yield item.text;
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** 发送成功后记录从页面 URL 抽到的真实会话 id，供响应回传给调用方。 */
  recordDetectedConversationId(
    providerId: ProviderId,
    conversationId?: string,
  ): string | undefined {
    const entry = this.sessions.get(this.getSessionKey(providerId, conversationId));
    if (!entry || entry.page.isClosed()) {
      return undefined;
    }

    const provider = getProvider(providerId);
    const detected = extractConversationId(entry.page.url(), provider.conversationUrlPattern);
    if (detected) {
      entry.detectedConversationId = detected;
      // 记下 id -> URL，之后调用方带这个 id 回来时能直接导航到这条对话。
      // 落盘是因为这个映射必须跨重启存活：重启后标签页和内存 Map 全没了，
      // 若不落盘，调用方带上旧 id 回来就只能退回入口页，于是又被丢进别的对话。
      this.knownConversationUrls.set(
        this.getSessionKey(providerId, entry.conversationId ?? detected),
        entry.page.url(),
      );
      this.persistConversationUrls();
    }
    return detected ?? entry.detectedConversationId;
  }

  private async loadConversationUrls(): Promise<void> {
    try {
      const raw = await readFile(appConfig.conversationUrlStorePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      for (const [key, url] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof url === 'string' && url) {
          this.knownConversationUrls.set(key, url);
        }
      }
    } catch {
      // 文件不存在或损坏都属正常，直接当作没有历史映射。
    }
  }

  private persistConversationUrls(): void {
    const snapshot = Object.fromEntries(this.knownConversationUrls);
    this.conversationUrlsFlush = this.conversationUrlsFlush
      .then(async () => {
        await mkdir(path.dirname(appConfig.conversationUrlStorePath), { recursive: true });
        await writeFile(
          appConfig.conversationUrlStorePath,
          `${JSON.stringify(snapshot, null, 2)}\n`,
          'utf8',
        );
      })
      .catch(() => undefined);
  }

  async openSession(providerId: ProviderId, conversationId?: string): Promise<Page> {
    // 走 ensureSession 而不是自己建页：这样用户主动 open 的时候也能拿到
    // 并发保护，并且同样会校验页面还在该 provider 的站点上。
    const entry = await this.ensureSession(providerId, conversationId);
    // 这里是用户显式要求"打开这个 provider"，导航到首页而不是新对话页。
    await entry.page.goto(getProvider(providerId).url, { waitUntil: 'domcontentloaded' });
    await this.revealPage(entry.page);
    return entry.page;
  }

  hasSession(providerId: ProviderId, conversationId?: string): boolean {
    const session = this.sessions.get(this.getSessionKey(providerId, conversationId));
    return Boolean(session && !session.page.isClosed());
  }

  async createEphemeralPage(providerId: ProviderId): Promise<Page> {
    await this.init();
    const page = await this.createBackgroundPage().catch(() => this.context!.newPage());
    await page.goto(getProvider(providerId).url, { waitUntil: 'domcontentloaded' });
    return page;
  }

  async runExclusive<T>(
    providerId: ProviderId,
    conversationId: string | undefined,
    task: (page: Page) => Promise<T>,
  ): Promise<T> {
    const page = await this.getPage(providerId, conversationId);
    const entry = this.sessions.get(this.getSessionKey(providerId, conversationId))!;
    entry.lastUsedAt = Date.now();

    const run = async () => task(page);
    const pending = entry.queue.then(run, run);
    entry.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async runIsolated<T>(providerId: ProviderId, task: (page: Page) => Promise<T>): Promise<T> {
    return this.runExclusive(providerId, undefined, task);
  }

  async revealSession(providerId: ProviderId, conversationId?: string): Promise<Page | undefined> {
    const session = this.sessions.get(this.getSessionKey(providerId, conversationId));
    if (!session || session.page.isClosed()) {
      return undefined;
    }

    await this.revealPage(session.page);
    return session.page;
  }

  async shutdown(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.sessions.clear();
  }

  async listSessions(): Promise<
    Array<{
      key: string;
      providerId: ProviderId;
      conversationId?: string;
      url: string;
      title: string;
      createdAt: number;
      lastUsedAt: number;
      isClosed: boolean;
    }>
  > {
    return Promise.all(
      [...this.sessions.values()].map(async (entry) => ({
        key: entry.key,
        providerId: entry.providerId,
        conversationId: entry.conversationId,
        url: entry.page.url(),
        title: entry.page.isClosed() ? '' : await entry.page.title().catch(() => ''),
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
        isClosed: entry.page.isClosed(),
      })),
    );
  }

  async clearSession(providerId: ProviderId, conversationId?: string): Promise<boolean> {
    const key = this.getSessionKey(providerId, conversationId);
    const session = this.sessions.get(key);
    if (!session) {
      return false;
    }

    this.sessions.delete(key);
    if (!session.page.isClosed()) {
      await session.page.close();
    }
    return true;
  }

  getSyncedMessages(providerId: ProviderId, conversationId?: string): SyncedMessage[] {
    const session = this.sessions.get(this.getSessionKey(providerId, conversationId));
    return session ? [...session.syncedMessages] : [];
  }

  setSyncedMessages(
    providerId: ProviderId,
    conversationId: string | undefined,
    messages: SyncedMessage[],
  ): void {
    const session = this.sessions.get(this.getSessionKey(providerId, conversationId));
    if (session) {
      session.syncedMessages = [...messages];
    }
  }

  async inspectSession(
    providerId: ProviderId,
    conversationId?: string,
    options?: { hoverLatestResponse?: boolean },
  ): Promise<{
    url: string;
    title: string;
    frames: Array<{ url: string; name: string; title: string }>;
    bodyTextPreview: string;
    selectorDiagnostics: {
      input: Array<{ selector: string; count: number; visibleCount: number }>;
      send: Array<{ selector: string; count: number; visibleCount: number }>;
      response: Array<{ selector: string; count: number; visibleCount: number }>;
      busy: Array<{ selector: string; count: number; visibleCount: number }>;
      searchToggle: Array<{ selector: string; count: number; visibleCount: number }>;
      reasoningToggle: Array<{ selector: string; count: number; visibleCount: number }>;
    };
    selectorDiagnosticsNotes: string[];
    buttons: Array<{
      text: string;
      ariaLabel: string;
      role: string;
      ariaPressed: string;
      ariaChecked: string;
      dataState: string;
      className: string;
    }>;
    inputs: Array<{
      tag: string;
      placeholder: string;
      ariaLabel: string;
      role: string;
      contentEditable: string;
      className: string;
      disabled: boolean;
      readOnly: boolean;
      visible: boolean;
      valuePreview: string;
    }>;
    composerButtons: Array<{
      tag: string;
      text: string;
      ariaLabel: string;
      title: string;
      role: string;
      className: string;
      dataTestId: string;
      disabled: boolean;
      visible: boolean;
    }>;
    responseCandidates: Array<{
      tag: string;
      text: string;
      className: string;
      dataRole: string;
      ariaLabel: string;
    }>;
    latestResponseDebug?: {
      selector: string;
      matchedBy?: string;
      text: string;
      html: string;
      nearbyControls: Array<{
        tag: string;
        text: string;
        ariaLabel: string;
        title: string;
        dataTestId: string;
        className: string;
        dx: number;
        dy: number;
        width: number;
        height: number;
        outerHTML: string;
        opacity: string;
        pointerEvents: string;
        cursor: string;
      }>;
    };
    providerState: {
      qwenThinkingMode?: string;
    };
  }> {
    const page = await this.getPage(providerId, conversationId);
    const provider = getProvider(providerId);
    const bodyTextPreview = await page
      .locator('body')
      .evaluate((node) => ((node as HTMLElement).innerText || '').trim().slice(0, 1200))
      .catch(() => '');
    const buttons = await this.collectElementSummaries(
      page,
      'button, [role="button"]',
      160,
      (element) => ({
        text: (element.innerText || '').trim().slice(0, 120),
        ariaLabel: element.getAttribute('aria-label') || '',
        role: element.getAttribute('role') || '',
        ariaPressed: element.getAttribute('aria-pressed') || '',
        ariaChecked: element.getAttribute('aria-checked') || '',
        dataState: element.getAttribute('data-state') || '',
        className: typeof element.className === 'string' ? element.className.slice(0, 200) : '',
      }),
    );
    const inputs = await this.collectElementSummaries(
      page,
      'textarea, input, [contenteditable="true"], [role="textbox"]',
      80,
      (element) => ({
        tag: element.tagName.toLowerCase(),
        placeholder: element.getAttribute('placeholder') || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        role: element.getAttribute('role') || '',
        contentEditable: element.getAttribute('contenteditable') || '',
        className: typeof element.className === 'string' ? element.className.slice(0, 240) : '',
        disabled:
          'disabled' in element
            ? Boolean((element as HTMLInputElement | HTMLTextAreaElement).disabled)
            : false,
        readOnly:
          'readOnly' in element
            ? Boolean((element as HTMLInputElement | HTMLTextAreaElement).readOnly)
            : false,
        visible: element instanceof HTMLElement ? Boolean(element.offsetParent) : false,
        valuePreview: ('value' in element
          ? String((element as HTMLInputElement | HTMLTextAreaElement).value || '')
          : element.textContent || ''
        ).slice(0, 200),
      }),
    );
    const composerButtons = await this.collectElementSummaries(page, 'textarea', 1, (element) => {
      const textarea = element as HTMLTextAreaElement;
      const composer =
        textarea.closest(
          'form, [class*="input"], [class*="composer"], [class*="footer"], [class*="bottom"], [class*="chat"]',
        ) ?? textarea.parentElement;
      const buttons = composer
        ? Array.from(composer.querySelectorAll<HTMLElement>('button, [role="button"]')).slice(0, 24)
        : [];
      return buttons.map((button) => ({
        tag: button.tagName.toLowerCase(),
        text: (button.innerText || '').trim().slice(0, 120),
        ariaLabel: button.getAttribute('aria-label') || '',
        title: button.getAttribute('title') || '',
        role: button.getAttribute('role') || '',
        className: typeof button.className === 'string' ? button.className.slice(0, 240) : '',
        dataTestId: button.getAttribute('data-testid') || '',
        disabled: 'disabled' in button ? Boolean((button as HTMLButtonElement).disabled) : false,
        visible: Boolean(button.offsetParent),
      }));
    });
    const responseCandidates = await this.collectElementSummaries(
      page,
      '[class*="assistant"], [class*="markdown"], [data-message-author-role], article, .ds-markdown, .ds-think, .thinking, [class*="reason"]',
      40,
      (element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.innerText || '').trim().slice(0, 400),
        className: typeof element.className === 'string' ? element.className.slice(0, 240) : '',
        dataRole: element.getAttribute('data-message-author-role') || '',
        ariaLabel: element.getAttribute('aria-label') || '',
      }),
      true,
    );
    let latestResponseDebug:
      | {
          selector: string;
          matchedBy?: string;
          text: string;
          html: string;
          nearbyControls: Array<{
            tag: string;
            text: string;
            ariaLabel: string;
            title: string;
            dataTestId: string;
            className: string;
            dx: number;
            dy: number;
            width: number;
            height: number;
            outerHTML: string;
            opacity: string;
            pointerEvents: string;
            cursor: string;
          }>;
        }
      | undefined;
    const session = this.sessions.get(this.getSessionKey(providerId, conversationId));
    const latestAssistant = [...(session?.syncedMessages ?? [])]
      .reverse()
      .find((message) => message.role === 'assistant')?.content;

    for (const selector of provider.responseSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      if (count <= 0) {
        continue;
      }

      const latestLocator = locator.nth(count - 1);
      if (options?.hoverLatestResponse) {
        await this.hoverResponseForInspection(page, providerId, latestLocator).catch(
          () => undefined,
        );
      }

      latestResponseDebug = await latestLocator
        .evaluate((node, usedSelector) => {
          const element = node as HTMLElement;
          const rect = element.getBoundingClientRect();
          const controls = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button, [role="button"], [title], [aria-label], [data-testid], div, span',
            ),
          )
            .map((control) => {
              const controlRect = control.getBoundingClientRect();
              const style = window.getComputedStyle(control);
              return {
                tag: control.tagName.toLowerCase(),
                text: (control.innerText || '').trim().slice(0, 120),
                ariaLabel: control.getAttribute('aria-label') || '',
                title: control.getAttribute('title') || '',
                dataTestId: control.getAttribute('data-testid') || '',
                className:
                  typeof control.className === 'string' ? control.className.slice(0, 240) : '',
                dx: Math.round(controlRect.left - rect.left),
                dy: Math.round(controlRect.top - rect.bottom),
                width: Math.round(controlRect.width),
                height: Math.round(controlRect.height),
                outerHTML: (control.outerHTML || '').slice(0, 400),
                opacity: style.opacity,
                pointerEvents: style.pointerEvents,
                cursor: style.cursor,
              };
            })
            .filter((item) => Math.abs(item.dy) <= 320 && item.dx >= -200 && item.dx <= 960)
            .slice(0, 120);

          return {
            selector: usedSelector,
            matchedBy: 'provider-response-selector',
            text: (element.innerText || '').trim().slice(0, 1200),
            html: (element.innerHTML || '').slice(0, 4000),
            nearbyControls: controls,
          };
        }, selector)
        .catch(() => undefined);

      if (latestResponseDebug) {
        break;
      }
    }

    if (!latestResponseDebug && latestAssistant) {
      const normalizedAssistant = latestAssistant.replace(/\s+/g, ' ').trim();
      const assistantHints = normalizedAssistant
        .split(/\n+/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length >= 8)
        .sort((left, right) => right.length - left.length)
        .slice(0, 4);

      latestResponseDebug = await page
        .evaluate((hints) => {
          const allElements = Array.from(
            document.querySelectorAll<HTMLElement>(
              'main *, article *, section *, div, li, p, table, pre, code',
            ),
          );
          const candidates = allElements
            .map((element) => {
              const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
              if (!text || text.length < 20) {
                return undefined;
              }

              let score = 0;
              let matchedBy = '';
              for (const hint of hints) {
                if (hint && text.includes(hint)) {
                  score = hint.length;
                  matchedBy = hint;
                  break;
                }
              }

              if (score <= 0) {
                return undefined;
              }

              const rect = element.getBoundingClientRect();
              return {
                element,
                rect,
                score,
                matchedBy,
                text,
              };
            })
            .filter(
              (
                item,
              ): item is {
                element: HTMLElement;
                rect: DOMRect;
                score: number;
                matchedBy: string;
                text: string;
              } => Boolean(item),
            )
            .sort((left, right) => {
              if (right.score !== left.score) {
                return right.score - left.score;
              }
              return right.rect.bottom - left.rect.bottom;
            });

          const best = candidates[0];
          if (!best) {
            return undefined;
          }

          const controls = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button, [role="button"], [title], [aria-label], [data-testid], [class*="icon"], [class*="tool"]',
            ),
          )
            .map((control) => {
              const controlRect = control.getBoundingClientRect();
              const style = window.getComputedStyle(control);
              return {
                tag: control.tagName.toLowerCase(),
                text: (control.innerText || '').trim().slice(0, 120),
                ariaLabel: control.getAttribute('aria-label') || '',
                title: control.getAttribute('title') || '',
                dataTestId: control.getAttribute('data-testid') || '',
                className:
                  typeof control.className === 'string' ? control.className.slice(0, 240) : '',
                dx: Math.round(controlRect.left - best.rect.left),
                dy: Math.round(controlRect.top - best.rect.bottom),
                width: Math.round(controlRect.width),
                height: Math.round(controlRect.height),
                outerHTML: (control.outerHTML || '').slice(0, 400),
                opacity: style.opacity,
                pointerEvents: style.pointerEvents,
                cursor: style.cursor,
              };
            })
            .filter((item) => Math.abs(item.dy) <= 280 && item.dx >= -160 && item.dx <= 900)
            .slice(0, 120);

          return {
            selector: '<matched-by-session-assistant>',
            matchedBy: best.matchedBy,
            text: best.text.slice(0, 1200),
            html: (best.element.innerHTML || '').slice(0, 4000),
            nearbyControls: controls,
          };
        }, assistantHints)
        .catch(() => undefined);
    }
    const qwenThinkingMode = await page
      .locator('.qwen-select-thinking .ant-select-selection-item, .qwen-select-thinking-label-text')
      .first()
      .evaluate((node) => ((node as HTMLElement).innerText || '').trim() || undefined)
      .catch(() => undefined);

    const frames = await Promise.all(
      page.frames().map(async (frame) => ({
        url: frame.url(),
        name: frame.name(),
        title: await frame.title().catch(() => ''),
      })),
    );

    const describeSelectors = async (selectors: string[]) =>
      Promise.all(
        selectors.map(async (selector) => {
          const locator = page.locator(selector);
          const count = await locator.count();
          let visibleCount = 0;

          for (let index = 0; index < count; index += 1) {
            try {
              if (await locator.nth(index).isVisible()) {
                visibleCount += 1;
              }
            } catch {
              // Ignore transient DOM detach.
            }
          }

          return { selector, count, visibleCount };
        }),
      );

    const selectorDiagnostics = {
      input: await describeSelectors(provider.inputSelectors),
      send: await describeSelectors(provider.sendButtonSelectors),
      response: await describeSelectors(provider.responseSelectors),
      busy: await describeSelectors(provider.busySelectors ?? []),
      searchToggle: await describeSelectors(provider.toggles?.search?.buttonSelectors ?? []),
      reasoningToggle: await describeSelectors(provider.toggles?.reasoning?.buttonSelectors ?? []),
    };

    // 发送按钮通常在 composer 为空时不渲染（或 disabled），因此那时的 0 命中
    // 不代表选择器失效。实测 grok 的 button[type="submit"] 在有文本时是 1/1，
    // 空 composer 下却是 0/0。不标出来的话，这个面板会主动误导人——
    // 2026-10 就因为它被误判成"grok 发送层已死、只靠键盘兜底"。
    const composerHasText = inputs.some(
      (item) => item.visible && typeof item.valuePreview === 'string' && item.valuePreview.trim(),
    );
    const selectorDiagnosticsNotes: string[] = [];
    if (!composerHasText) {
      selectorDiagnosticsNotes.push(
        'composer 为空：发送按钮通常此时不渲染，send 一组的 0 命中不代表选择器失效。' +
          '如需验证发送选择器，请先用 probe-input 往输入框写入文本后再看。',
      );
    }

    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      frames,
      bodyTextPreview,
      selectorDiagnostics,
      selectorDiagnosticsNotes,
      buttons: buttons.filter((item) => item.text || item.ariaLabel),
      inputs,
      composerButtons: composerButtons.flat(),
      responseCandidates: responseCandidates.filter((item) => item.text),
      latestResponseDebug,
      providerState: {
        qwenThinkingMode,
      },
    };
  }

  private async hoverResponseForInspection(
    page: Page,
    providerId: ProviderId,
    locator: Locator,
  ): Promise<void> {
    if (providerId === 'qwen') {
      const qwenContainers = [
        locator
          .locator('xpath=ancestor-or-self::*[contains(@class,"chat-response-message")][1]')
          .first(),
        locator
          .locator('xpath=ancestor-or-self::*[contains(@class,"chat-response-message-right")][1]')
          .first(),
        locator
          .locator('xpath=ancestor-or-self::*[contains(@class,"response-message-content")][1]')
          .first(),
      ];
      for (const qwenContainer of qwenContainers) {
        if ((await qwenContainer.count().catch(() => 0)) === 0) {
          continue;
        }

        await qwenContainer.scrollIntoViewIfNeeded().catch(() => undefined);
        await qwenContainer.hover({ timeout: 1500 }).catch(() => undefined);
        await page.waitForTimeout(180);
      }
    }

    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.hover({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(180);
  }

  async probeInputStrategies(
    providerId: ProviderId,
    conversationId?: string,
    customProbeText?: string,
  ): Promise<{
    url: string;
    title: string;
    probeText: string;
    initialValue: string;
    results: Array<{
      strategy: 'fill' | 'keyboard-insert-text' | 'type' | 'native-setter';
      ok: boolean;
      valueAfter: string;
      error?: string;
    }>;
  }> {
    const page = await this.getPage(providerId, conversationId);
    const input = page
      .locator('textarea, input, [contenteditable="true"], [role="textbox"]')
      .first();
    // 探针文本刻意保持单行：这个接口只用来验证"文本能不能进输入框"，
    // 多行对它没有额外价值，却会让 type() 策略把 '\n' 变成一次 Enter，
    // 而多数 composer 收到 Enter 就直接提交——等于调试接口替你发了条消息。
    // （2026-10 实测：这样给 grok 误发过一条 "probe-line-1"。）
    const probeText = customProbeText && customProbeText.trim() ? customProbeText : 'probe-line-1';

    const readValue = async () =>
      input.evaluate((node) => {
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          return node.value || '';
        }

        const element = node as HTMLElement;
        return element.innerText || element.textContent || '';
      });

    const clearValue = async () => {
      await input.evaluate((node) => {
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          const previousValue = node.value;
          const prototype =
            node instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) {
            setter.call(node, '');
          } else {
            node.value = '';
          }
          const tracker = (
            node as HTMLInputElement & { _valueTracker?: { setValue(nextValue: string): void } }
          )._valueTracker;
          tracker?.setValue(previousValue);
          node.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              inputType: 'deleteContentBackward',
              data: '',
            }),
          );
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }

        const element = node as HTMLElement;
        element.textContent = '';
        element.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: '' }),
        );
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(120);
    };

    await input.click({ timeout: 2000 }).catch(() => undefined);
    const initialValue = await readValue().catch(() => '');
    const results: Array<{
      strategy: 'fill' | 'keyboard-insert-text' | 'type' | 'native-setter';
      ok: boolean;
      valueAfter: string;
      error?: string;
    }> = [];

    const runStrategy = async (
      strategy: 'fill' | 'keyboard-insert-text' | 'type' | 'native-setter',
      action: () => Promise<void>,
    ) => {
      await clearValue().catch(() => undefined);

      try {
        await input.click({ timeout: 2000 }).catch(() => undefined);
        await action();
        await page.waitForTimeout(160);
        const valueAfter = await readValue().catch(() => '');
        results.push({ strategy, ok: valueAfter.includes('probe-line-1'), valueAfter });
      } catch (error) {
        const valueAfter = await readValue().catch(() => '');
        results.push({
          strategy,
          ok: false,
          valueAfter,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    await runStrategy('fill', async () => {
      await input.fill(probeText);
    });

    await runStrategy('keyboard-insert-text', async () => {
      await input.focus();
      await input.press('ControlOrMeta+A').catch(() => undefined);
      await input.press('Backspace').catch(() => undefined);
      await page.keyboard.insertText(probeText);
    });

    // type() 逐字符发按键，'\n' 会被敲成 Enter 并触发提交。因此探针文本含换行时
    // 直接跳过这个策略，而不是赌目标站点的 Enter 行为。
    if (!probeText.includes('\n')) {
      await runStrategy('type', async () => {
        await input.focus();
        await input.press('ControlOrMeta+A').catch(() => undefined);
        await input.press('Backspace').catch(() => undefined);
        await input.type(probeText, { delay: 12 });
      });
    }

    await runStrategy('native-setter', async () => {
      await input.evaluate((node, value) => {
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          const previousValue = node.value;
          const prototype =
            node instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) {
            setter.call(node, value);
          } else {
            node.value = value;
          }
          const tracker = (
            node as HTMLInputElement & { _valueTracker?: { setValue(nextValue: string): void } }
          )._valueTracker;
          tracker?.setValue(previousValue);
          node.dispatchEvent(
            new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: value,
            }),
          );
          node.dispatchEvent(
            new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
          );
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }

        const element = node as HTMLElement;
        element.textContent = value;
        element.dispatchEvent(
          new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: value,
          }),
        );
        element.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }),
        );
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, probeText);
    });

    await clearValue().catch(() => undefined);

    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      probeText,
      initialValue,
      results,
    };
  }

  private async collectElementSummaries<T>(
    page: Page,
    selector: string,
    limit: number,
    mapElement: (element: HTMLElement) => T,
    takeLast = false,
  ): Promise<T[]> {
    const locator = page.locator(selector);
    const count = await locator.count();
    const startIndex = takeLast ? Math.max(0, count - limit) : 0;
    const endIndex = takeLast ? count : Math.min(count, limit);
    const items: T[] = [];

    for (let index = startIndex; index < endIndex; index += 1) {
      try {
        items.push(
          await locator.nth(index).evaluate((node, mapperSource) => {
            const mapper = new Function('element', `return (${mapperSource})(element);`) as (
              element: HTMLElement,
            ) => T;
            return mapper(node as HTMLElement);
          }, mapElement.toString()),
        );
      } catch {
        // Ignore transient DOM detach and non-HTMLElement nodes.
      }
    }

    return items;
  }

  /**
   * 把页签切到前台。
   *
   * 公开出来只为一处使用：**人机验证**。那种情况只能由人点，不弹出来用户就
   * 不知道有事要做；而普通错误不该打扰（同 REVEAL_ON_ERROR，默认关闭），
   * 因为那会频繁把窗口拽到前台，打断同一台机器上的其他工作。
   */
  async bringPageToFront(page: Page): Promise<void> {
    await this.revealPage(page);
  }

  private async revealPage(page: Page): Promise<void> {
    try {
      // 只用 bringToFront。原来还额外调了一次 window.focus()，那是多余的——
      // bringToFront 已经激活了标签页，多这一次调用只会在不合时宜的时候
      // 再次激活窗口（比如后台页面恰好在处理别的事时）。
      await page.bringToFront();
    } catch {
      // Ignore focus failures. The page may still be available in the browser window.
    }
  }

  private async createBackgroundPage(): Promise<Page> {
    const browser = this.context?.browser();
    if (!this.context || !browser) {
      return this.context!.newPage();
    }

    const pagePromise = this.context.waitForEvent('page', { timeout: 4000 });
    try {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
      return await pagePromise;
    } catch {
      return this.context.newPage();
    }
  }

  private getSessionKey(providerId: ProviderId, conversationId?: string): string {
    return conversationId ? `${providerId}:${conversationId}` : `${providerId}:__default__`;
  }

  private isProcessSingletonError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('ProcessSingleton') || message.includes('SingletonLock');
  }

  private async clearSingletonArtifacts(): Promise<void> {
    const artifactNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    await Promise.all(
      artifactNames.map((name) =>
        rm(path.join(appConfig.userDataDir, name), { force: true }).catch(() => undefined),
      ),
    );
  }
}
