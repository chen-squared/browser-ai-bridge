import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { appConfig } from '../config.js';
import { getProvider } from '../providers/registry.js';
import type { ProviderId } from '../types.js';

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
  createdAt: number;
  lastUsedAt: number;
  syncedMessages: SyncedMessage[];
};

type PersistentContextOptions = Parameters<typeof chromium.launchPersistentContext>[1];

export class BrowserManager {
  private context?: BrowserContext;
  private sessions = new Map<string, SessionEntry>();

  async init(): Promise<void> {
    if (this.context) {
      return;
    }

    await mkdir(appConfig.userDataDir, { recursive: true });

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

  async getPage(providerId: ProviderId, conversationId?: string): Promise<Page> {
    await this.init();

    const sessionKey = this.getSessionKey(providerId, conversationId);

    const current = this.sessions.get(sessionKey);
    if (current && !current.page.isClosed()) {
      return current.page;
    }

    const provider = getProvider(providerId);
    const page = await this.createBackgroundPage().catch(() => this.context!.newPage());
    await page.goto(provider.url, { waitUntil: 'domcontentloaded' });

    this.sessions.set(sessionKey, {
      page,
      queue: Promise.resolve(),
      key: sessionKey,
      providerId,
      conversationId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      syncedMessages: [],
    });

    return page;
  }

  async openSession(providerId: ProviderId, conversationId?: string): Promise<Page> {
    await this.init();
    const key = this.getSessionKey(providerId, conversationId);
    const current = this.sessions.get(key);
    const page =
      current && !current.page.isClosed()
        ? current.page
        : await this.createForegroundPage(providerId, conversationId);
    await page.goto(getProvider(providerId).url, { waitUntil: 'domcontentloaded' });
    await this.revealPage(page);
    return page;
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

  private async createForegroundPage(
    providerId: ProviderId,
    conversationId?: string,
  ): Promise<Page> {
    const page = await this.context!.newPage();
    const sessionKey = this.getSessionKey(providerId, conversationId);

    this.sessions.set(sessionKey, {
      page,
      queue: Promise.resolve(),
      key: sessionKey,
      providerId,
      conversationId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      syncedMessages: [],
    });

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

    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      frames,
      bodyTextPreview,
      selectorDiagnostics,
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
    const probeText =
      customProbeText && customProbeText.trim() ? customProbeText : 'probe-line-1\nprobe-line-2';

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

    await runStrategy('type', async () => {
      await input.focus();
      await input.press('ControlOrMeta+A').catch(() => undefined);
      await input.press('Backspace').catch(() => undefined);
      await input.type(probeText, { delay: 12 });
    });

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

  private async revealPage(page: Page): Promise<void> {
    try {
      await page.bringToFront();
      await page.evaluate(() => {
        window.focus();
      });
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
