import { getConfig } from '../../config/env.js';
import type { IAiAgent } from '../ai-agents/ai-agent.model.js';

/**
 * Effective max stored messages per chat: min(server env ceiling, agent.memoryMessageLimit).
 */
export function effectiveMemoryMessageCap(agent: IAiAgent | null): number {
  const envMax = getConfig().AI_MEMORY_MAX_MESSAGES;
  if (agent && typeof agent.memoryMessageLimit === 'number' && agent.memoryMessageLimit > 0) {
    return Math.min(envMax, agent.memoryMessageLimit);
  }
  return envMax;
}
