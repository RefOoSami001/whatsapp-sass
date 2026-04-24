import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  MONGO_URI: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  JWT_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z.string().length(64).regex(/^[0-9a-fA-F]+$/),
  AI_REPLY_MAX_PER_MINUTE: z.coerce.number().min(1).default(30),
  AI_MEMORY_MAX_MESSAGES: z.coerce.number().min(1).max(100).default(100),
  AI_DEBOUNCE_MS: z.coerce.number().int().min(0).max(10_000).default(3000),
  AI_DEBOUNCE_MAX_BUFFER_MSGS: z.coerce.number().int().min(1).max(20).default(6),
  AI_DEBOUNCE_MAX_WAIT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
  CAMPAIGN_MAX_RECIPIENTS: z.coerce.number().int().min(1).max(100_000).default(5000),
  CAMPAIGN_MIN_DELAY_MS: z.coerce.number().int().min(0).max(120_000).default(2000),
  CAMPAIGN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  CAMPAIGN_SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  /** Server-side OpenRouter key (users do not supply their own model API key). */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_HTTP_REFERER: z.string().min(1).max(500).optional(),
  OPENROUTER_APP_TITLE: z.string().min(1).max(200).optional(),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}
