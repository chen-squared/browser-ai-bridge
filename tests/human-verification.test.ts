import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectHumanVerification,
  verificationMessage,
  type PageSnapshot,
} from '../src/browser/human-verification.js';

/**
 * 人机验证识别。
 *
 * 六家都可能弹，所以规则不绑定任何一家。两类判定要分开验证：
 *   - 真验证页必须命中（漏了 = 用户一直卡到超时还不知道要干什么）
 *   - 正常页面绝不能命中（误报 = 好端端的对话被弹窗打断）
 */

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://chat.deepseek.com/',
    title: 'DeepSeek',
    text: '你好，我是 DeepSeek。',
    totalTextLength: 40,
    widgetMarkers: [],
    ...overrides,
  };
}

describe('确凿证据：有验证组件就判定', () => {
  it('Cloudflare Turnstile（实测 claude.ai 弹的就是这个）', () => {
    const detection = detectHumanVerification(
      snapshot({ widgetMarkers: ['.cf-turnstile'], title: 'claude.ai' }),
    );
    assert.equal(detection?.kind, 'cloudflare-turnstile');
    assert.equal(detection?.needsHuman, true);
    assert.match(detection!.reason, /Cloudflare/);
  });

  it('Turnstile 的 iframe 也能认出来', () => {
    assert.equal(
      detectHumanVerification(
        snapshot({ widgetMarkers: ['iframe[src*="challenges.cloudflare.com"]'] }),
      )?.kind,
      'cloudflare-turnstile',
    );
  });

  it('Cloudflare 挑战页', () => {
    assert.equal(
      detectHumanVerification(snapshot({ widgetMarkers: ['#challenge-form'] }))?.kind,
      'cloudflare-challenge',
    );
  });

  it('reCAPTCHA / hCaptcha / Arkose', () => {
    assert.equal(
      detectHumanVerification(snapshot({ widgetMarkers: ['.g-recaptcha'] }))?.kind,
      'recaptcha',
    );
    assert.equal(
      detectHumanVerification(snapshot({ widgetMarkers: ['.h-captcha'] }))?.kind,
      'hcaptcha',
    );
    assert.equal(detectHumanVerification(snapshot({ widgetMarkers: ['#arkose'] }))?.kind, 'arkose');
  });

  it('组件证据优先于页面长短——哪怕页面文字很多也该判定', () => {
    // 有些站点会把验证浮层盖在正常内容上，正文并不短
    assert.ok(
      detectHumanVerification(
        snapshot({ widgetMarkers: ['.cf-turnstile'], totalTextLength: 99_999 }),
      ),
      '有组件就是有组件，不能因为页面长就放过',
    );
  });
});

describe('URL 层面的证据', () => {
  it('停在 Cloudflare 挑战端点上', () => {
    assert.equal(
      detectHumanVerification(
        snapshot({ url: 'https://claude.ai/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1' }),
      )?.kind,
      'cloudflare-turnstile',
    );
  });

  it('嵌在页面里的 Turnstile iframe URL', () => {
    assert.equal(
      detectHumanVerification(
        snapshot({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js' }),
      )?.kind,
      'cloudflare-turnstile',
    );
  });
});

describe('只有话术时，要求页面足够空', () => {
  it('短页面 + 中文话术', () => {
    const detection = detectHumanVerification(
      snapshot({
        title: '正在进行安全验证',
        text: '本网站使用安全服务防护恶意自动程序。在验证您不是自动程序期间，将显示此页面。\n请验证您是真人',
        totalTextLength: 60,
      }),
    );
    assert.equal(detection?.kind, 'generic');
    assert.equal(detection?.evidence, '正在进行安全验证');
  });

  it('短页面 + 英文话术', () => {
    for (const phrase of [
      'Just a moment...',
      'Checking your browser before accessing',
      'Verify you are human',
      "I'm not a robot",
    ]) {
      assert.ok(
        detectHumanVerification(snapshot({ title: phrase, text: phrase, totalTextLength: 30 })),
        `应命中：${phrase}`,
      );
    }
  });

  it('**长页面里提到"安全验证"不算**——那多半是一篇讲验证的文章', () => {
    assert.equal(
      detectHumanVerification(
        snapshot({
          title: '如何实现人机验证',
          text: '本文介绍滑块验证与图形验证码的原理，并给出完整实现。'.repeat(200),
          totalTextLength: 20_000,
        }),
      ),
      null,
      '误报的代价是好端端的对话被打断，宁可漏也不能误报',
    );
  });

  it('正常的长对话也不该命中', () => {
    assert.equal(
      detectHumanVerification(
        snapshot({
          title: 'ChatGPT',
          text: '我们先来梳理一下这个问题。你提到要在会话里保存历史记录，'.repeat(100),
          totalTextLength: 30_000,
        }),
      ),
      null,
    );
  });
});

describe('正常页面一律不命中', () => {
  it('六家的常规首页', () => {
    const homes: Array<[string, string, string]> = [
      ['chatgpt', 'https://chatgpt.com/', 'ChatGPT'],
      ['claude', 'https://claude.ai/new', 'Claude'],
      ['deepseek', 'https://chat.deepseek.com/', 'DeepSeek'],
      ['grok', 'https://grok.com/', 'Grok'],
      ['qwen', 'https://chat.qwen.ai/', '通义千问'],
      ['gemini', 'https://gemini.google.com/app', 'Gemini'],
    ];
    for (const [name, url, title] of homes) {
      assert.equal(
        detectHumanVerification(snapshot({ url, title })),
        null,
        `${name} 的正常首页不该被判成验证页`,
      );
    }
  });

  it('提到"login"但有输入框的正常页面不算验证', () => {
    assert.equal(
      detectHumanVerification(
        snapshot({ title: '登录', text: '请登录以继续', totalTextLength: 20 }),
      ),
      null,
      '登录是人自己操作的，不该用"必须点"的弹窗打扰；它有专门的判断分支',
    );
  });
});

describe('给用户的提示要说清"该你点了"', () => {
  it('包含 provider、验证类型、以及下一步动作', () => {
    const detection = detectHumanVerification(snapshot({ widgetMarkers: ['.cf-turnstile'] }));
    const message = verificationMessage('claude', detection!);
    assert.match(message, /claude/);
    assert.match(message, /Cloudflare/);
    assert.match(message, /切到前台/, '必须告诉用户窗口会自动弹出来');
    assert.match(message, /手动点击/, '必须说明程序代不过去');
    assert.match(message, /重新发起/, '必须说明点完之后要做什么');
  });

  it('六个 provider 都套得进去（模板是通用的）', () => {
    const detection = detectHumanVerification(snapshot({ widgetMarkers: ['.g-recaptcha'] }));
    for (const id of ['chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'gemini']) {
      assert.match(verificationMessage(id, detection!), new RegExp(id));
    }
  });
});
