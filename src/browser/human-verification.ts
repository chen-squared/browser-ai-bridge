import type { Page } from 'playwright';

/**
 * 人机验证识别。
 *
 * 为什么单独一个模块：这类拦截**必须由人来点**，所以它和"普通失败"的处理完全不同——
 * 普通失败不该打扰用户（见 REVEAL_ON_ERROR，默认关闭），而验证一出现就必须立刻
 * 弹窗，否则请求会一直卡到超时，用户还不知道要做什么。
 *
 * 六家 provider 都可能弹，所以识别规则不绑定任何一家。
 *
 * 判定刻意做成"证据 + 短页面"双条件：光靠文案会误伤——一篇讲验证码的技术文章
 * 也会命中"安全验证"。所以要么有确凿的验证组件，要么页面几乎空白且出现验证话术。
 */

/** 确凿的验证组件：这些选择器只可能出现在验证页上。 */
const WIDGET_SELECTORS = [
  // Cloudflare Turnstile / 挑战页
  '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[title*="Cloudflare"]',
  '#cf-chl-widget',
  '#challenge-running',
  '#challenge-form',
  '.cf-challenge',
  '#turnstile-wrapper',
  // Google reCAPTCHA
  '.g-recaptcha',
  'iframe[src*="recaptcha"]',
  'iframe[title*="reCAPTCHA"]',
  '#recaptcha-anchor',
  // hCaptcha
  '.h-captcha',
  'iframe[src*="hcaptcha.com"]',
  // Arkose / 常见的人机校验
  '#arkose',
  '[id^="arkose"]',
  // PerimeterX / HUMAN 等
  'iframe[src*="perimeterx"]',
  'iframe[src*="px-captcha"]',
  '[class*="px-captcha"]',
  '#px-captcha',
];

/** URL 层面的强证据。 */
const URL_MARKERS = [
  '/cdn-cgi/challenge-platform/',
  '/cdn-cgi/l/chk',
  'challenges.cloudflare.com',
  '/_Incapsula_Resource',
  '/akam/',
  'geo.captcha-delivery.com',
];

/**
 * 验证页话术。分中英文，且覆盖"请证明你不是机器人"的各种说法。
 *
 * 只在页面很短时才算数，见 detectHumanVerification。
 */
const PHRASES = [
  '正在进行安全验证',
  '请验证您是真人',
  '请验证你是真人',
  '验证您是人类',
  '安全验证',
  '人机验证',
  '请完成验证',
  '请完成下方的验证',
  '请按提示操作',
  '滑动验证',
  '拖动滑块',
  '您的访问行为异常',
  'just a moment',
  'checking your browser',
  'verify you are human',
  "verify you're human",
  'are you a robot',
  'i am not a robot',
  "i'm not a robot",
  'confirm you are human',
  'please verify you are human',
  'enable javascript and cookies to continue',
  'press and hold',
  'unusual traffic',
  'attention required',
  'access denied',
  'checking the site connection security',
];

/** 页面文本短到这个程度，说明不是正常内容页而是拦截页。 */
const SHORT_PAGE_CHARS = 1200;

export type VerificationKind =
  | 'cloudflare-turnstile'
  | 'cloudflare-challenge'
  | 'recaptcha'
  | 'hcaptcha'
  | 'arkose'
  | 'generic';

export type VerificationDetection = {
  kind: VerificationKind;
  /** 给人看的说明，直接写进错误消息。 */
  reason: string;
  /** 命中的组件选择器或话术，便于排查。 */
  evidence: string;
  /** 是否需要人来点（人机验证一律需要）。 */
  needsHuman: true;
};

/** 由页面侧采集、交给纯函数判定，避免在这里依赖 Playwright。 */
export type PageSnapshot = {
  url: string;
  title: string;
  /** 页面正文的前若干字符。 */
  text: string;
  /** 整页正文长度——用来区分"拦截页"和"正常内容页"。 */
  totalTextLength: number;
  /** 命中的验证组件选择器。 */
  widgetMarkers: string[];
};

function kindFromMarkers(markers: string[]): VerificationKind | null {
  const joined = markers.join(' ').toLowerCase();
  if (joined.includes('turnstile') || joined.includes('challenges.cloudflare.com')) {
    return 'cloudflare-turnstile';
  }
  if (
    joined.includes('cf-challenge') ||
    joined.includes('challenge-form') ||
    joined.includes('cf-chl')
  ) {
    return 'cloudflare-challenge';
  }
  if (joined.includes('recaptcha')) {
    return 'recaptcha';
  }
  // hCaptcha 的**选择器**是 `.h-captcha`（带连字符），而域��是 hcaptcha.com。
  // 只查 'hcaptcha' 会漏掉前者——这正是实测会打中的那个。
  if (joined.includes('hcaptcha') || joined.includes('h-captcha')) {
    return 'hcaptcha';
  }
  if (joined.includes('arkose')) {
    return 'arkose';
  }
  return null;
}

function kindFromUrl(url: string): VerificationKind | null {
  const lower = url.toLowerCase();
  if (lower.includes('/cdn-cgi/challenge-platform/') || lower.includes('/cdn-cgi/l/chk')) {
    return 'cloudflare-turnstile';
  }
  if (lower.includes('challenges.cloudflare.com')) {
    return 'cloudflare-turnstile';
  }
  if (lower.includes('recaptcha')) {
    return 'recaptcha';
  }
  if (lower.includes('hcaptcha')) {
    return 'hcaptcha';
  }
  if (lower.includes('arkose') || lower.includes('_incapsula_resource')) {
    return 'arkose';
  }
  return null;
}

