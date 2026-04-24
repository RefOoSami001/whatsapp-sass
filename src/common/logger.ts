import pino from 'pino';
import { getConfig } from '../config/env.js';

const cfg = (() => {
  try {
    return getConfig();
  } catch {
    return { NODE_ENV: 'development' as const };
  }
})();

export const logger = pino({
  level: cfg.NODE_ENV === 'production' ? 'info' : 'debug',
});
