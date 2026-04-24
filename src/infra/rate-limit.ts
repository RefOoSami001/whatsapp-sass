import { getConfig } from '../config/env.js';

/** Sliding 60s window, in-process only (single Node instance). */
const buckets = new Map<string, number[]>();

export function allowSend(key: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  let ts = buckets.get(key) ?? [];
  ts = ts.filter((t) => t > cutoff);
  if (ts.length >= maxPerMinute) {
    buckets.set(key, ts);
    return false;
  }
  ts.push(now);
  buckets.set(key, ts);
  return true;
}

export function aiRateKey(sessionMongoId: string): string {
  return `ai:session:${sessionMongoId}`;
}

export function maxAiPerMinute(): number {
  return getConfig().AI_REPLY_MAX_PER_MINUTE;
}
