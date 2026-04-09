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
  DEFAULT_PROVIDER: z
    .enum(['chatgpt', 'gemini', 'claude', 'grok', 'qwen', 'deepseek'])
    .default('chatgpt'),
  BROWSER_CHANNEL: z.enum(['chrome', 'msedge']).optional(),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
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
  defaultProvider: parsed.DEFAULT_PROVIDER,
  browserChannel: parsed.BROWSER_CHANNEL,
  chromeExecutablePath: parsed.CHROME_EXECUTABLE_PATH,
  debugPrompts: parsed.BRIDGE_DEBUG_PROMPTS,
};