/** 把站内归一化后的文本压成小写空白串，便于子串匹配。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 判断页面是否停在人机验证上。
 *
 * 两条路：
 *   1. 有验证组件 → 直接判定（最强证据）
 *   2. URL 指向验证端点，或「页面很空 + 出现验证话术」
 *
 * 返回 null 表示不是验证页。
 */
export function detectHumanVerification(snapshot: PageSnapshot): VerificationDetection | null {
  const urlKind = kindFromUrl(snapshot.url);
  const widgetKind = kindFromMarkers(snapshot.widgetMarkers);

  if (widgetKind) {
    return {
      kind: widgetKind,
      reason: KIND_LABEL[widgetKind],
      evidence: snapshot.widgetMarkers.join(', '),
      needsHuman: true,
    };
  }

  if (urlKind) {
    return {
      kind: urlKind,
      reason: KIND_LABEL[urlKind],
      evidence: snapshot.url,
      needsHuman: true,
    };
  }

  // 没有组件证据时，要求页面足够空 —— 否则文章里提到"安全验证"也会误报
  const isShortPage = snapshot.totalTextLength <= SHORT_PAGE_CHARS;
  if (!isShortPage) {
    return null;
  }

  const haystack = normalize(`${snapshot.title} ${snapshot.text}`);
  const phrase = PHRASES.find((item) => haystack.includes(item));
  if (!phrase) {
    return null;
  }

  return {
    kind: 'generic',
    reason: KIND_LABEL.generic,
    evidence: phrase,
    needsHuman: true,
  };
}

/** 导出一份给页面侧 evaluate 用——必须与本模块的列表一致，不能各写一份。 */
export const WIDGET_SELECTORS_FOR_PAGE = WIDGET_SELECTORS;

/** 导出一份给页面侧 evaluate 用。 */
export const VERIFICATION_URL_MARKERS = URL_MARKERS;

const KIND_LABEL: Record<VerificationKind, string> = {
  'cloudflare-turnstile': '页面弹出了 Cloudflare 人机验证',
  'cloudflare-challenge': '页面弹出了 Cloudflare 安全挑战',
  recaptcha: '页面弹出了 Google reCAPTCHA 验证',
  hcaptcha: '页面弹出了 hCaptcha 验证',
  arkose: '页面弹出了 Arkose 人机校验',
  generic: '页面要求人机验证',
};

/** 给用户看的完整提示。措辞要明确"该你点了"，否则用户会以为服务坏了。 */
export function verificationMessage(provider: string, detection: VerificationDetection): string {
  return [
    `${provider} 停在人机验证页：${detection.reason}。`,
    '这类验证必须由你手动点击，程序无法代过——',
    '已把对应标签页切到前台，请点完验证后重新发起这次请求。',
    `（依据：${detection.evidence}）`,
  ].join('');
}

/** 给探测/诊断用的短标记，供日志与 API 返回。 */
export function verificationTag(detection: VerificationDetection | null): string {
  return detection ? `verification:${detection.kind}` : 'none';
}

/**
 * 采集页面快照。
 *
 * 只用一次性 `page.evaluate` 读取，**不注入任何常驻脚本**——与之前被否决的
 * `addInitScript` 劫持 fetch 不同，这里不修改页面环境，站点无从检测。
 */
async function readSnapshot(page: Page): Promise<PageSnapshot | null> {
  return page
    .evaluate((selectors) => {
      const widgetMarkers: string[] = [];
      for (const selector of selectors) {
        if (document.querySelector(selector)) {
          widgetMarkers.push(selector);
        }
      }
      const text = (document.body?.innerText || '').trim();
      return {
        url: location.href,
        title: document.title,
        text: text.slice(0, 2000),
        totalTextLength: text.length,
        widgetMarkers,
      };
    }, WIDGET_SELECTORS_FOR_PAGE)
    .catch(() => null);
}

/**
 * 判定一个真实页签是否停在人机验证上。
 *
 * 命中时**会把页签切到前台**：这类验证只能由人点，不弹出来用户根本不知道
 * 有事要做。这与 `REVEAL_ON_ERROR` 是两回事——普通失败不该打扰（实测在 macOS
 * 上会频繁抢前台），验证必须打扰。
 *
 * 同一页只弹一次：等待生成期间会反复检查，不去重的话用户刚点完验证，
 * 窗口又被抢回去。
 *
 * @param reveal 切前台的回调；不传就只判定不弹
 * @param alreadyRevealed 调用方持有的去重集合
 */
export async function detectHumanVerificationOnPage(
  page: Page,
  options: { reveal?: (page: Page) => Promise<void>; alreadyRevealed?: WeakSet<Page> } = {},
): Promise<VerificationDetection | null> {
  const snapshot = await readSnapshot(page);
  if (!snapshot) {
    return null;
  }

  const detection = detectHumanVerification(snapshot);
  if (detection && options.reveal && !options.alreadyRevealed?.has(page)) {
    options.alreadyRevealed?.add(page);
    void options.reveal(page);
  }
  return detection;
}
