import type { Locator, Page } from 'playwright';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { appConfig } from '../config.js';
import { getProvider } from '../providers/registry.js';
import type {
  ChatResult,
  NormalizedPrompt,
  ProviderConfig,
  ProviderId,
  ToggleConfig,
} from '../types.js';
import {
  restoreMarkdownTokenPayloads,
  type ExtractedMarkdownTokenPayload,
} from './markdown-restoration.js';

const STABLE_POLLS_REQUIRED = 3;
const POLL_INTERVAL_MS = 1200;
const DEFAULT_TIMEOUT_MS = 90000;

const turndownService = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  strongDelimiter: '**',
});

turndownService.use(gfm);

turndownService.remove(['button', 'script', 'style', 'noscript', 'form', 'input', 'textarea']);

turndownService.addRule('ignoreAriaHidden', {
  filter: (node: unknown) => {
    if (!node || typeof node !== 'object' || !('getAttribute' in node)) {
      return false;
    }

    const element = node as { getAttribute(name: string): string | null };
    return element.getAttribute('aria-hidden') === 'true';
  },
  replacement: () => '',
});

type ExtractedRenderedMarkdownPayload = {
  html: string;
  text: string;
  qwenTablePayloads: ExtractedMarkdownTokenPayload[];
  codeBlockPayloads: ExtractedMarkdownTokenPayload[];
  mathPayloads: ExtractedMarkdownTokenPayload[];
};

