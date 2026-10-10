import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3010),
  HOST: z.string().default('127.0.0.1'),
  HEADLESS: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  USER_DATA_DIR: z.string().default('.sessions/chromium'),
  SELECTOR_OVERRIDES_PATH: z.string().default('selectors.overrides.json'),
  CONVERSATION_URL_STORE_PATH: z.string().default('.sessions/conversation-urls.json'),
  MEETING_STORE_PATH: z.string().default('.sessions/meetings.json'),
  DEFAULT_PROVIDER: z
    .enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek'])
    .default('chatgpt'),
  BROWSER_CHANNEL: z.enum(['chrome', 'msedge']).optional(),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  // 访问控制：见 src/http-access.ts
  // BRIDGE_TOKEN 一旦设置，除 /health 与控制台静态资源外的所有接口都要求携带。
  BRIDGE_TOKEN: z.string().min(16).optional(),
  // 不设置 = 只允许同源访问（默认）。跨源时按逗号分隔的白名单放行。
  CORS_ORIGIN: z.string().optional(),
  // 额外允许的 Host，逗号分隔。默认已含 localhost / 127.0.0.1 / ::1。
  ALLOWED_HOSTS: z.string().optional(),
  /**
   * 出错时是否自动把对应标签页切到前台。
   *
   * 默认关闭。原来是默认开启的，实测在 macOS 上会频繁把浏览器窗口拽到前台，
   * 干扰同一台机器上的其他操作——尤其是未登录时那90 秒超时，几乎每错一次就跳一次。
   * 需要"卡住时自动看一眼"的场景再打开。
   */
  REVEAL_ON_ERROR: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  BRIDGE_DEBUG_PROMPTS: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
});

const parsed = schema.parse(process.env);

export const appConfig = {
  port: parsed.PORT,
  host: parsed.HOST,
  headless: parsed.HEADLESS,
  userDataDir: path.resolve(process.cwd(), parsed.USER_DATA_DIR),
  selectorOverridesPath: path.resolve(process.cwd(), parsed.SELECTOR_OVERRIDES_PATH),
  conversationUrlStorePath: path.resolve(process.cwd(), parsed.CONVERSATION_URL_STORE_PATH),
  meetingStorePath: path.resolve(process.cwd(), parsed.MEETING_STORE_PATH),
  defaultProvider: parsed.DEFAULT_PROVIDER,
  browserChannel: parsed.BROWSER_CHANNEL,
  chromeExecutablePath: parsed.CHROME_EXECUTABLE_PATH,
  bridgeToken: parsed.BRIDGE_TOKEN,
  corsOrigin: parsed.CORS_ORIGIN,
  allowedHosts: parsed.ALLOWED_HOSTS,
  revealOnError: parsed.REVEAL_ON_ERROR,
  debugPrompts: parsed.BRIDGE_DEBUG_PROMPTS,
};