function extractRenderedMarkdownPayload(
  node: HTMLElement,
  providerId: string,
): ExtractedRenderedMarkdownPayload {
  const originalRoot = node;
  let contentSource = originalRoot;
  if (providerId === 'gemini' && !originalRoot.matches('[id^="model-response-message-content"]')) {
    const matched = originalRoot.querySelector('[id^="model-response-message-content"]');
    if (matched instanceof HTMLElement) {
      contentSource = matched;
    }
  } else if (
    providerId === 'qwen' &&
    !originalRoot.matches(
      '.custom-qwen-markdown, .qwen-markdown, .response-message-content.phase-answer',
    )
  ) {
    const matched = originalRoot.querySelector(
      '.custom-qwen-markdown, .qwen-markdown, .response-message-content.phase-answer',
    );
    if (matched instanceof HTMLElement) {
      contentSource = matched;
    }
  }

  const root = contentSource.cloneNode(true) as HTMLElement;
  const genericHints = [
    'copy',
    '复制',
    'share',
    '分享',
    'export',
    '导出',
    'regenerate',
    '重做',
    'more',
    '更多',
    'tts',
    '朗读',
    'listen',
    'thumb',
    'action',
    'footer',
    'tooltip',
    'source',
    'sources',
  ];

  let providerHints: string[] = [];
  if (providerId === 'claude') {
    providerHints = ['visualize', 'show_widget', 'show widget', 'artifact', 'widget'];
  } else if (providerId === 'gemini') {
    providerHints = [
      'export-sheets',
      'response-footer',
      'message-actions',
      'buttons-container-v2',
      'actions-container-v2',
      'rich-textarea',
      'ql-editor',
      'chat-history',
      'history-list',
      'input-area',
      'composer',
    ];
  } else if (providerId === 'grok') {
    providerHints = ['action-buttons', 'last-response print:hidden'];
  } else if (providerId === 'qwen') {
    providerHints = [
      'thinking-tool-status',
      'thinking-status-card',
      'tool-status-card',
      'response-message-footer',
      'qwen-chat-package-comp-new-action-control',
      'qwen-markdown-table-header',
      'qwen-markdown-table-header-action-item',
    ];
  }

  const qwenTablePayloads =
    providerId === 'qwen'
      ? (() => {
          const payloads: Array<{ token: string; markdown: string }> = [];
          const wrappers = Array.from(root.querySelectorAll('.qwen-markdown-table-wrapper'));
          const targets =
            wrappers.length > 0
              ? wrappers
              : Array.from(root.querySelectorAll('table.qwen-markdown-table'));

          targets.forEach((target, index) => {
            const table =
              target instanceof HTMLTableElement
                ? target
                : target.querySelector('table.qwen-markdown-table');
            if (!(table instanceof HTMLTableElement)) {
              return;
            }

            const headerCells = Array.from(table.querySelectorAll('thead th')).map((cell) =>
              ((cell as HTMLElement).innerText || cell.textContent || '')
                .replace(/\r\n/g, '\n')
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/\|/g, '\\|'),
            );
            const bodyRows = Array.from(table.querySelectorAll('tbody tr'))
              .map((row) =>
                Array.from(row.querySelectorAll('td')).map((cell) =>
                  ((cell as HTMLElement).innerText || cell.textContent || '')
                    .replace(/\r\n/g, '\n')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .replace(/\|/g, '\\|'),
                ),
              )
              .filter((row) => row.length > 0);

            if (headerCells.length === 0) {
              const firstRow = table.querySelector('tr');
              if (!firstRow) {
                return;
              }
              const firstRowCells = Array.from(firstRow.querySelectorAll('th, td')).map((cell) =>
                ((cell as HTMLElement).innerText || cell.textContent || '')
                  .replace(/\r\n/g, '\n')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .replace(/\|/g, '\\|'),
              );
              if (firstRowCells.length === 0) {
                return;
              }
              headerCells.push(...firstRowCells);
            }

            const divider = `| ${headerCells.map(() => '---').join(' | ')} |`;
            const rows = bodyRows.map((row) => `| ${row.join(' | ')} |`);
            const markdown = [`| ${headerCells.join(' | ')} |`, divider, ...rows].join('\n').trim();
            if (!markdown) {
              return;
            }

            const token = `BRIDGEQWENTABLETOKEN${index}END`;
            payloads.push({ token, markdown });

            const replacement = document.createElement('div');
            replacement.setAttribute('data-bridge-qwen-table-token', token);
            replacement.textContent = token;
            target.replaceWith(replacement);
          });

          return payloads;
        })()
      : [];

  const codeBlockPayloads = ['chatgpt', 'claude', 'deepseek', 'qwen'].includes(providerId)
    ? (() => {
        const payloads: Array<{ token: string; markdown: string }> = [];
        const rawBlocks =
          providerId === 'chatgpt'
            ? Array.from(root.querySelectorAll('pre'))
            : providerId === 'claude'
              ? Array.from(root.querySelectorAll('div[role="group"][aria-label$=" code"]'))
              : providerId === 'deepseek'
                ? Array.from(root.querySelectorAll('.md-code-block'))
                : Array.from(root.querySelectorAll('.qwen-markdown-code'));

        const codeBlocks = rawBlocks.filter(
          (block, index) =>
            !rawBlocks.some((other, otherIndex) => otherIndex !== index && other.contains(block)),
        );

        codeBlocks.forEach((block, index) => {
          if (!(block instanceof HTMLElement)) {
            return;
          }

          let language = '';
          const languageFromClass = block.querySelector('code[class*="language-"]');
          if (languageFromClass instanceof HTMLElement) {
            const matched = Array.from(languageFromClass.classList).find((item) =>
              item.startsWith('language-'),
            );
            if (matched) {
              const normalizedLanguage = matched
                .slice('language-'.length)
                .replace(/\s+/g, ' ')
                .trim();
              if (/^[a-z0-9_+#.-]{1,24}$/iu.test(normalizedLanguage)) {
                language = normalizedLanguage;
              }
            }
          }

          if (!language) {
            const rawLanguageCandidates = [
              block.getAttribute('data-language') || '',
              block.getAttribute('aria-label') || '',
              (
                block.querySelector(
                  '.qwen-markdown-code-header > div:first-child',
                ) as HTMLElement | null
              )?.innerText || '',
              (block.querySelector('.md-code-block-banner .d813de27') as HTMLElement | null)
                ?.innerText || '',
              (block.querySelector('.text-text-500') as HTMLElement | null)?.innerText || '',
            ];

            const shortTexts = Array.from(block.querySelectorAll('div, span'))
              .map((element) =>
                ((element as HTMLElement).innerText || element.textContent || '')
                  .replace(/\s+/g, ' ')
                  .trim(),
              )
              .filter((text) => text.length > 0 && text.length <= 24)
              .filter(
                (text) =>
                  !['copy', '复制', 'download', '下载', 'run', '运行'].includes(text.toLowerCase()),
              );

            for (const candidate of [...rawLanguageCandidates, ...shortTexts]) {
              const compact = candidate
                .replace(/^language\s*[:：]?\s*/iu, '')
                .replace(/\s+/g, ' ')
                .trim();
              const codeMatch = compact.match(/^([a-z0-9_+#.-]{1,24})\s+code$/iu);
              if (/^[a-z0-9_+#.-]{1,24}$/iu.test(compact)) {
                language = compact;
                break;
              }
              if (codeMatch) {
                language = codeMatch[1];
                break;
              }
            }
          }

          let rawCodeText = '';
          if (providerId === 'qwen') {
            const qwenBody = block.querySelector('.qwen-markdown-code-body');
            if (qwenBody instanceof HTMLElement) {
              const explicitLines = Array.from(qwenBody.querySelectorAll('.view-line, .cm-line'))
                .map((line) =>
                  ((line as HTMLElement).innerText || line.textContent || '')
                    .replace(/\u00a0/g, ' ')
                    .trimEnd(),
                )
                .filter((line) => line.trim().length > 0);

              if (explicitLines.length > 0) {
                rawCodeText = explicitLines.join('\n');
              }

              if (!rawCodeText) {
                const viewLines = qwenBody.querySelector('.view-lines');
                if (viewLines instanceof HTMLElement) {
                  rawCodeText = viewLines.innerText || viewLines.textContent || '';
                }
              }

              if (!rawCodeText) {
                const qwenContent = qwenBody.querySelector('.cm-content');
                if (qwenContent instanceof HTMLElement) {
                  rawCodeText = qwenContent.innerText || qwenContent.textContent || '';
                }
              }

              if (!rawCodeText) {
                rawCodeText = qwenBody.innerText || qwenBody.textContent || '';
              }
            }
          } else if (providerId === 'chatgpt') {
            const chatgptContent = block.querySelector('.cm-content');
            if (chatgptContent instanceof HTMLElement) {
              let reconstructedText = '';
              chatgptContent.childNodes.forEach((child) => {
                if (child instanceof HTMLBRElement) {
                  reconstructedText += '\n';
                  return;
                }
                reconstructedText += child.textContent || '';
              });
              rawCodeText =
                reconstructedText || chatgptContent.innerText || chatgptContent.textContent || '';
            }
          }

          if (!rawCodeText) {
            const preCode = block.querySelector('pre code');
            if (preCode instanceof HTMLElement) {
              rawCodeText = preCode.textContent || preCode.innerText || '';
            }
          }

          if (!rawCodeText) {
            const pre = block.matches('pre') ? block : block.querySelector('pre');
            if (pre instanceof HTMLElement) {
              rawCodeText = pre.innerText || pre.textContent || '';
            }
          }

          if (!rawCodeText) {
            const inlineCode = block.querySelector('code');
            if (inlineCode instanceof HTMLElement) {
              rawCodeText = inlineCode.innerText || inlineCode.textContent || '';
            }
          }

          const codeLines: string[] = [];
          let expectedLineNumber = 1;
          rawCodeText
            .replace(/\r\n/g, '\n')
            .replace(/\u00a0/g, ' ')
            .split('\n')
            .forEach((line) => {
              if (/^\s*\d+\s*$/u.test(line)) {
                if (Number(line.trim()) === expectedLineNumber) {
                  expectedLineNumber += 1;
                }
                return;
              }

              let normalizedLine = line;
              const lineNumberMatch = normalizedLine.match(/^(\s*)(\d{1,6})(?=\s*\S)/u);
              if (lineNumberMatch) {
                const numericPrefix = Number(lineNumberMatch[2]);
                if (numericPrefix === expectedLineNumber || expectedLineNumber === 1) {
                  normalizedLine = `${lineNumberMatch[1]}${normalizedLine.slice(lineNumberMatch[0].length)}`;
                  expectedLineNumber = numericPrefix + 1;
                }
              }

              codeLines.push(normalizedLine);
            });

          while (codeLines.length > 0 && !codeLines[0].trim()) {
            codeLines.shift();
          }
          while (codeLines.length > 0 && !codeLines[codeLines.length - 1].trim()) {
            codeLines.pop();
          }

          const codeText = codeLines
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trimEnd();
          if (!codeText) {
            return;
          }

          const markdown = `${language ? `\`\`\`${language}` : '```'}\n${codeText}\n\`\`\``.trim();
          const token = `BRIDGECODETOKEN${providerId.toUpperCase()}${index}END`;
          payloads.push({ token, markdown });

          const replacement = document.createElement('div');
          replacement.setAttribute('data-bridge-code-token', token);
          replacement.textContent = token;
          block.replaceWith(replacement);
        });

        return payloads;
      })()
    : [];

  const mathPayloads = (() => {
    const payloads: ExtractedMarkdownTokenPayload[] = [];
    const annotationElements = Array.from(
      root.querySelectorAll('annotation[encoding="application/x-tex"]'),
    );
    const candidates = annotationElements
      .map((annotation) => {
        const tex = (annotation.textContent || '').replace(/\r\n/g, '\n').trim();
        if (!tex) {
          return null;
        }

        const mathElement = annotation.closest('math');
        const displayWrapper = annotation.closest('.katex-display');
        const qwenMathWrapper = annotation.closest('.qwen-markdown-latex');
        const deepseekMathWrapper = annotation.closest('.ds-markdown-math');
        const roleMathWrapper = annotation.closest('[role="math"]');
        const katexWrapper = annotation.closest('.katex');

        const replacementRoot = (qwenMathWrapper ||
          deepseekMathWrapper ||
          displayWrapper ||
          roleMathWrapper ||
          katexWrapper ||
          mathElement) as HTMLElement | null;
        if (!(replacementRoot instanceof HTMLElement)) {
          return null;
        }

        let previousMeaningfulSibling: ChildNode | null = replacementRoot.previousSibling;
        while (
          previousMeaningfulSibling &&
          previousMeaningfulSibling.nodeType === Node.TEXT_NODE &&
          !(previousMeaningfulSibling.textContent || '').trim()
        ) {
          previousMeaningfulSibling = previousMeaningfulSibling.previousSibling;
        }

        const isBlock =
          Boolean(displayWrapper) ||
          mathElement?.getAttribute('display') === 'block' ||
          replacementRoot.tagName === 'DIV' ||
          previousMeaningfulSibling instanceof HTMLBRElement;
        return { tex, replacementRoot, isBlock };
      })
      .filter(
        (item): item is { tex: string; replacementRoot: HTMLElement; isBlock: boolean } =>
          item !== null,
      );

    const uniqueCandidates = candidates.filter(
      (candidate, index) =>
        !candidates.some(
          (other, otherIndex) =>
            otherIndex !== index && other.replacementRoot.contains(candidate.replacementRoot),
        ),
    );

    uniqueCandidates.forEach((candidate, index) => {
      const token = `BRIDGEMATHTOKEN${index}END`;
      const markdown = candidate.isBlock ? `$$\n${candidate.tex}\n$$` : `$${candidate.tex}$`;
      payloads.push({ token, markdown, display: candidate.isBlock ? 'block' : 'inline' });

      const replacement = document.createElement(candidate.isBlock ? 'div' : 'span');
      replacement.setAttribute('data-bridge-math-token', token);
      replacement.textContent = token;
      candidate.replacementRoot.replaceWith(replacement);
    });

    return payloads;
  })();

  const elements = Array.from(root.querySelectorAll('*'));
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const className =
      typeof (element as HTMLElement).className === 'string'
        ? (element as HTMLElement).className
        : '';
    const joined = [
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('data-testid') || '',
      element.getAttribute('mattooltip') || '',
      className,
      element.tagName,
    ]
      .join(' ')
      .toLowerCase();

    let shouldRemove =
      ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ||
      (element.getAttribute('role') || '').toLowerCase() === 'button';

    if (!shouldRemove) {
      for (let hintIndex = 0; hintIndex < genericHints.length; hintIndex += 1) {
        if (joined.includes(genericHints[hintIndex])) {
          shouldRemove = true;
          break;
        }
      }
    }

    if (!shouldRemove) {
      for (let hintIndex = 0; hintIndex < providerHints.length; hintIndex += 1) {
        if (joined.includes(providerHints[hintIndex])) {
          shouldRemove = true;
          break;
        }
      }
    }

    if (shouldRemove && element.parentElement) {
      element.parentElement.removeChild(element);
    }
  }

  return {
    html: root.innerHTML || '',
    text: (contentSource.innerText || contentSource.textContent || '').trim(),
    qwenTablePayloads,
    codeBlockPayloads,
    mathPayloads,
  };
}

export class ProviderClient {
  constructor(private readonly providerId: ProviderId) {}

  private readonly toggleSettleTimeoutMs = 2200;
  private readonly sessionSelfCheckTimeoutMs = 5000;
  private extractionDebugItems: Array<{
    index: number;
    method: 'copy' | 'html' | 'innerText';
    detail?: string;
    preview?: string;
  }> = [];
  private lastCopyAttemptDebug?: string;
  private lastHtmlAttemptDebug?: string;

  async sendMessage(
    page: Page,
    normalizedPrompt: NormalizedPrompt,
    options?: {
      isContinuation?: boolean;
      enableSearch?: boolean;
      enableReasoning?: boolean;
      promptMode?: 'latest-user' | 'trailing-users' | 'full-messages';
      includeTrailingUserMessages?: boolean;
      injectSystemOnFirstTurn?: boolean;
    },
  ): Promise<ChatResult> {
    this.extractionDebugItems = [];
    const provider = getProvider(this.providerId);
    await this.ensureSessionReady(page, provider);
    await this.prepareComposerForInput(page, provider);
    const input = await this.findFirstVisible(
      page,
      provider.inputSelectors,
      provider.readyTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const existingResponseCount = await this.countResponses(page, provider);
    const existingResponseCountsBySelector = await this.getResponseCountsBySelector(page, provider);
    const prompt = this.buildPrompt(normalizedPrompt, options);

    await this.applyToggle(page, provider.toggles?.search, options?.enableSearch);
    if (this.providerId === 'qwen') {
      await this.applyQwenReasoningMode(page, options?.enableReasoning);
    } else {
      await this.applyToggle(page, provider.toggles?.reasoning, options?.enableReasoning);
    }
    this.logPromptDebug(page, normalizedPrompt, options, prompt);
    await this.focusAndFill(page, provider, input, prompt);
    await this.submit(page, provider, input, existingResponseCount, page.url());

    const minimumResponseBlocks = 1;
    const responseTexts = await this.waitForStableResponses(
      page,
      provider,
      existingResponseCount,
      existingResponseCountsBySelector,
      minimumResponseBlocks,
      {
        latestUserMessage: normalizedPrompt.latestUserMessage,
        fullPrompt: prompt,
      },
    );
    const filteredResponseTexts = responseTexts.filter(
      (text) =>
        !this.isPromptEcho(text, normalizedPrompt.latestUserMessage, prompt) &&
        !this.isProviderErrorText(text),
    );
    if (filteredResponseTexts.length === 0) {
      throw new Error(`未提取到 ${this.providerId} 的有效回复文本`);
    }
    return {
      provider: this.providerId,
      url: page.url(),
      debug: {
        extraction: {
          items: [...this.extractionDebugItems],
        },
      },
      ...this.extractChatResult(filteredResponseTexts),
    };
  }

  async extractLatestResponse(
    page: Page,
    options?: { latestAssistantHint?: string },
  ): Promise<ChatResult> {
    this.extractionDebugItems = [];
    const provider = getProvider(this.providerId);
    await this.ensureSessionReady(page, provider);

    const lastNode = await this.findLatestResponseNode(
      page,
      provider,
      options?.latestAssistantHint,
    );
    if (!lastNode) {
      throw new Error(`未找到 ${this.providerId} 的回复节点`);
    }

    const fallbackText = (await lastNode.innerText().catch(() => '')).trim();

    this.lastCopyAttemptDebug = undefined;
    this.lastHtmlAttemptDebug = undefined;
    const preferredText = await this.tryExtractPreferredResponseText(page, provider, lastNode);

    const resolvedText = preferredText?.text ?? this.normalizeExtractedMarkdown(fallbackText);
    this.extractionDebugItems.push({
      index: 0,
      method: preferredText?.method ?? 'innerText',
      detail:
        preferredText?.detail ??
        `html: ${this.lastHtmlAttemptDebug ?? '未尝试'}; 使用 innerText 兜底`,
      preview: resolvedText.slice(0, 180),
    });

    const filteredResponseTexts = [resolvedText].filter(
      (text) => text && !this.isProviderErrorText(text),
    );
    if (filteredResponseTexts.length === 0) {
      throw new Error(`未提取到 ${this.providerId} 的有效回复文本`);
    }

    return {
      provider: this.providerId,
      url: page.url(),
      debug: {
        extraction: {
          items: [...this.extractionDebugItems],
        },
      },
      ...this.extractChatResult(filteredResponseTexts),
    };
  }

  private async findLatestResponseNode(
    page: Page,
    provider: ProviderConfig,
    latestAssistantHint?: string,
  ): Promise<Locator | null> {
    for (const selector of provider.responseSelectors) {
      const candidate = await this.findLatestVisibleResponseCandidate(page.locator(selector));
      if (candidate) {
        return candidate;
      }
    }

    if (this.providerId === 'gemini' || this.providerId === 'qwen') {
      return null;
    }

    const fallbackSelector = [
      ...provider.responseSelectors,
      '[class*="assistant"]',
      '[class*="markdown"]',
      '[data-message-author-role]',
      'article',
      '[class*="message"]',
      '[class*="reply"]',
      '[class*="content"]',
      'main article',
      'main section',
    ].join(', ');

    const hints = (latestAssistantHint || '')
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length >= 8)
      .sort((left, right) => right.length - left.length)
      .slice(0, 4);

    const locator = page.locator(fallbackSelector);
    const count = await locator.count().catch(() => 0);
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text.length < 20) {
        continue;
      }

      const box = await candidate.boundingBox().catch(() => null);
      const normalizedText = text.toLowerCase();
      let score = Math.min(text.length, 400);

      for (const hint of hints) {
        if (normalizedText.includes(hint.toLowerCase())) {
          score += 2000 + hint.length;
          break;
        }
      }

      if (box) {
        score += box.y;
        if (box.height > 1400) {
          score -= 200;
        } else if (box.height <= 420) {
          score += 80;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    return bestIndex >= 0 ? locator.nth(bestIndex) : null;
  }

  private async findLatestVisibleResponseCandidate(locator: Locator): Promise<Locator | null> {
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isVisible) {
        continue;
      }

      if (this.providerId === 'qwen') {
        const isFinalAnswerCandidate = await this.isQwenFinalAnswerCandidate(candidate);
        if (!isFinalAnswerCandidate) {
          continue;
        }
      }

      const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text.length >= 8) {
        return candidate;
      }
    }
    return null;
  }

  private async isQwenFinalAnswerCandidate(candidate: Locator): Promise<boolean> {
    return candidate
      .evaluate((node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }

        if (node.closest('.response-message-content.phase-answer, .phase-answer')) {
          return true;
        }

        const ownClassName = typeof node.className === 'string' ? node.className.toLowerCase() : '';
        const ancestorClassNames: string[] = [];
        let current: HTMLElement | null = node;
        for (let depth = 0; current && depth < 8; depth += 1) {
          if (typeof current.className === 'string' && current.className) {
            ancestorClassNames.push(current.className.toLowerCase());
          }
          current = current.parentElement;
        }
        const joinedAncestors = ancestorClassNames.join(' ');

        if (
          joinedAncestors.includes('thinking-tool-status') ||
          joinedAncestors.includes('thinking-status-card') ||
          joinedAncestors.includes('tool-status-card')
        ) {
          return false;
        }

        if (ownClassName.includes('qwen-chat-message-assistant')) {
          return Boolean(
            node.querySelector('.response-message-content.phase-answer, .phase-answer'),
          );
        }

        return false;
      })
      .catch(() => false);
  }

  previewPrompt(
    normalizedPrompt: NormalizedPrompt,
    options?: {
      isContinuation?: boolean;
      enableSearch?: boolean;
      enableReasoning?: boolean;
      promptMode?: 'latest-user' | 'trailing-users' | 'full-messages';
      includeTrailingUserMessages?: boolean;
      injectSystemOnFirstTurn?: boolean;
    },
  ): string {
    return this.buildPrompt(normalizedPrompt, options);
  }

  private buildPrompt(
    normalizedPrompt: NormalizedPrompt,
    options?: {
      isContinuation?: boolean;
      promptMode?: 'latest-user' | 'trailing-users' | 'full-messages';
      includeTrailingUserMessages?: boolean;
      injectSystemOnFirstTurn?: boolean;
    },
  ): string {
    const promptMode =
      options?.promptMode ??
      (options?.includeTrailingUserMessages ? 'trailing-users' : 'latest-user');

    const structuredMessages = (() => {
      if (promptMode === 'full-messages') {
        return normalizedPrompt.nonSystemMessages;
      }

      if (promptMode === 'trailing-users') {
        const hasAssistantContext = normalizedPrompt.nonSystemMessages.some(
          (message) => message.role === 'assistant',
        );
        if (hasAssistantContext && normalizedPrompt.nonSystemMessages.length > 1) {
          return normalizedPrompt.nonSystemMessages;
        }

        if (normalizedPrompt.trailingUserMessages.length > 1) {
          return normalizedPrompt.trailingUserMessages;
        }
      }

      return null;
    })();

    const needsStructuredPayload =
      Boolean(structuredMessages) ||
      Boolean(
        options?.injectSystemOnFirstTurn && normalizedPrompt.system && !options?.isContinuation,
      );

    if (needsStructuredPayload) {
      const historyMessages = structuredMessages ? structuredMessages.slice(0, -1) : [];
      const currentRequest =
        structuredMessages?.at(-1)?.content ?? normalizedPrompt.latestUserMessage;
      const systemForPrompt = options?.injectSystemOnFirstTurn
        ? normalizedPrompt.system
        : undefined;

      return this.buildStructuredPrompt(systemForPrompt, historyMessages, currentRequest);
    }

    return normalizedPrompt.latestUserMessage;
  }

  private buildStructuredPrompt(
    system: string | undefined,
    historyMessages: Array<{ role: 'user' | 'assistant'; content: string; name?: string }>,
    currentRequest: string,
  ): string {
    const lines: string[] = ['Response rules:', system?.trim() || '(none)', '', 'History:'];

    if (historyMessages.length === 0) {
      lines.push('(none)');
    } else {
      for (const message of historyMessages) {
        const speakerLabel = message.name ? ` speaker=${message.name}` : '';
        lines.push(`- role=${message.role}${speakerLabel}`);
        lines.push(message.content);
      }
    }

    lines.push('');
    lines.push('Current request:');
    lines.push(currentRequest);

    return lines.join('\n');
  }

  private logPromptDebug(
    page: Page,
    normalizedPrompt: NormalizedPrompt,
    options:
      | {
          isContinuation?: boolean;
          enableSearch?: boolean;
          enableReasoning?: boolean;
          promptMode?: 'latest-user' | 'trailing-users' | 'full-messages';
          includeTrailingUserMessages?: boolean;
          injectSystemOnFirstTurn?: boolean;
        }
      | undefined,
    prompt: string,
  ): void {
    if (!appConfig.debugPrompts) {
      return;
    }

    const metadata = {
      provider: this.providerId,
      url: page.url(),
      isContinuation: Boolean(options?.isContinuation),
      promptMode:
        options?.promptMode ??
        (options?.includeTrailingUserMessages ? 'trailing-users' : 'latest-user'),
      injectSystemOnFirstTurn: Boolean(options?.injectSystemOnFirstTurn),
      historyCount: normalizedPrompt.historyCount,
      hasSystem: normalizedPrompt.hasSystem,
      latestUserMessage: normalizedPrompt.latestUserMessage,
    };

    console.log('[bridge-prompt-debug]', JSON.stringify(metadata));
    console.log('[bridge-prompt-debug][input-begin]');
    console.log(prompt);
    console.log('[bridge-prompt-debug][input-end]');
  }

  private async applyQwenReasoningMode(
    page: Page,
    desiredState: boolean | undefined,
  ): Promise<void> {
    const desiredLabel = desiredState === undefined ? '自动' : desiredState ? '思考' : '快速';
    const currentLabel = await this.readQwenThinkingLabel(page);

    if (currentLabel === desiredLabel) {
      return;
    }

    const dropdownOpened = await page.evaluate(() => {
      const selector = document.querySelector(
        '.qwen-select-thinking .ant-select-selector, .qwen-thinking-selector .ant-select-selector',
      ) as HTMLElement | null;
      if (!selector) {
        return false;
      }

      selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      selector.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      selector.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    });

    if (!dropdownOpened) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return;
    }

    const optionStartedAt = Date.now();
    let option: Locator | null = null;
    while (Date.now() - optionStartedAt < 3000) {
      option = await this.findVisibleCandidate(
        page.locator(
          `.ant-select-dropdown .ant-select-item-option[title="${desiredLabel}"], .ant-select-dropdown [role="option"][aria-label="${desiredLabel}"]`,
        ),
      );
      if (option) {
        break;
      }
      await page.waitForTimeout(100);
    }

    if (!option) {
      await page.keyboard.press('Escape').catch(() => undefined);
      return;
    }

    await option.click({ timeout: 3000 });

    const startedAt = Date.now();
    while (Date.now() - startedAt < 3000) {
      if ((await this.readQwenThinkingLabel(page)) === desiredLabel) {
        return;
      }
      await page.waitForTimeout(150);
    }
  }

  private async readQwenThinkingLabel(page: Page): Promise<string> {
    const label = await this.findVisibleCandidate(
      page.locator(
        '.qwen-select-thinking .ant-select-selection-item, .qwen-select-thinking-label-text',
      ),
    );
    if (!label) {
      return '';
    }

    try {
      return (await label.innerText()).trim();
    } catch {
      return '';
    }
  }

  private async ensureSessionReady(page: Page, provider: ProviderConfig): Promise<void> {
    if (page.isClosed()) {
      throw new Error(`会话页已关闭，无法继续向 ${this.providerId} 发送消息`);
    }

    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => '');
    const hasExpectedUrl = this.matchesExpectedUrl(currentUrl, provider);
    const hasExpectedTitle = this.matchesExpectedTitle(currentTitle, provider);
    const hasVisibleInput = await this.hasAnyVisibleCandidate(page, provider.inputSelectors);

    if (hasExpectedUrl && (hasVisibleInput || hasExpectedTitle)) {
      return;
    }

    await page.goto(provider.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    if (this.providerId === 'grok') {
      await this.tryPrepareGrokComposer(page);
    }

    const recoveredInput = await this.hasAnyVisibleCandidate(page, provider.inputSelectors);
    if (recoveredInput) {
      return;
    }

    const blockingState = await this.detectBlockingPageState(page, provider, recoveredInput);
    if (blockingState) {
      throw new Error(blockingState);
    }

    const recoveredTitle = await page.title().catch(() => '');
    const recoveredUrl = page.url();
    throw new Error(
      `当前 ${this.providerId} 页签看起来不在可发送状态，已尝试恢复但仍未找到输入框。title=${recoveredTitle || '<empty>'}, url=${recoveredUrl || currentUrl || '<empty>'}`,
    );
  }

  private async prepareComposerForInput(page: Page, provider: ProviderConfig): Promise<void> {
    if (this.providerId !== 'deepseek') {
      return;
    }

    const currentUrl = page.url();
    const isRootPage = currentUrl === provider.url || currentUrl === `${provider.url}`;
    if (!isRootPage) {
      return;
    }

    await page.waitForTimeout(1200);
  }

  private matchesExpectedUrl(currentUrl: string, provider: ProviderConfig): boolean {
    if (!currentUrl) {
      return false;
    }

    const patterns = provider.urlPatterns ?? [new URL(provider.url).hostname];
    return patterns.some((pattern) => currentUrl.includes(pattern));
  }

  private matchesExpectedTitle(currentTitle: string, provider: ProviderConfig): boolean {
    if (!currentTitle) {
      return false;
    }

    const hints = provider.titleHints ?? [provider.label];
    const lowerTitle = currentTitle.toLowerCase();
    return hints.some((hint) => lowerTitle.includes(hint.toLowerCase()));
  }

  private async hasAnyVisibleCandidate(page: Page, selectors: string[]): Promise<boolean> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.sessionSelfCheckTimeoutMs) {
      for (const selector of selectors) {
        const locator = await this.findVisibleCandidate(page.locator(selector));
        if (locator) {
          return true;
        }
      }

      await page.waitForTimeout(300);
    }

    return false;
  }

  private async tryPrepareGrokComposer(page: Page): Promise<void> {
    const newChatButton = await this.findVisibleCandidate(
      page.locator(
        'button:has-text("新建聊天"), a:has-text("新建聊天"), button:has-text("New chat"), a:has-text("New chat")',
      ),
    );
    if (newChatButton) {
      try {
        await newChatButton.click({ timeout: 3000 });
        await page.waitForTimeout(1200);
      } catch {
        // Ignore and continue with generic recovery.
      }
    }
  }

  private async findFirstVisible(
    page: Page,
    selectors: string[],
    timeoutMs: number,
  ): Promise<Locator> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      for (const selector of selectors) {
        const locator = await this.findVisibleCandidate(page.locator(selector));
        if (locator) {
          return locator;
        }
      }

      await page.waitForTimeout(500);
    }

    throw new Error(`未找到输入框，请先在浏览器中登录并打开对应页面: ${this.providerId}`);
  }

  private async focusAndFill(
    page: Page,
    provider: ProviderConfig,
    input: Locator,
    prompt: string,
  ): Promise<void> {
    let currentInput = input;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const tagName = await currentInput.evaluate((node) => node.tagName.toLowerCase());
        const isContentEditable = await currentInput.evaluate(
          (node) => (node as HTMLElement).isContentEditable,
        );

        if (tagName === 'textarea' || tagName === 'input') {
          await this.fillTextInput(page, provider, currentInput, prompt);
          return;
        }

        if (isContentEditable) {
          await this.fillContentEditable(page, currentInput, prompt);
          return;
        }

        throw new Error('找到输入元素，但不是可写入的 textarea/input/contenteditable');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= 2) {
          break;
        }

        await page.waitForTimeout(250);
        currentInput = await this.findFirstVisible(page, provider.inputSelectors, 3000).catch(
          () => currentInput,
        );
      }
    }

    throw lastError ?? new Error('未能写入输入框');
  }

  private async fillTextInput(
    page: Page,
    provider: ProviderConfig,
    input: Locator,
    prompt: string,
  ): Promise<void> {
    const avoidKeyboardTypeFallback =
      prompt.includes('\n') && this.providerMaySubmitOnEnter(provider);

    try {
      await input.click({ timeout: 2000 }).catch(() => undefined);
      await input.fill('');
      await input.fill(prompt);
      if (await this.textInputContainsText(page, provider, input, prompt)) {
        return;
      }
    } catch {
      // Fall through to keyboard/DOM fallback when native fill is unstable.
    }

    try {
      await input.click({ timeout: 2000 }).catch(() => undefined);
      await input.focus();
      await input.press('ControlOrMeta+A');
      await input.press('Backspace');
      await page.keyboard.insertText(prompt);
      await page.waitForTimeout(80);
      if (await this.textInputContainsText(page, provider, input, prompt)) {
        return;
      }
    } catch {
      // Fall through to the next fallback.
    }

    if (!avoidKeyboardTypeFallback) {
      try {
        await input.click({ timeout: 2000 }).catch(() => undefined);
        await input.focus();
        await input.press('ControlOrMeta+A');
        await input.press('Backspace');
        await input.type(prompt, { delay: 12 });
        await page.waitForTimeout(80);
        if (await this.textInputContainsText(page, provider, input, prompt)) {
          return;
        }
      } catch {
        // Fall through to DOM-based injection.
      }
    }

    await input.evaluate((node, value) => {
      const element = node as HTMLInputElement | HTMLTextAreaElement;
      const previousValue = element.value;
      element.focus();
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (valueSetter) {
        valueSetter.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: value,
        }),
      );
      const tracker = (
        element as HTMLInputElement & { _valueTracker?: { setValue(nextValue: string): void } }
      )._valueTracker;
      tracker?.setValue(previousValue);
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value,
        }),
      );
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, prompt);

    await page.waitForTimeout(80);

    if (!(await this.textInputContainsText(page, provider, input, prompt))) {
      const latestObservedValue = await this.readLatestTextInputValue(page, provider, input).catch(
        () => '',
      );
      if (
        this.normalizeTextInputValue(latestObservedValue) === this.normalizeTextInputValue(prompt)
      ) {
        return;
      }
      throw new Error(
        `未能稳定写入 textarea/input（当前观测值: ${latestObservedValue.slice(0, 120) || '<empty>'}）`,
      );
    }
  }

  private providerMaySubmitOnEnter(provider: ProviderConfig): boolean {
    if (this.providerId === 'qwen' || this.providerId === 'deepseek') {
      return true;
    }

    if (provider.submitWithEnterFallback !== false) {
      return true;
    }

    return Boolean(provider.keyboardSubmitShortcuts?.includes('Enter'));
  }

  private async fillContentEditable(page: Page, input: Locator, prompt: string): Promise<void> {
    try {
      await input.fill('');
      await input.fill(prompt);
      if (await this.contentEditableContainsText(input, prompt)) {
        return;
      }
    } catch {
      // Fall through to keyboard/DOM fallback when native fill is not accepted.
    }

    try {
      await input.focus();
      await input.press('ControlOrMeta+A');
      await input.press('Backspace');
      await page.keyboard.insertText(prompt);
      if (await this.contentEditableContainsText(input, prompt)) {
        return;
      }
    } catch {
      // Fall through to DOM-based injection when focus/click flows are obstructed.
    }

    await input.evaluate((node, value) => {
      const element = node as HTMLElement;
      element.focus();
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
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value,
        }),
      );
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, prompt);
  }

  private async contentEditableContainsText(
    input: Locator,
    expectedText: string,
  ): Promise<boolean> {
    try {
      return await input.evaluate((node, value) => {
        const element = node as HTMLElement;
        const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
        const actual = normalize(element.innerText || element.textContent || '');
        const expected = normalize(value);
        return actual === expected || actual.includes(expected);
      }, expectedText);
    } catch {
      return false;
    }
  }

  private async textInputContainsText(
    page: Page,
    provider: ProviderConfig,
    input: Locator,
    expectedText: string,
  ): Promise<boolean> {
    const matchesValue = async (candidate: Locator): Promise<boolean> => {
      return candidate.evaluate((node, value) => {
        const element = node as HTMLInputElement | HTMLTextAreaElement;
        const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
        const actual = normalize(element.value || '');
        const expected = normalize(value);
        return actual === expected || actual.includes(expected);
      }, expectedText);
    };

    try {
      if (await matchesValue(input)) {
        return true;
      }
    } catch {
      // Fall through to re-find the current live input.
    }

    try {
      const latestInput = await this.findFirstVisible(page, provider.inputSelectors, 1200);
      return await matchesValue(latestInput);
    } catch {
      return false;
    }
  }

  private async readLatestTextInputValue(
    page: Page,
    provider: ProviderConfig,
    input: Locator,
  ): Promise<string> {
    const readValue = async (candidate: Locator): Promise<string> => {
      return candidate.evaluate((node) => {
        const element = node as HTMLInputElement | HTMLTextAreaElement;
        return element.value || '';
      });
    };

    try {
      const directValue = await readValue(input);
      if (directValue) {
        return directValue;
      }
    } catch {
      // Fall through to the latest visible input.
    }

    const latestInput = await this.findFirstVisible(page, provider.inputSelectors, 1200);
    return readValue(latestInput);
  }

  private normalizeTextInputValue(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  }

  private async submit(
    page: Page,
    provider: ProviderConfig,
    input: Locator,
    previousResponseCount: number,
    previousUrl: string,
  ): Promise<void> {
    // signalTimeoutMs: how long to wait after each send attempt for a confirmation signal.
    const signalTimeoutMs = provider.submissionSignalTimeoutMs ?? 8000;
    // buttonClickFired: set when a send button was clicked without throwing.
    // Once true, we stop trying other selectors/shortcuts to prevent double-sending.
    let buttonClickFired = false;

    for (const selector of provider.sendButtonSelectors) {
      const button = await this.findVisibleCandidate(page.locator(selector));
      if (button) {
        try {
          if (await button.isEnabled()) {
            await button.click({ timeout: 5000 });
            buttonClickFired = true;
            if (
              await this.waitForSubmissionSignal(
                page,
                provider,
                input,
                previousResponseCount,
                previousUrl,
                signalTimeoutMs,
              )
            ) {
              return;
            }
            // Button clicked but confirmation timed out.
            // Break immediately—do NOT try the next selector to prevent double-sending.
            break;
          }
        } catch {
          // Click threw—button didn't fire. Safe to try the next selector.
        }
      }
    }

    // Only try the heuristic button if no primary send button was clicked.
    if (!buttonClickFired) {
      const heuristicButton = await this.findHeuristicSendButton(page);
      if (heuristicButton) {
        try {
          if (await heuristicButton.isEnabled()) {
            await heuristicButton.click({ timeout: 5000 });
            buttonClickFired = true;
            if (
              await this.waitForSubmissionSignal(
                page,
                provider,
                input,
                previousResponseCount,
                previousUrl,
                signalTimeoutMs,
              )
            ) {
              return;
            }
            // Same: stop here to avoid double-sending via keyboard fallback.
          }
        } catch {
          // Fall through to keyboard-based submission.
        }
      }
    }

    // Only attempt keyboard shortcuts and Enter fallback when no button was clicked at all.
    // If buttonClickFired is true, the message may already be in-flight—retrying would double-send.
    if (!buttonClickFired) {
      const keyboardShortcuts = provider.keyboardSubmitShortcuts?.length
        ? provider.keyboardSubmitShortcuts
        : ['ControlOrMeta+Enter'];

      if (
        await this.tryKeyboardSubmitShortcuts(
          input,
          keyboardShortcuts,
          page,
          provider,
          previousResponseCount,
          previousUrl,
          signalTimeoutMs,
        )
      ) {
        return;
      }

      if (provider.submitWithEnterFallback === false) {
        throw new Error(
          `${this.providerId} 未找到可用发送按钮，已停止 Enter 回退以避免误触发网页控件`,
        );
      }

      await input.focus();
      await input.press('Enter');
      if (
        await this.waitForSubmissionSignal(
          page,
          provider,
          input,
          previousResponseCount,
          previousUrl,
          signalTimeoutMs,
        )
      ) {
        return;
      }

      throw new Error(
        `${this.providerId} 未找到可用发送按钮，且快捷键与 Enter 回退都未确认提交成功`,
      );
    }

    // A button was clicked but no submission signal appeared within the timeout.
    // We intentionally skip keyboard/Enter fallback here to prevent double-sending.
    throw new Error(
      `${this.providerId} 发送按钮点击后未确认提交成功（信号等待 ${signalTimeoutMs}ms 超时），已跳过后续重试以避免重复发送`,
    );
  }

  private async tryKeyboardSubmitShortcuts(
    input: Locator,
    shortcuts: string[],
    page: Page,
    provider: ProviderConfig,
    previousResponseCount: number,
    previousUrl: string,
    signalTimeoutMs: number,
  ): Promise<boolean> {
    for (const shortcut of shortcuts) {
      try {
        await input.focus();
        await input.press(shortcut);
        if (
          await this.waitForSubmissionSignal(
            page,
            provider,
            input,
            previousResponseCount,
            previousUrl,
            signalTimeoutMs,
          )
        ) {
          return true;
        }
        // Shortcut fired but no confirmation signal—stop retrying to avoid double-send.
        break;
      } catch {
        // Press threw. Try the next shortcut.
      }
    }

    return false;
  }

  private async waitForSubmissionSignal(
    page: Page,
    provider: ProviderConfig,
    input: Locator,
    previousResponseCount: number,
    previousUrl: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (page.url() !== previousUrl) {
        return true;
      }

      if (await this.isBusy(page, provider)) {
        return true;
      }

      if ((await this.countResponses(page, provider)) > previousResponseCount) {
        return true;
      }

      if (await this.isInputCleared(input)) {
        return true;
      }

      await page.waitForTimeout(150);
    }

    return false;
  }

  private async isInputCleared(input: Locator): Promise<boolean> {
    try {
      return await input.evaluate((node) => {
        const element = node as HTMLElement & { value?: string };
        const tagName = element.tagName.toLowerCase();

        if (tagName === 'textarea' || tagName === 'input') {
          return !(element.value || '').trim();
        }

        if (element.isContentEditable) {
          return !(element.innerText || element.textContent || '').trim();
        }

        return false;
      });
    } catch {
      return false;
    }
  }

  private async countResponses(page: Page, provider: ProviderConfig): Promise<number> {
    let best = 0;

    for (const selector of provider.responseSelectors) {
      const count = await page.locator(selector).count();
      best = Math.max(best, count);
    }

    return best;
  }

  private async getResponseCountsBySelector(
    page: Page,
    provider: ProviderConfig,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    for (const selector of provider.responseSelectors) {
      counts[selector] = await page
        .locator(selector)
        .count()
        .catch(() => 0);
    }

    return counts;
  }

  private async waitForStableResponses(
    page: Page,
    provider: ProviderConfig,
    previousCount: number,
    previousCountsBySelector: Record<string, number> | undefined,
    minimumResponseBlocks: number,
    promptContext?: {
      latestUserMessage: string;
      fullPrompt: string;
    },
  ): Promise<string[]> {
    const startedAt = Date.now();
    // idleTimeoutMs: 内容无变化且不处于忙碌状态超过此时长则放弃
    const idleTimeoutMs = provider.progressIdleTimeoutMs ?? 30_000;
    // maxTotalMs: 单次生成绝对上限，防止真正卡死
    const maxTotalMs = provider.maxGenerationTimeoutMs ?? 600_000;
    let targetSelector: string | undefined;
    let previousSnapshot = '';
    let stablePolls = 0;
    let lastActivityAt = startedAt;
    let lastFastFailMessage: string | undefined;

    while (true) {
      const now = Date.now();
      if (now - startedAt >= maxTotalMs) break; // 硬上限
      if (now - lastActivityAt >= idleTimeoutMs) break; // 空闲超时

      const resolvedTargetSelector = await this.resolveUpdatedResponseSelector(
        page,
        provider,
        previousCount,
        previousCountsBySelector,
      );
      if (resolvedTargetSelector) {
        targetSelector = resolvedTargetSelector;
      }

      // 将 isBusy 提到外层，以便无响应内容时也能检测到活跃状态
      const busy = await this.isBusy(page, provider);

      let meaningfulTexts: string[];
      if (targetSelector) {
        const previousSelectorCount = previousCountsBySelector?.[targetSelector] ?? previousCount;
        const texts = await this.collectNewResponseTexts(
          page,
          provider,
          targetSelector,
          previousSelectorCount,
        );
        const snapshot = JSON.stringify(texts);

        // 内容有变化或模型仍在生成 → 刷新活跃时间戳
        if (snapshot !== previousSnapshot || busy) {
          lastActivityAt = Date.now();
        }

        if (texts.length >= minimumResponseBlocks && snapshot === previousSnapshot) {
          stablePolls += 1;
        } else {
          stablePolls = 0;
          previousSnapshot = snapshot;
        }

        meaningfulTexts = this.filterMeaningfulResponseTexts(texts, promptContext);

        // Texts are stable and model is idle, but all were filtered as non-meaningful.
        // This typically means the provider returned a quota/rate-limit error message inside
        // the response container (e.g. Grok Think-mode daily limit). Fast-fail with a clear
        // message instead of waiting for the idle timeout.
        if (
          texts.length >= minimumResponseBlocks &&
          stablePolls >= STABLE_POLLS_REQUIRED &&
          !busy &&
          meaningfulTexts.length < minimumResponseBlocks &&
          this.containsQuotaErrorContent(texts)
        ) {
          throw new Error(
            `${this.providerId} 当前会话已达到额度或频率限制，请切换会话、升级额度或稍后再试；如果这是登录、风控、额度或网络问题，请查看已置前的浏览器页签并手动处理。`,
          );
        }

        if (
          meaningfulTexts.length >= minimumResponseBlocks &&
          stablePolls >= STABLE_POLLS_REQUIRED &&
          !busy
        ) {
          // DeepSeek R1: thinking block stabilizes before answer block appears.
          // Guard against premature finalization when only thinking blocks are present.
          if (this.providerId === 'deepseek' && targetSelector === '.ds-markdown') {
            const hasNonThinkingBlock = await this.deepSeekHasNonThinkingBlock(
              page,
              targetSelector,
              previousSelectorCount,
            );
            if (!hasNonThinkingBlock) {
              await page.waitForTimeout(POLL_INTERVAL_MS);
              continue;
            }
          }

          return this.finalizeStableResponseTexts(
            page,
            provider,
            targetSelector,
            previousSelectorCount,
            texts,
          );
        }
      } else if (busy) {
        // 尚未出现响应元素但模型正忙 → 仍处于活跃状态
        lastActivityAt = Date.now();
      }

      // Only scan the page body for blocking states before any response element has been
      // discovered. Once targetSelector is set the page body contains LLM response content
      // that may coincidentally match quota/error keywords, causing false positives.
      const shouldCheckBlockingState =
        targetSelector === undefined && Date.now() - startedAt >= 4000;

      if (shouldCheckBlockingState) {
        const blockingState = await this.detectBlockingPageState(page, provider);
        if (blockingState) {
          throw new Error(blockingState);
        }

        lastFastFailMessage = await this.detectFastFailState(page);
        if (lastFastFailMessage) {
          throw new Error(lastFastFailMessage);
        }
      }

      await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    if (previousSnapshot) {
      const snapshotTexts = JSON.parse(previousSnapshot) as string[];
      const meaningfulSnapshotTexts = this.filterMeaningfulResponseTexts(
        snapshotTexts,
        promptContext,
      );

      if (meaningfulSnapshotTexts.length >= minimumResponseBlocks) {
        const previousSelectorCount = targetSelector
          ? (previousCountsBySelector?.[targetSelector] ?? previousCount)
          : previousCount;
        return this.finalizeStableResponseTexts(
          page,
          provider,
          targetSelector,
          previousSelectorCount,
          snapshotTexts,
        );
      }
    }

    throw new Error(lastFastFailMessage ?? `未能稳定提取 ${this.providerId} 的回复内容`);
  }

  private async resolveUpdatedResponseSelector(
    page: Page,
    provider: ProviderConfig,
    previousCount: number,
    previousCountsBySelector: Record<string, number> | undefined,
  ): Promise<string | undefined> {
    for (const selector of provider.responseSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      const previousSelectorCount = previousCountsBySelector?.[selector] ?? previousCount;
      if (count > previousSelectorCount) {
        return selector;
      }
    }

    return undefined;
  }

  private async detectBlockingPageState(
    page: Page,
    provider: ProviderConfig,
    hasVisibleInput?: boolean,
  ): Promise<string | undefined> {
    const bodyText = await page
      .locator('body')
      .evaluate((node) => ((node as HTMLElement).innerText || '').trim().slice(0, 5000))
      .catch(() => '');
    const normalizedBody = this.normalizeComparableText(bodyText).toLowerCase();
    if (!normalizedBody) {
      return undefined;
    }

    const visibleInput =
      typeof hasVisibleInput === 'boolean'
        ? hasVisibleInput
        : await this.hasAnyVisibleCandidate(page, provider.inputSelectors);

    const choiceHints = [
      'choose a response',
      'pick a response',
      'pick your preferred response',
      'select the better response',
      '选择一个回答',
      '选择你更喜欢的回答',
      '请选择一个回答',
      '两个回答',
      'response a',
      'response b',
    ];
    const matchedChoiceHint = choiceHints.find((hint) => normalizedBody.includes(hint));
    if (matchedChoiceHint) {
      return `${this.providerId} 当前页面要求先手动选择候选回答，已暂停自动发送，请查看已置前页签后再继续`;
    }

    const quotaHints = [
      'reached our limit',
      'reached the current usage cap',
      'you have reached the current usage cap',
      'you have hit the usage cap',
      'rate limit exceeded',
      'message cap',
      '额度已满',
      '额度已用完',
      '额度已耗尽',
      '达到消息上限',
      '达到使用上限',
      'too many requests',
      'too many messages',
    ];
    const matchedQuotaHint = quotaHints.find((hint) => normalizedBody.includes(hint));
    // detectBlockingPageState is only called when targetSelector===undefined (no response element
    // found yet), so the body text cannot yet contain AI response content. No visibleInput guard
    // needed here—the targetSelector guard is the primary protection against false positives.
    if (matchedQuotaHint) {
      return `${this.providerId} 当前会话已达到额度或频率限制，请切换会话、升级额度或稍后再试`;
    }

    const networkHints = [
      'network error',
      'connection failed',
      'unable to load',
      'failed to connect',
      '网络错误',
      '网络异常',
      '连接失败',
      '无法连接',
      '请检查网络',
    ];
    const matchedNetworkHint = networkHints.find((hint) => normalizedBody.includes(hint));
    if (matchedNetworkHint) {
      return `${this.providerId} 当前页面出现网络错误，请查看页签状态并稍后重试`;
    }

    const authHints = [
      'log in',
      'login',
      'sign in',
      'sign up',
      'continue with google',
      'continue with apple',
      '继续使用 google',
      '继续使用 apple',
      '登录',
      '登入',
      '注册',
      '手机号登录',
      '扫码登录',
    ];
    const matchedAuthHint = authHints.find((hint) => normalizedBody.includes(hint));
    const currentUrl = page.url().toLowerCase();
    const likelyAuthUrl = /(login|signin|auth|passport|accounts?\.)/.test(currentUrl);
    if ((!visibleInput && matchedAuthHint) || (likelyAuthUrl && !visibleInput)) {
      return `${this.providerId} 当前页面需要重新登录，请查看已置前页签并手动完成登录`;
    }

    return undefined;
  }

  private async detectFastFailState(page: Page): Promise<string | undefined> {
    const hints = this.getFastFailTextHints();
    if (hints.length === 0) {
      return undefined;
    }

    const bodyText = await page
      .locator('body')
      .evaluate((node) => ((node as HTMLElement).innerText || '').trim().slice(0, 4000))
      .catch(() => '');
    const normalizedBody = this.normalizeComparableText(bodyText).toLowerCase();
    if (!normalizedBody) {
      return undefined;
    }

    const matched = hints.find((hint) => normalizedBody.includes(hint.toLowerCase()));
    if (!matched) {
      return undefined;
    }

    return this.providerId === 'grok'
      ? 'Grok 当前会话已触发消息上限或发送限制，请切换会话或稍后重试'
      : `${this.providerId} 页面当前出现错误状态：${matched}`;
  }

  private containsQuotaErrorContent(texts: string[]): boolean {
    const combined = this.normalizeComparableText(texts.join(' ')).toLowerCase();
    const quotaPhrases = [
      'reached our limit',
      'reached the current usage cap',
      'you have reached the current usage cap',
      'you have hit the usage cap',
      'reached your daily limit',
      'daily limit for',
      'rate limit exceeded',
      'message cap',
      '额度已满',
      '额度已用完',
      '额度已耗尽',
      '达到消息上限',
      '达到使用上限',
      'too many requests',
      'too many messages',
    ];
    return quotaPhrases.some((phrase) => combined.includes(phrase));
  }

  private async isBusy(page: Page, provider: ProviderConfig): Promise<boolean> {
    for (const selector of provider.busySelectors ?? []) {
      const locator = await this.findVisibleCandidate(page.locator(selector));
      if (locator) {
        return true;
      }
    }

    return false;
  }

  private async applyToggle(
    page: Page,
    toggleConfig: ToggleConfig | undefined,
    desiredState: boolean | undefined,
  ): Promise<void> {
    if (!toggleConfig || typeof desiredState !== 'boolean') {
      return;
    }

    const button = await this.findToggleButton(page, toggleConfig);
    if (!button) {
      return;
    }

    const before = await this.readToggleSnapshot(page, button, toggleConfig);

    if (before.active === desiredState) {
      return;
    }

    await button.click({ timeout: 3000 });
    const afterFirstClick = await this.waitForToggleSnapshot(page, toggleConfig, before);

    if (afterFirstClick.active === desiredState) {
      return;
    }

    const changedAfterFirstClick =
      before.active !== afterFirstClick.active ||
      before.fingerprint !== afterFirstClick.fingerprint;
    if (changedAfterFirstClick) {
      return;
    }

    const secondButton = await this.findToggleButton(page, toggleConfig);
    if (secondButton) {
      await secondButton.click({ timeout: 3000 });
      await this.waitForToggleSnapshot(page, toggleConfig, afterFirstClick);
    }
  }

  private async findToggleButton(page: Page, toggleConfig: ToggleConfig): Promise<Locator | null> {
    for (const selector of toggleConfig.buttonSelectors) {
      const locator = await this.findVisibleCandidate(page.locator(selector));
      if (locator) {
        return locator;
      }
    }

    return null;
  }

  private async findVisibleCandidate(locator: Locator): Promise<Locator | null> {
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      try {
        if (await candidate.isVisible()) {
          return candidate;
        }
      } catch {
        // Ignore transient DOM detach.
      }
    }

    return null;
  }

  private async findHeuristicSendButton(page: Page): Promise<Locator | null> {
    const candidates = page.locator('button, [role="button"]');
    const count = await candidates.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      try {
        if (!(await candidate.isVisible()) || !(await candidate.isEnabled())) {
          continue;
        }

        const matches = await candidate.evaluate((node) => {
          const element = node as HTMLElement;
          const joinedText = [
            element.innerText || '',
            element.getAttribute('aria-label') || '',
            element.getAttribute('title') || '',
            element.getAttribute('data-testid') || '',
            typeof element.className === 'string' ? element.className : '',
          ]
            .join(' ')
            .toLowerCase();

          const positiveHints = [
            'send',
            'submit',
            '发送',
            '提交',
            'ask grok',
            'grok anything',
            'arrow-up',
            'icon-send',
          ];
          const negativeHints = [
            'stop',
            'cancel',
            'retry',
            'regenerate',
            '重新生成',
            '停止',
            '取消',
            '中断',
            'search',
            'think',
          ];

          return (
            positiveHints.some((hint) => joinedText.includes(hint)) &&
            !negativeHints.some((hint) => joinedText.includes(hint))
          );
        });

        if (matches) {
          return candidate;
        }
      } catch {
        // Ignore transient DOM detach.
      }
    }

    return null;
  }

  private async isToggleActive(
    page: Page,
    button: Locator,
    toggleConfig: ToggleConfig,
  ): Promise<boolean | undefined> {
    const matchedByActiveSelector = await this.matchesActiveSelector(
      page,
      button,
      toggleConfig.activeSelectors ?? [],
    );
    if (matchedByActiveSelector !== undefined) {
      return matchedByActiveSelector;
    }

    try {
      return await button.evaluate((node) => {
        const element = node as HTMLElement;
        const ariaPressed = element.getAttribute('aria-pressed');
        const ariaChecked = element.getAttribute('aria-checked');
        const dataState = element.getAttribute('data-state');
        const dataSelected = element.getAttribute('data-selected');
        const className = element.className || '';

        if (ariaPressed === 'true' || ariaChecked === 'true') {
          return true;
        }

        if (ariaPressed === 'false' || ariaChecked === 'false') {
          return false;
        }

        if (dataState === 'on' || dataSelected === 'true') {
          return true;
        }

        if (dataState === 'off' || dataSelected === 'false') {
          return false;
        }

        if (typeof className === 'string') {
          const lower = className.toLowerCase();
          if (lower.includes('active') || lower.includes('selected') || lower.includes('enabled')) {
            return true;
          }
        }

        return undefined;
      });
    } catch {
      return undefined;
    }
  }

  private async matchesActiveSelector(
    page: Page,
    button: Locator,
    selectors: string[],
  ): Promise<boolean | undefined> {
    if (selectors.length === 0) {
      return undefined;
    }

    const buttonHandle = await button.elementHandle();
    if (!buttonHandle) {
      return undefined;
    }

    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count();

      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        try {
          if (!(await candidate.isVisible())) {
            continue;
          }
        } catch {
          continue;
        }

        const candidateHandle = await candidate.elementHandle();
        if (!candidateHandle) {
          continue;
        }

        try {
          const isSameNode = await page.evaluate(
            ([left, right]) => left === right,
            [buttonHandle, candidateHandle],
          );

          if (isSameNode) {
            return true;
          }
        } catch {
          // Ignore transient DOM detach.
        } finally {
          await candidateHandle.dispose();
        }
      }
    }

    await buttonHandle.dispose();
    return false;
  }

  private async readToggleSnapshot(
    page: Page,
    button: Locator,
    toggleConfig: ToggleConfig,
  ): Promise<{ active: boolean | undefined; fingerprint: string }> {
    const active = await this.isToggleActive(page, button, toggleConfig);

    try {
      const fingerprint = await button.evaluate((node) => {
        const element = node as HTMLElement;
        return JSON.stringify({
          text: (element.innerText || '').trim(),
          ariaPressed: element.getAttribute('aria-pressed') || '',
          ariaChecked: element.getAttribute('aria-checked') || '',
          dataState: element.getAttribute('data-state') || '',
          dataSelected: element.getAttribute('data-selected') || '',
          className: typeof element.className === 'string' ? element.className : '',
        });
      });

      return { active, fingerprint };
    } catch {
      return { active, fingerprint: String(active) };
    }
  }

  private async waitForToggleSnapshot(
    page: Page,
    toggleConfig: ToggleConfig,
    previous: { active: boolean | undefined; fingerprint: string },
  ): Promise<{ active: boolean | undefined; fingerprint: string }> {
    const startedAt = Date.now();
    let latest = previous;

    while (Date.now() - startedAt < this.toggleSettleTimeoutMs) {
      const button = await this.findToggleButton(page, toggleConfig);
      if (!button) {
        return latest;
      }

      latest = await this.readToggleSnapshot(page, button, toggleConfig);
      if (latest.active !== previous.active || latest.fingerprint !== previous.fingerprint) {
        return latest;
      }

      await page.waitForTimeout(150);
    }

    return latest;
  }

  private async collectNewResponseTexts(
    page: Page,
    provider: ProviderConfig,
    selector: string,
    previousCount: number,
  ): Promise<string[]> {
    const locator = page.locator(selector);
    const count = await locator.count();
    const texts: string[] = [];

    for (let index = previousCount; index < count; index += 1) {
      const candidate = locator.nth(index);
      this.lastCopyAttemptDebug = undefined;
      this.lastHtmlAttemptDebug = undefined;

      const preferredText = await this.tryExtractPreferredResponseText(page, provider, candidate);
      if (preferredText?.text) {
        texts.push(preferredText.text);
        continue;
      }

      const text = this.normalizeExtractedMarkdown((await candidate.innerText()).trim());
      if (text) {
        texts.push(text);
      }
    }

    return texts;
  }

  private async finalizeStableResponseTexts(
    page: Page,
    provider: ProviderConfig,
    selector: string | undefined,
    previousCount: number,
    fallbackTexts: string[],
  ): Promise<string[]> {
    if (!selector) {
      return fallbackTexts;
    }

    const locator = page.locator(selector);
    const count = await locator.count();
    const texts: string[] = [];

    for (let index = previousCount; index < count; index += 1) {
      this.lastCopyAttemptDebug = undefined;
      this.lastHtmlAttemptDebug = undefined;
      const candidate = locator.nth(index);
      const preferredText = await this.tryExtractPreferredResponseText(page, provider, candidate);
      if (preferredText) {
        texts.push(preferredText.text);
        this.extractionDebugItems.push({
          index: texts.length - 1,
          method: preferredText.method,
          detail: preferredText.detail,
          preview: preferredText.text.slice(0, 180),
        });
        continue;
      }

      const fallbackIndex = index - previousCount;
      const fallbackText = fallbackTexts[fallbackIndex] ?? (await candidate.innerText()).trim();
      if (fallbackText) {
        const normalizedFallbackText = this.normalizeExtractedMarkdown(fallbackText);
        texts.push(normalizedFallbackText);
        this.extractionDebugItems.push({
          index: texts.length - 1,
          method: 'innerText',
          detail: `html: ${this.lastHtmlAttemptDebug ?? '未尝试'}; 使用 innerText 兜底`,
          preview: normalizedFallbackText.slice(0, 180),
        });
      }
    }

    return texts.length > 0 ? texts : fallbackTexts;
  }

  private async tryExtractPreferredResponseText(
    page: Page,
    provider: ProviderConfig,
    responseNode: Locator,
  ): Promise<{ text: string; method: 'copy' | 'html'; detail?: string } | null> {
    const renderedMarkdown = await this.tryExtractRenderedMarkdown(responseNode);

    if (renderedMarkdown) {
      return renderedMarkdown;
    }

    return null;
  }

  private async tryExtractRenderedMarkdown(
    responseNode: Locator,
  ): Promise<{ text: string; method: 'html'; detail?: string } | null> {
    try {
      const extractionPageFunction = Function(
        `return (${extractRenderedMarkdownPayload.toString()});`,
      )() as (node: HTMLElement, providerId: string) => ExtractedRenderedMarkdownPayload;
      const extraction = await responseNode.evaluate(extractionPageFunction, this.providerId);
      const html = extraction.html;
      const fallbackText = this.normalizeExtractedMarkdown(extraction.text || '');

      if (!html.trim()) {
        this.lastHtmlAttemptDebug = '回复节点 innerHTML 为空';
        if (fallbackText) {
          return {
            text: fallbackText,
            method: 'html',
            detail: 'HTML 为空，回退为内容根节点 innerText',
          };
        }
        return null;
      }

      let serialized = turndownService
        .turndown(`<div>${html}</div>`)
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      serialized = restoreMarkdownTokenPayloads(serialized, extraction.qwenTablePayloads);
      serialized = restoreMarkdownTokenPayloads(serialized, extraction.mathPayloads, {
        padIsolatedToken: (payload) => payload.display === 'block',
      });
      serialized = restoreMarkdownTokenPayloads(serialized, extraction.codeBlockPayloads);

      const normalized = this.normalizeExtractedMarkdown(serialized);
      if (this.isSuspiciousHtmlExtraction(html, normalized)) {
        if (fallbackText) {
          this.lastHtmlAttemptDebug = `HTML 长度 ${html.length}，检测到页面污染或原样 HTML，回退为内容根节点 innerText`;
          return {
            text: fallbackText,
            method: 'html',
            detail: this.lastHtmlAttemptDebug,
          };
        }
        this.lastHtmlAttemptDebug = `HTML 长度 ${html.length}，检测到页面污染或原样 HTML`;
        return null;
      }

      if (!normalized) {
        this.lastHtmlAttemptDebug = `HTML 长度 ${html.length}，转 Markdown 后为空`;
        if (fallbackText) {
          return {
            text: fallbackText,
            method: 'html',
            detail: `${this.lastHtmlAttemptDebug}，回退为内容根节点 innerText`,
          };
        }
        return null;
      }

      this.lastHtmlAttemptDebug = [
        `HTML 长度 ${html.length}，成功走 HTML -> Markdown`,
        Array.isArray(extraction.qwenTablePayloads) && extraction.qwenTablePayloads.length > 0
          ? '保留 Qwen 表格正文混排'
          : '',
        Array.isArray(extraction.mathPayloads) && extraction.mathPayloads.length > 0
          ? `重建 ${extraction.mathPayloads.length} 个公式`
          : '',
        Array.isArray(extraction.codeBlockPayloads) && extraction.codeBlockPayloads.length > 0
          ? `重建 ${extraction.codeBlockPayloads.length} 个代码块`
          : '',
      ]
        .filter(Boolean)
        .join('，');

      return {
        text: normalized,
        method: 'html',
        detail: this.lastCopyAttemptDebug
          ? `copy 未命中: ${this.lastCopyAttemptDebug}; ${this.lastHtmlAttemptDebug}`
          : this.lastHtmlAttemptDebug,
      };
    } catch (error) {
      this.lastHtmlAttemptDebug = `读取或转换 HTML 失败: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  private isSuspiciousHtmlExtraction(html: string, normalizedMarkdown: string): boolean {
    const normalizedHtml = html.toLowerCase();
    const normalizedText = normalizedMarkdown.toLowerCase();

    if (!normalizedText) {
      return false;
    }

    const htmlTagMatches = normalizedMarkdown.match(/<[^>]+>/gu)?.length ?? 0;
    if (htmlTagMatches >= 3) {
      return true;
    }

    const genericMarkers = [
      'textarea',
      'contenteditable',
      'input-area',
      'composer',
      'history-list',
      'chat-history',
      'rich-textarea',
      'ql-editor',
    ];
    if (genericMarkers.some((marker) => normalizedHtml.includes(marker))) {
      return true;
    }

    if (this.providerId === 'gemini') {
      const geminiMarkers = [
        '_ngcontent-',
        'model-response-message-content',
        'markdown-main-panel',
      ];
      const geminiUiHints = ['为 gemini 输入提示', 'send message', 'google gemini'];

      if (geminiMarkers.some((marker) => normalizedText.includes(marker))) {
        return true;
      }

      if (geminiUiHints.some((hint) => normalizedText.includes(hint))) {
        return true;
      }
    }

    return false;
  }

  private normalizeExtractedMarkdown(text: string): string {
    let normalized = this.removeUiArtifactLines(
      this.stripInvisibleControlChars(text).replace(/\r\n/g, '\n').trim(),
    );

    const codeBlocks: string[] = [];
    normalized = normalized.replace(/```[\s\S]*?```/gu, (match) => {
      const token = `BRIDGECODEBLOCKTOKEN${codeBlocks.length}END`;
      codeBlocks.push(match);
      return token;
    });

    normalized = this.convertTabularTextToMarkdownTable(normalized);
    if (this.providerId === 'qwen') {
      normalized = this.normalizeQwenMarkdownTables(normalized);
    }
    const pipeCount = normalized.match(/\|/g)?.length ?? 0;

    if (pipeCount >= 6 && normalized.includes('| ---') && !normalized.includes('\n|')) {
      normalized = normalized.replace(/\|\s+\|/g, '|\n|');
      const firstPipeIndex = normalized.indexOf('|');
      const existingTextBeforeTable =
        firstPipeIndex > 0 ? normalized.slice(0, firstPipeIndex).trimEnd() : '';
      if (firstPipeIndex > 0 && existingTextBeforeTable) {
        const beforeTable = normalized.slice(0, firstPipeIndex).trimEnd();
        const table = normalized.slice(firstPipeIndex).trimStart();
        normalized = `${beforeTable}\n\n${table}`.trim();
      }
    }

    codeBlocks.forEach((block, index) => {
      normalized = normalized.replace(`BRIDGECODEBLOCKTOKEN${index}END`, block);
    });

    return normalized.replace(/\n{3,}/g, '\n\n').trim();
  }

  private normalizeQwenMarkdownTables(text: string): string {
    let normalized = text;

    const hasStructuredMultilineTable =
      /(?:^|\n)\|[^\n]+\n\|\s*:?-{3,}/u.test(normalized) &&
      (normalized.match(/\n\|/gu)?.length ?? 0) >= 2;

    if (hasStructuredMultilineTable) {
      return normalized
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    for (let index = 0; index < 4; index += 1) {
      const next = normalized
        .replace(/\|\s*\n(?!\s*\|\s*[-:])/gu, '| ')
        .replace(/\n\s*\|(?!(?:\s*[-:]))/gu, ' |')
        .replace(/\|\s{2,}/gu, '| ')
        .replace(/\s{2,}\|/gu, ' |');

      if (next === normalized) {
        break;
      }
      normalized = next;
    }

    normalized = this.normalizeInlineMarkdownTableRows(normalized);

    return normalized.replace(/\n{3,}/g, '\n\n').trim();
  }

  private normalizeInlineMarkdownTableRows(text: string): string {
    const lines = text.split('\n');
    const normalizedLines: string[] = [];

    for (const line of lines) {
      const dividerMatch = line.match(/^(\|\s*(?::?-{3,}:?\s*\|)+)(.*)$/u);
      if (!dividerMatch) {
        normalizedLines.push(line);
        continue;
      }

      const divider = dividerMatch[1].trimEnd();
      const trailing = dividerMatch[2].trim();
      if (!trailing.startsWith('|')) {
        normalizedLines.push(line);
        continue;
      }

      const columnCount = divider
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean).length;
      const cells = Array.from(trailing.matchAll(/\|\s*([^|]+?)\s*(?=\|)/gu)).map((match) =>
        match[1].trim(),
      );
      if (columnCount < 2 || cells.length < columnCount || cells.length % columnCount !== 0) {
        normalizedLines.push(line);
        continue;
      }

      normalizedLines.push(divider);
      for (let index = 0; index < cells.length; index += columnCount) {
        normalizedLines.push(`| ${cells.slice(index, index + columnCount).join(' | ')} |`);
      }
    }

    return normalizedLines.join('\n').trim();
  }

  private async tryExtractCopiedResponseText(
    page: Page,
    provider: ProviderConfig,
    responseNode: Locator,
  ): Promise<{ text: string; method: 'copy'; detail?: string } | null> {
    const clipboardState = await this.snapshotClipboard(page);
    const responseText = await responseNode.innerText().catch(() => '');

    try {
      await this.installClipboardCapture(page).catch(() => undefined);
      await this.hoverResponseForCopy(page, responseNode).catch(() => undefined);
      const responseBox = await responseNode.boundingBox().catch(() => null);
      if (responseBox) {
        const rightX = Math.max(
          responseBox.x + Math.min(responseBox.width - 8, Math.max(8, responseBox.width * 0.92)),
          responseBox.x + 8,
        );
        const topY = Math.max(
          responseBox.y + 10,
          responseBox.y + Math.min(20, Math.max(8, responseBox.height * 0.08)),
        );
        const bottomY = Math.max(
          responseBox.y + 10,
          responseBox.y + Math.min(responseBox.height - 8, Math.max(12, responseBox.height * 0.92)),
        );
        await page.mouse.move(rightX, topY).catch(() => undefined);
        await page.waitForTimeout(80);
        await page.mouse.move(rightX, bottomY).catch(() => undefined);
      }
      await page.waitForTimeout(120);

      const candidateIds = await this.markCopyButtonCandidates(page, responseNode, provider);
      if (candidateIds.length === 0) {
        this.lastCopyAttemptDebug = 'hover 后未发现明确的复制控件';
      } else {
        this.lastCopyAttemptDebug = `找到 ${candidateIds.length} 个复制候选，开始逐个尝试`;
      }
      for (const candidateId of candidateIds) {
        const requireCopyHint =
          this.providerId === 'deepseek' ||
          (await this.copyCandidateRequiresHoverHint(page, candidateId));
        if (requireCopyHint) {
          const hasCopyHint = await this.hoverShowsCopyHint(page, candidateId);
          if (!hasCopyHint) {
            this.lastCopyAttemptDebug = `复制候选 #${candidateId} hover 未出现复制提示`;
            continue;
          }
        }

        const previousClipboardText = await this.readClipboardText(page).catch(
          () => clipboardState.currentText ?? '',
        );
        const previousCapturedText = await this.readCapturedClipboardText(page).catch(() => '');
        const copyClicked = await this.clickMarkedCopyButton(page, candidateId);
        if (!copyClicked) {
          this.lastCopyAttemptDebug = `复制候选 #${candidateId} 点击失败`;
          continue;
        }

        const copiedText = await this.waitForCopiedText(
          page,
          previousClipboardText,
          previousCapturedText,
        );
        if (!copiedText || !this.isCopiedTextLikelyFromResponse(copiedText, responseText)) {
          if (this.providerId === 'qwen') {
            const qwenCopyPayloads = await this.readQwenCopyPayloadCandidates(
              page,
              candidateId,
            ).catch(() => [] as string[]);
            const matchedPayload = this.selectBestQwenCopyPayload(qwenCopyPayloads, responseText);
            if (matchedPayload) {
              const normalizedQwenPayload = this.normalizeCopiedMarkdown(matchedPayload);
              if (normalizedQwenPayload) {
                this.lastCopyAttemptDebug = `命中复制候选 #${candidateId}，通过 Qwen copy 组件数据提取`;
                return {
                  text: normalizedQwenPayload,
                  method: 'copy',
                  detail: this.lastCopyAttemptDebug,
                };
              }
            }
          }

          const preview = (copiedText || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '<empty>';
          this.lastCopyAttemptDebug = `复制候选 #${candidateId} 剪贴板未命中当前回复（clipboard=${preview}）`;
          continue;
        }

        const normalizedCopiedText = this.normalizeCopiedMarkdown(copiedText);
        if (normalizedCopiedText) {
          this.lastCopyAttemptDebug = `命中复制候选 #${candidateId}，共尝试 ${candidateIds.length} 个候选`;
          return {
            text: normalizedCopiedText,
            method: 'copy',
            detail: this.lastCopyAttemptDebug,
          };
        }

        this.lastCopyAttemptDebug = `复制候选 #${candidateId} 命中剪贴板，但标准化后为空`;
      }

      if (!this.lastCopyAttemptDebug) {
        this.lastCopyAttemptDebug = `找到 ${candidateIds.length} 个复制候选，但都未命中`;
      }

      return null;
    } catch (error) {
      this.lastCopyAttemptDebug = `复制提取过程中抛出异常: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    } finally {
      await this.clearMarkedCopyButtons(page).catch(() => undefined);
      await this.restoreClipboard(page, clipboardState).catch(() => undefined);
    }
  }

  private selectBestQwenCopyPayload(payloads: string[], responseText: string): string | undefined {
    const matched = payloads.filter((payload) =>
      this.isCopiedTextLikelyFromResponse(payload, responseText),
    );
    if (matched.length === 0) {
      return undefined;
    }

    const responsePrefix = responseText.split('\n\n|').at(0)?.trim() || responseText.trim();
    const responseHasNarrative =
      /[。！？.!?]/u.test(responsePrefix) || /^[-*+]\s+/mu.test(responseText);

    const scored = matched
      .map((payload) => {
        const normalizedPayload = this.normalizeComparableText(payload);
        const prefix = payload.split('\n\n|').at(0)?.trim() || payload.trim();
        const hasNarrative = /[。！？.!?]/u.test(prefix) || /^[-*+]\s+/mu.test(payload);
        const hasTable = payload.includes('|');
        let score = normalizedPayload.length;

        if (hasTable) {
          score += 80;
        }
        if (hasNarrative) {
          score += 160;
        }
        if (responseHasNarrative && !hasNarrative) {
          score -= 240;
        }

        return { payload, score };
      })
      .sort((left, right) => right.score - left.score);

    return scored[0]?.payload;
  }

  private async markCopyButtonCandidates(
    page: Page,
    responseNode: Locator,
    provider: ProviderConfig,
  ): Promise<string[]> {
    const responseBox = await responseNode.boundingBox().catch(() => null);
    if (!responseBox) {
      return [];
    }

    await this.clearMarkedCopyButtons(page).catch(() => undefined);

    const selectors = provider.copyButtonSelectors ?? [
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
    ];
    return responseNode
      .evaluate(
        (
          node,
          args: {
            selectorList: string[];
            useGenericActionRowFallback: boolean;
            providerId: string;
          },
        ) => {
          const { selectorList, useGenericActionRowFallback, providerId } = args;
          const responseElement = node as HTMLElement;
          const responseRect = responseElement.getBoundingClientRect();
          const roots: HTMLElement[] = [];
          let current: HTMLElement | null = responseElement;
          for (let depth = 0; current && depth < 5; depth += 1) {
            roots.push(current);
            current = current.parentElement;
          }
          if (!roots.includes(document.body)) {
            roots.push(document.body);
          }

          const unique = new Set<HTMLElement>();
          const candidates: Array<{ element: HTMLElement; score: number; y: number }> = [];
          const negativeHints = [
            'code',
            'snippet',
            '代码',
            'share',
            '分享',
            'thumb',
            'like',
            'dislike',
            '深度思考',
            '智能搜索',
            'send',
            '发送',
            '重试',
            '重写',
            '重新生成',
          ];

          for (const root of roots) {
            const elements = root.querySelectorAll<HTMLElement>(
              '[role="button"], button, [title], [aria-label], [data-testid], [role="tooltip"], div, span',
            );
            for (const rawElement of elements) {
              const element =
                rawElement.closest<HTMLElement>(
                  'button, [role="button"], [title], [aria-label], [data-testid]',
                ) || rawElement;
              if (unique.has(element)) {
                continue;
              }
              unique.add(element);

              if (responseElement.contains(element) || element.contains(responseElement)) {
                continue;
              }
              if (element.closest('form, [class*="composer"], [class*="input"]')) {
                continue;
              }

              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                rect.width < 10 ||
                rect.height < 10
              ) {
                continue;
              }
              if (rect.width > 88 || rect.height > 88) {
                continue;
              }

              const joined = [
                element.innerText || '',
                element.textContent || '',
                element.getAttribute('aria-label') || '',
                element.getAttribute('title') || '',
                element.getAttribute('data-testid') || '',
                element.getAttribute('data-icon') || '',
                element.getAttribute('name') || '',
                typeof element.className === 'string' ? element.className : '',
                Array.from(element.querySelectorAll('svg, use, title'))
                  .map((child) =>
                    [
                      child.getAttribute('data-icon') || '',
                      child.getAttribute('href') || '',
                      child.getAttribute('xlink:href') || '',
                      child.getAttribute('aria-label') || '',
                      child.textContent || '',
                      typeof (child as HTMLElement).className === 'string'
                        ? (child as HTMLElement).className
                        : '',
                    ].join(' '),
                  )
                  .join(' '),
              ]
                .join(' ')
                .toLowerCase();
              if (negativeHints.some((hint) => joined.includes(hint))) {
                continue;
              }

              const matchesSelector = selectorList.some((selector: string) => {
                try {
                  return element.matches(selector);
                } catch {
                  return false;
                }
              });
              const hasCopyHint =
                joined.includes('copy') ||
                joined.includes('复制') ||
                joined.includes('clipboard') ||
                joined.includes('拷贝');
              const explicitCopyText = (element.innerText || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
              const hasExplicitCopyLabel =
                explicitCopyText === '复制' ||
                explicitCopyText === 'copy' ||
                explicitCopyText.includes('复制') ||
                explicitCopyText.includes('copy');
              const hasTooltipCopyLabel =
                (element.getAttribute('role') || '') === 'tooltip' && hasExplicitCopyLabel;

              const verticalGap =
                rect.top > responseRect.bottom
                  ? rect.top - responseRect.bottom
                  : responseRect.top > rect.bottom
                    ? responseRect.top - rect.bottom
                    : 0;
              const horizontalGap =
                rect.left > responseRect.right
                  ? rect.left - responseRect.right
                  : responseRect.left > rect.right
                    ? responseRect.left - rect.right
                    : 0;
              const isNearResponse =
                rect.top >= responseRect.top - 36 &&
                rect.top <= responseRect.bottom + 240 &&
                rect.left >= responseRect.left - 120 &&
                rect.left <= responseRect.right + 180;

              if (!isNearResponse) {
                continue;
              }
              if (
                !matchesSelector &&
                !hasCopyHint &&
                !hasExplicitCopyLabel &&
                !hasTooltipCopyLabel
              ) {
                continue;
              }

              let score = 20;
              if (matchesSelector) {
                score += 50;
              }
              if (hasCopyHint) {
                score += 28;
              }
              if (hasExplicitCopyLabel) {
                score += 40;
              }
              if (hasTooltipCopyLabel) {
                score += 24;
              }
              if (verticalGap <= 48) {
                score += 24;
              } else if (verticalGap <= 120) {
                score += 14;
              } else {
                score -= Math.min(30, Math.floor(verticalGap / 8));
              }
              if (horizontalGap <= 32) {
                score += 18;
              } else if (horizontalGap <= 120) {
                score += 10;
              } else {
                score -= Math.min(20, Math.floor(horizontalGap / 12));
              }
              if (rect.left >= responseRect.right - 64) {
                score += 14;
              }

              candidates.push({ element, score, y: rect.top });
            }
          }

          candidates.sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }
            return right.y - left.y;
          });

          if (candidates.length === 0 && useGenericActionRowFallback) {
            const iconButtons = Array.from(
              document.querySelectorAll<HTMLElement>(
                'button, [role="button"], [title], [aria-label], [data-testid], div, span',
              ),
            )
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                const className =
                  typeof element.className === 'string' ? element.className.toLowerCase() : '';
                const style = window.getComputedStyle(element);
                return (
                  rect.width >= 18 &&
                  rect.width <= 56 &&
                  rect.height >= 18 &&
                  rect.height <= 56 &&
                  rect.top >= responseRect.bottom - 12 &&
                  rect.top <= responseRect.bottom + 110 &&
                  rect.left >= responseRect.left - 40 &&
                  rect.left <= responseRect.right + 160 &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  !element.closest('form, [class*="composer"], [class*="input"]') &&
                  !negativeHints.some((hint) => className.includes(hint))
                );
              })
              .map((element) => ({
                element,
                rect: element.getBoundingClientRect(),
              }))
              .sort((left, right) => {
                if (Math.abs(left.rect.top - right.rect.top) > 6) {
                  return left.rect.top - right.rect.top;
                }
                return left.rect.left - right.rect.left;
              });

            if (iconButtons.length >= 2) {
              const rowGroups: Array<Array<{ element: HTMLElement; rect: DOMRect }>> = [];
              for (const item of iconButtons) {
                const row = rowGroups.find(
                  (group) => Math.abs(group[0].rect.top - item.rect.top) <= 6,
                );
                if (row) {
                  row.push(item);
                } else {
                  rowGroups.push([item]);
                }
              }

              const sameRow =
                rowGroups
                  .sort((left, right) => right.length - left.length)[0]
                  ?.sort((left, right) => left.rect.left - right.rect.left) ?? [];

              if (sameRow.length >= 2) {
                const fallbackKind =
                  providerId === 'deepseek' ? 'deepseek-action-row' : 'generic-action-row';
                return sameRow.slice(0, 6).map((item, index) => {
                  item.element.setAttribute('data-bridge-copy-candidate', String(index));
                  item.element.setAttribute('data-bridge-copy-fallback', fallbackKind);
                  return String(index);
                });
              }
            }
          }

          return candidates.slice(0, 6).map((candidate, index) => {
            candidate.element.setAttribute('data-bridge-copy-candidate', String(index));
            return String(index);
          });
        },
        { selectorList: selectors, useGenericActionRowFallback: true, providerId: this.providerId },
      )
      .catch(() => [] as string[]);
  }

  private async hoverResponseForCopy(page: Page, responseNode: Locator): Promise<void> {
    if (this.providerId === 'qwen') {
      const containers = [
        responseNode
          .locator('xpath=ancestor-or-self::*[contains(@class,"chat-response-message")][1]')
          .first(),
        responseNode
          .locator('xpath=ancestor-or-self::*[contains(@class,"chat-response-message-right")][1]')
          .first(),
        responseNode
          .locator('xpath=ancestor-or-self::*[contains(@class,"response-message-content")][1]')
          .first(),
      ];

      for (const container of containers) {
        if ((await container.count().catch(() => 0)) === 0) {
          continue;
        }

        await container.scrollIntoViewIfNeeded().catch(() => undefined);
        await container.hover({ timeout: 1500 }).catch(() => undefined);
        await page.waitForTimeout(180);
      }

      await responseNode.scrollIntoViewIfNeeded().catch(() => undefined);
      await responseNode.hover({ timeout: 1500 }).catch(() => undefined);
      await page.waitForTimeout(180);
      return;
    }

    await responseNode.scrollIntoViewIfNeeded().catch(() => undefined);
    await responseNode.hover({ timeout: 2000 }).catch(() => undefined);
  }

  private async copyCandidateRequiresHoverHint(page: Page, candidateId: string): Promise<boolean> {
    return page
      .locator(`[data-bridge-copy-candidate="${candidateId}"]`)
      .evaluate((node) => {
        const fallback = (node as HTMLElement).getAttribute('data-bridge-copy-fallback');
        return Boolean(fallback);
      })
      .catch(() => false);
  }

  private async clickMarkedCopyButton(page: Page, candidateId: string): Promise<boolean> {
    const locator = page.locator(`[data-bridge-copy-candidate="${candidateId}"]`).first();
    if ((await locator.count().catch(() => 0)) === 0) {
      return false;
    }

    try {
      await locator.hover({ timeout: 1500 }).catch(() => undefined);
      await locator.click({ timeout: 1500, force: true }).catch(() => undefined);
      await page.waitForTimeout(80);

      if (this.providerId === 'qwen') {
        await locator
          .evaluate((node) => {
            const target = (node as HTMLElement).closest(
              '.qwen-chat-package-comp-new-action-control-container-copy',
            ) as HTMLElement | null;
            target?.click();
          })
          .catch(() => undefined);
        await page.waitForTimeout(120);

        await locator
          .evaluate((node) => {
            const target = (node as HTMLElement).closest(
              '.qwen-chat-package-comp-new-action-control-container-copy',
            ) as HTMLElement | null;
            if (!target) {
              return;
            }

            const elements = [target, ...Array.from(target.querySelectorAll<HTMLElement>('*'))];
            for (const element of elements) {
              const reactPropsKey = Object.keys(element).find((key) =>
                key.startsWith('__reactProps$'),
              ) as keyof typeof element | undefined;
              if (!reactPropsKey) {
                continue;
              }

              const reactProps = element[reactPropsKey] as
                | {
                    onClick?: (event: {
                      preventDefault(): void;
                      stopPropagation(): void;
                      currentTarget: HTMLElement;
                      target: HTMLElement;
                      nativeEvent: MouseEvent;
                    }) => void;
                  }
                | undefined;
              if (typeof reactProps?.onClick !== 'function') {
                continue;
              }

              reactProps.onClick({
                preventDefault() {},
                stopPropagation() {},
                currentTarget: element,
                target: element,
                nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true }),
              });
              break;
            }
          })
          .catch(() => undefined);
        await page.waitForTimeout(120);
      }

      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
        await page.waitForTimeout(50);
        await page.mouse
          .click(box.x + box.width / 2, box.y + box.height / 2)
          .catch(() => undefined);
      } else {
        await locator.click({ timeout: 1500 }).catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async clearMarkedCopyButtons(page: Page): Promise<void> {
    await page.evaluate(() => {
      document.querySelectorAll('[data-bridge-copy-candidate]').forEach((element) => {
        element.removeAttribute('data-bridge-copy-candidate');
        element.removeAttribute('data-bridge-copy-fallback');
      });
    });
  }

  private async tryExtractSelectionCopiedResponseText(
    page: Page,
    responseNode: Locator,
  ): Promise<{ text: string; method: 'copy'; detail?: string } | null> {
    const clipboardState = await this.snapshotClipboard(page);
    const responseText = await responseNode.innerText().catch(() => '');

    try {
      return await this.tryCopySelectedResponseText(
        page,
        responseNode,
        responseText,
        clipboardState.currentText,
      );
    } finally {
      await this.restoreClipboard(page, clipboardState).catch(() => undefined);
    }
  }

  private async tryCopySelectedResponseText(
    page: Page,
    responseNode: Locator,
    responseText: string,
    previousClipboardText?: string,
  ): Promise<{ text: string; method: 'copy'; detail?: string } | null> {
    try {
      await responseNode.scrollIntoViewIfNeeded().catch(() => undefined);
      await responseNode.evaluate((node) => {
        const selection = window.getSelection();
        if (!selection) {
          return;
        }

        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.waitForTimeout(60);
      await page.keyboard.press('ControlOrMeta+C').catch(() => undefined);

      const copiedText = await this.waitForClipboardText(page, previousClipboardText);
      await page.evaluate(() => window.getSelection()?.removeAllRanges()).catch(() => undefined);

      if (!copiedText || !this.isCopiedTextLikelyFromResponse(copiedText, responseText)) {
        const preview = (copiedText || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '<empty>';
        this.lastCopyAttemptDebug = this.lastCopyAttemptDebug
          ? `${this.lastCopyAttemptDebug}; 选区复制未命中当前回复（clipboard=${preview}）`
          : `选区复制未命中当前回复（clipboard=${preview}）`;
        return null;
      }

      const normalizedCopiedText = this.normalizeCopiedMarkdown(copiedText);
      if (!normalizedCopiedText) {
        this.lastCopyAttemptDebug = this.lastCopyAttemptDebug
          ? `${this.lastCopyAttemptDebug}; 选区复制命中剪贴板，但标准化后为空`
          : '选区复制命中剪贴板，但标准化后为空';
        return null;
      }

      this.lastCopyAttemptDebug = this.lastCopyAttemptDebug
        ? `${this.lastCopyAttemptDebug}; 命中选区复制兜底`
        : '命中选区复制兜底';
      return {
        text: normalizedCopiedText,
        method: 'copy',
        detail: this.lastCopyAttemptDebug,
      };
    } catch (error) {
      this.lastCopyAttemptDebug = this.lastCopyAttemptDebug
        ? `${this.lastCopyAttemptDebug}; 选区复制失败: ${error instanceof Error ? error.message : String(error)}`
        : `选区复制失败: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  private async hoverShowsCopyHint(page: Page, candidateId: string): Promise<boolean> {
    const locator = page.locator(`[data-bridge-copy-candidate="${candidateId}"]`).first();
    if ((await locator.count().catch(() => 0)) === 0) {
      return false;
    }

    await locator.hover({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(120);
    const box = await locator.boundingBox().catch(() => null);
    if (!box) {
      return false;
    }

    return page
      .evaluate((targetBox) => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>('body *'));
        return elements.some((element) => {
          const text = (element.innerText || element.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          if (!text || text.length > 16) {
            return false;
          }
          if (
            !(
              text === '复制' ||
              text === 'copy' ||
              text.includes('复制') ||
              text.includes('copy') ||
              text.includes('拷贝')
            )
          ) {
            return false;
          }

          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            rect.width === 0 ||
            rect.height === 0
          ) {
            return false;
          }

          return (
            rect.top >= targetBox.y - 40 &&
            rect.top <= targetBox.y + targetBox.height + 80 &&
            rect.left >= targetBox.x - 100 &&
            rect.left <= targetBox.x + targetBox.width + 140
          );
        });
      }, box)
      .catch(() => false);
  }

  private async snapshotClipboard(page: Page): Promise<{ currentText?: string }> {
    const currentText = await this.readClipboardText(page).catch(() => undefined);
    return { currentText };
  }

  private async restoreClipboard(page: Page, snapshot: { currentText?: string }): Promise<void> {
    if (typeof snapshot.currentText !== 'string') {
      return;
    }

    await this.writeClipboardText(page, snapshot.currentText);
  }

  private async waitForClipboardText(page: Page, previousText?: string): Promise<string | null> {
    const startedAt = Date.now();
    let lastSeen = '';

    while (Date.now() - startedAt < 5000) {
      const currentText = await this.readClipboardText(page).catch(() => '');
      if (currentText) {
        lastSeen = currentText;
      }

      if (currentText && currentText !== previousText) {
        return currentText;
      }

      await page.waitForTimeout(120);
    }

    return lastSeen || null;
  }

  private async waitForCopiedText(
    page: Page,
    previousClipboardText?: string,
    previousCapturedText?: string,
  ): Promise<string | null> {
    const startedAt = Date.now();
    let lastSeen = '';

    while (Date.now() - startedAt < 5000) {
      const capturedText = await this.readCapturedClipboardText(page).catch(() => '');
      if (capturedText) {
        lastSeen = capturedText;
      }
      if (capturedText && capturedText !== previousCapturedText) {
        return capturedText;
      }

      const clipboardText = await this.readClipboardText(page).catch(() => '');
      if (clipboardText) {
        lastSeen = clipboardText;
      }
      if (clipboardText && clipboardText !== previousClipboardText) {
        return clipboardText;
      }

      await page.waitForTimeout(120);
    }

    return lastSeen || null;
  }

  private async readClipboardText(page: Page): Promise<string> {
    await this.ensureClipboardPermissions(page);
    return page.evaluate(async () => {
      let directText = '';
      try {
        directText = await navigator.clipboard.readText();
      } catch {
        // clipboard unavailable; directText stays ''
      }
      if (directText) {
        return directText;
      }

      const clipboard = navigator.clipboard as Clipboard & {
        read?: () => Promise<ClipboardItem[]>;
      };
      if (typeof clipboard.read !== 'function') {
        return '';
      }

      try {
        const items = await clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type !== 'text/plain' && type !== 'text/html') {
              continue;
            }
            const blob = await item.getType(type);
            const text = await blob.text();
            if (text.trim()) {
              return text;
            }
          }
        }
      } catch {
        return '';
      }

      return '';
    });
  }

  private async readCapturedClipboardText(page: Page): Promise<string> {
    return page.evaluate(() => {
      const capture = (
        window as typeof window & {
          __bridgeClipboardCapture?: { text?: string };
        }
      ).__bridgeClipboardCapture;
      return typeof capture?.text === 'string' ? capture.text : '';
    });
  }

  private async readQwenCopyPayloadCandidates(page: Page, candidateId: string): Promise<string[]> {
    const locator = page.locator(`[data-bridge-copy-candidate="${candidateId}"]`).first();
    if ((await locator.count().catch(() => 0)) === 0) {
      return [];
    }

    return locator.evaluate((node) => {
      const uniqueStrings = new Set<string>();
      const seenObjects = new WeakSet<object>();

      const elements: HTMLElement[] = [];
      let current: HTMLElement | null =
        ((node as HTMLElement).closest(
          '.qwen-chat-package-comp-new-action-control-container-copy',
        ) as HTMLElement | null) ?? (node as HTMLElement);
      for (let depth = 0; current && depth < 8; depth += 1) {
        elements.push(current);
        current = current.parentElement;
      }

      const queue: Array<{ value: unknown; depth: number }> = [];

      for (const element of elements) {
        for (const key of Object.keys(element)) {
          if (!key.startsWith('__reactProps$') && !key.startsWith('__reactFiber$')) {
            continue;
          }
          queue.push({ value: (element as unknown as Record<string, unknown>)[key], depth: 0 });
        }
      }

      while (queue.length > 0) {
        const currentItem = queue.shift();
        if (!currentItem) {
          continue;
        }

        const { value, depth } = currentItem;
        if (depth > 5 || value == null) {
          continue;
        }

        if (typeof value === 'string') {
          const trimmed = value.replace(/\r\n/g, '\n').trim();
          if (trimmed.length >= 24 && trimmed.length <= 24000) {
            uniqueStrings.add(trimmed);
          }
          continue;
        }

        if (typeof value === 'function' || typeof value !== 'object') {
          continue;
        }

        if (seenObjects.has(value as object)) {
          continue;
        }
        seenObjects.add(value as object);

        if (Array.isArray(value)) {
          for (const item of value.slice(0, 24)) {
            queue.push({ value: item, depth: depth + 1 });
          }
          continue;
        }

        for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
          if (
            typeof child === 'string' ||
            /text|content|value|markdown|message|answer|copy|source|children|html|plain|md/i.test(
              key,
            )
          ) {
            queue.push({ value: child, depth: depth + 1 });
          }
        }
      }

      return Array.from(uniqueStrings)
        .map((text) => ({
          text,
          score:
            (text.includes('|') ? 30 : 0) +
            (/^\s*[-*+]\s+/m.test(text) ? 16 : 0) +
            (text.includes('```') ? 8 : 0) +
            (text.includes('HTTP') ? 6 : 0) +
            (text.includes('HTTPS') ? 6 : 0) +
            Math.min(20, Math.floor(text.length / 200)),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 12)
        .map((item) => item.text);
    });
  }

  private async installClipboardCapture(page: Page): Promise<void> {
    await page.evaluate(() => {
      const bridgeWindow = window as typeof window & {
        __bridgeClipboardCaptureInstalled?: boolean;
        __bridgeClipboardCapture?: { text?: string; updatedAt?: number };
      };

      if (bridgeWindow.__bridgeClipboardCaptureInstalled) {
        return;
      }

      bridgeWindow.__bridgeClipboardCaptureInstalled = true;
      bridgeWindow.__bridgeClipboardCapture = bridgeWindow.__bridgeClipboardCapture ?? {};

      document.addEventListener(
        'copy',
        (event) => {
          const clipboardText =
            event.clipboardData?.getData('text/plain') || window.getSelection()?.toString() || '';
          if (typeof clipboardText === 'string' && clipboardText.trim()) {
            bridgeWindow.__bridgeClipboardCapture = {
              text: clipboardText,
              updatedAt: Date.now(),
            };
          }
        },
        true,
      );

      const clipboard = navigator.clipboard as Clipboard & {
        writeText?: (value: string) => Promise<void>;
      };
      if (clipboard && typeof clipboard.writeText === 'function') {
        const originalWriteText = clipboard.writeText.bind(clipboard);
        try {
          clipboard.writeText = async (value: string) => {
            if (typeof value === 'string' && value.trim()) {
              bridgeWindow.__bridgeClipboardCapture = {
                text: value,
                updatedAt: Date.now(),
              };
            }
            return originalWriteText(value);
          };
        } catch {
          // Ignore non-writable clipboard implementations.
        }
      }

      const clipboardWithWrite = navigator.clipboard as Clipboard & {
        write?: (data: ClipboardItems) => Promise<void>;
      };
      if (clipboardWithWrite && typeof clipboardWithWrite.write === 'function') {
        const originalWrite = clipboardWithWrite.write.bind(clipboardWithWrite);
        try {
          clipboardWithWrite.write = async (items: ClipboardItems) => {
            try {
              for (const item of items) {
                for (const type of item.types) {
                  if (type !== 'text/plain' && type !== 'text/html') {
                    continue;
                  }
                  const blob = await item.getType(type);
                  const text = await blob.text();
                  if (typeof text === 'string' && text.trim()) {
                    bridgeWindow.__bridgeClipboardCapture = {
                      text,
                      updatedAt: Date.now(),
                    };
                  }
                  if (text.trim()) {
                    break;
                  }
                }
              }
            } catch {
              // Ignore capture failures and fall back to original clipboard write.
            }
            return originalWrite(items);
          };
        } catch {
          // Ignore non-writable clipboard implementations.
        }
      }

      const originalExecCommand = document.execCommand?.bind(document);
      if (typeof originalExecCommand === 'function') {
        try {
          document.execCommand = ((commandId: string, showUI?: boolean, value?: string) => {
            if (String(commandId).toLowerCase() === 'copy') {
              const selectionText = window.getSelection()?.toString() || '';
              if (selectionText.trim()) {
                bridgeWindow.__bridgeClipboardCapture = {
                  text: selectionText,
                  updatedAt: Date.now(),
                };
              }
            }
            return originalExecCommand(commandId, showUI, value);
          }) as typeof document.execCommand;
        } catch {
          // Ignore non-overridable execCommand implementations.
        }
      }
    });
  }

  private async writeClipboardText(page: Page, value: string): Promise<void> {
    await this.ensureClipboardPermissions(page);
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, value);
  }

  private async ensureClipboardPermissions(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (!currentUrl) {
      return;
    }

    try {
      const origin = new URL(currentUrl).origin;
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    } catch {
      // Ignore permission failures and let clipboard reads fall back naturally.
    }
  }

  private normalizeCopiedMarkdown(text: string): string | null {
    const normalized = this.convertTabularTextToMarkdownTable(
      this.stripInvisibleControlChars(text).replace(/\r\n/g, '\n').trim(),
    );
    if (!normalized) {
      return null;
    }

    if (this.isSuspiciousHtmlExtraction(text, normalized)) {
      const strippedHtml = this.normalizeExtractedMarkdown(
        this.decodeBasicHtmlEntities(text).replace(/<[^>]+>/gu, ' '),
      );
      if (!strippedHtml || this.isSuspiciousHtmlExtraction(strippedHtml, strippedHtml)) {
        return null;
      }
      return strippedHtml;
    }

    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const looksLikeTabSeparatedTable =
      lines.length >= 2 &&
      lines.some((line) => line.includes('\t')) &&
      !lines.some((line) => line.includes('|'));
    if (looksLikeTabSeparatedTable) {
      return null;
    }

    return normalized;
  }

  private decodeBasicHtmlEntities(text: string): string {
    return text
      .replace(/&nbsp;/giu, ' ')
      .replace(/&quot;/giu, '"')
      .replace(/&#39;/giu, "'")
      .replace(/&lt;/giu, '<')
      .replace(/&gt;/giu, '>')
      .replace(/&amp;/giu, '&');
  }

  private stripInvisibleControlChars(text: string): string {
    /* eslint-disable no-control-regex, no-misleading-character-class */
    return text.replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200C\u200D\uFEFF]/g,
      '',
    );
    /* eslint-enable no-control-regex, no-misleading-character-class */
  }

  private isCopiedTextLikelyFromResponse(copiedText: string, responseText: string): boolean {
    const normalizedCopied = this.normalizeComparableText(copiedText);
    const normalizedResponse = this.normalizeComparableText(responseText);

    if (!normalizedCopied) {
      return false;
    }

    if (!normalizedResponse) {
      return true;
    }

    if (normalizedCopied === normalizedResponse) {
      return true;
    }

    if (
      normalizedResponse.length >= 120 &&
      normalizedCopied.length < normalizedResponse.length * 0.25
    ) {
      return false;
    }

    const copiedLines = copiedText
      .split('\n')
      .map((line) => this.normalizeComparableLine(line))
      .filter((line) => line.length >= 6);

    if (copiedLines.length === 0) {
      return (
        normalizedResponse.includes(normalizedCopied) ||
        normalizedCopied.includes(normalizedResponse)
      );
    }

    const matchedLines = copiedLines.filter((line) => normalizedResponse.includes(line)).length;
    const requiredMatches = Math.max(1, Math.min(3, Math.floor(copiedLines.length / 2)));
    const matchedRatio = copiedLines.length > 0 ? matchedLines / copiedLines.length : 0;
    const copiedPrefix = normalizedCopied.slice(0, Math.min(normalizedCopied.length, 72));
    const copiedSuffix = normalizedCopied.slice(Math.max(0, normalizedCopied.length - 72));

    return (
      matchedLines >= requiredMatches ||
      matchedRatio >= 0.35 ||
      (copiedPrefix.length >= 24 && normalizedResponse.includes(copiedPrefix)) ||
      (copiedSuffix.length >= 24 && normalizedResponse.includes(copiedSuffix)) ||
      normalizedResponse.includes(normalizedCopied.slice(0, Math.min(normalizedCopied.length, 80)))
    );
  }

  private normalizeComparableLine(text: string): string {
    return this.removeUiArtifactLines(text)
      .replace(/^\s{0,3}#{1,6}\s+/u, '')
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '')
      .replace(/[*_`~]/gu, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!|])/gu, '$1')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/^\s*\|/u, '')
      .replace(/\|\s*$/u, '')
      .replace(/:---+|---+:/gu, ' ')
      .replace(/\s*\|\s*/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLowerCase();
  }

  private convertTabularTextToMarkdownTable(text: string): string {
    const normalized = text.trim();
    if (!normalized || normalized.includes('|')) {
      return normalized;
    }

    const lines = normalized.split('\n');
    const converted: string[] = [];

    const flushTableBlock = (block: string[]) => {
      if (block.length < 2) {
        converted.push(...block);
        return;
      }

      const rows = block.map((line) => line.split('\t').map((cell) => cell.trim()));
      const columnCount = rows[0]?.length ?? 0;
      if (columnCount < 2 || !rows.every((row) => row.length === columnCount)) {
        converted.push(...block);
        return;
      }

      const header = `| ${rows[0].join(' | ')} |`;
      const divider = `| ${new Array(columnCount).fill('---').join(' | ')} |`;
      const body = rows.slice(1).map((row) => `| ${row.join(' | ')} |`);
      converted.push(header, divider, ...body);
    };

    let tableBlock: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const isTabularRow =
        line.includes('\t') && line.split('\t').filter((cell) => cell.trim()).length >= 2;
      if (isTabularRow) {
        tableBlock.push(line);
        continue;
      }

      if (tableBlock.length > 0) {
        flushTableBlock(tableBlock);
        tableBlock = [];
      }

      converted.push(line);
    }

    if (tableBlock.length > 0) {
      flushTableBlock(tableBlock);
    }

    return converted
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private extractChatResult(texts: string[]): { content: string; reasoningContent?: string } {
    const normalizedTexts = texts
      .filter(Boolean)
      .filter((text, index, array) => array.indexOf(text) === index);

    if (normalizedTexts.length === 0) {
      throw new Error(`未提取到 ${this.providerId} 的回复文本`);
    }

    if (normalizedTexts.length === 1) {
      return { content: this.normalizeProviderText(normalizedTexts[0]) };
    }

    return {
      content: this.normalizeProviderText(normalizedTexts[normalizedTexts.length - 1]),
      reasoningContent: normalizedTexts
        .slice(0, -1)
        .map((text) => this.normalizeProviderText(text))
        .join('\n\n'),
    };
  }

  private normalizeProviderText(text: string): string {
    if (this.providerId === 'deepseek') {
      return this.normalizeExtractedMarkdown(text);
    }

    if (this.providerId === 'qwen') {
      return this.normalizeExtractedMarkdown(
        text
          .replace(/^已经完成思考\s*/u, '')
          .replace(/(?:\n|^)跳过\s*$/u, '')
          .replace(/\n跳过(?=\n|$)/gu, '\n')
          .trim(),
      );
    }

    return text.trim();
  }

  private isPromptEcho(text: string, latestUserMessage: string, fullPrompt: string): boolean {
    const normalizedText = this.normalizeComparableText(text);
    if (!normalizedText) {
      return true;
    }

    const normalizedLatestUser = this.normalizeComparableText(latestUserMessage);
    const normalizedFullPrompt = this.normalizeComparableText(fullPrompt);

    if (normalizedText === normalizedLatestUser || normalizedText === normalizedFullPrompt) {
      return true;
    }

    if (
      this.providerId === 'grok' &&
      this.isStructuredPromptLeak(normalizedText, normalizedFullPrompt)
    ) {
      return true;
    }

    return false;
  }

  private isStructuredPromptLeak(normalizedText: string, normalizedFullPrompt: string): boolean {
    const lowerText = normalizedText.toLowerCase();
    const looksLikeStructuredPrompt =
      lowerText.includes('response rules:') &&
      lowerText.includes('history:') &&
      lowerText.includes('current request:');

    if (!looksLikeStructuredPrompt) {
      return false;
    }

    if (
      normalizedFullPrompt &&
      (lowerText.includes(normalizedFullPrompt.toLowerCase()) ||
        normalizedFullPrompt.toLowerCase().includes(lowerText))
    ) {
      return true;
    }

    return (
      lowerText.includes('- role=user') ||
      lowerText.includes('- role=assistant') ||
      lowerText.includes('speaker=')
    );
  }

  private filterMeaningfulResponseTexts(
    texts: string[],
    promptContext?: {
      latestUserMessage: string;
      fullPrompt: string;
    },
  ): string[] {
    return texts.filter((text) => {
      if (
        promptContext &&
        this.isPromptEcho(text, promptContext.latestUserMessage, promptContext.fullPrompt)
      ) {
        return false;
      }

      return !this.isProviderErrorText(text) && !this.isTransientProviderText(text);
    });
  }

  private isProviderErrorText(text: string): boolean {
    const normalizedText = this.normalizeComparableText(text).toLowerCase();
    if (!normalizedText) {
      return true;
    }

    const blockedPhrases = [
      '请求被用户中断',
      'request was interrupted by user',
      'request interrupted by user',
      '请求已取消',
      'request canceled',
      'request cancelled',
      '聊天流出错',
      '聊天流出错请重试',
      '聊天流出错，请重试',
      '出错了请重试',
      '出错了，请重试',
      '生成出错，请重试',
      '消息流中的错误',
      '消息流中的错误 重试',
      '消息流中的错误，重试',
      'message stream error',
      'error in the message stream',
      'something went wrong',
      '出了点问题',
      'network error',
      '网络错误',
      'internalerror.algo',
      'there are no suitable clusters',
      '连接到 qwen',
      '连接到 qwen3.5-plus 时出现问题',
      'model serving',
    ];

    return blockedPhrases.some((phrase) => normalizedText.includes(phrase));
  }

  private isTransientProviderText(text: string): boolean {
    const normalizedText = this.normalizeComparableText(text);
    if (!normalizedText) {
      return true;
    }

    if (this.providerId === 'qwen') {
      return /(?:^|\s)跳过\s*$/u.test(normalizedText);
    }

    return false;
  }

  private getFastFailTextHints(): string[] {
    if (this.providerId === 'grok') {
      return [
        'you have hit the limit',
        'you’ve hit the limit',
        'message limit',
        'rate limit',
        'too many messages',
        '达到消息上限',
        '消息上限',
        '稍后再试',
      ];
    }

    if (this.providerId === 'deepseek') {
      return ['服务器繁忙', '服务繁忙', '稍后再试', 'network error', '网络异常', '登录'];
    }

    if (this.providerId === 'chatgpt') {
      return [
        '消息流中的错误',
        '消息流中的错误 重试',
        'something went wrong',
        'network error',
        'choose a response',
      ];
    }

    if (this.providerId === 'gemini') {
      return ['network error', 'rate limit'];
    }

    if (this.providerId === 'claude') {
      return ['network error', 'something went wrong', 'rate limit'];
    }

    if (this.providerId === 'qwen') {
      return [
        '网络异常',
        '请稍后再试',
        '服务繁忙',
        '登录',
        'internalerror.algo',
        'there are no suitable clusters',
        'model serving',
        '连接到 qwen',
      ];
    }

    return [];
  }

  private normalizeComparableText(text: string): string {
    return this.removeUiArtifactLines(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
      .replace(/[*_`~]/gu, '')
      .replace(/\\([\\`*_{}[\]()#+\-.!|])/gu, '$1')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private removeUiArtifactLines(text: string): string {
    const artifactLinePatterns = [
      /^v$/iu,
      /^visualize$/iu,
      /^show[_\s-]?widget$/iu,
      /^visualize\s+show[_\s-]?widget$/iu,
    ];

    return text
      .split('\n')
      .filter((line) => {
        const normalized = line
          .replace(/[*_`~]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!normalized) {
          return true;
        }
        return !artifactLinePatterns.some((pattern) => pattern.test(normalized));
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Checks whether a .ds-markdown locator is inside a DeepSeek thinking container.
   * DeepSeek R1 nests the thinking-phase markdown inside a parent element whose
   * class contains "think" (e.g. "ds-thinking"), while the answer block does not.
   */
  private async isDeepSeekThinkingBlock(candidate: Locator): Promise<boolean> {
    return candidate
      .evaluate((node) => {
        let current: HTMLElement | null = node instanceof HTMLElement ? node : null;
        for (let depth = 0; current && depth < 8; depth += 1) {
          const className =
            typeof current.className === 'string' ? current.className.toLowerCase() : '';
          if (className.includes('think') || className.includes('reason')) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      })
      .catch(() => false);
  }

  /**
   * Returns true if at least one new .ds-markdown block (after previousCount)
   * is NOT inside a thinking container — i.e., an actual answer block exists.
   */
  private async deepSeekHasNonThinkingBlock(
    page: Page,
    selector: string,
    previousCount: number,
  ): Promise<boolean> {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = previousCount; index < count; index += 1) {
      const candidate = locator.nth(index);
      const isThinking = await this.isDeepSeekThinkingBlock(candidate);
      if (!isThinking) {
        return true;
      }
    }
    return false;
  }
}
