import type { Types } from 'mongoose';
import { getConfig } from '../../config/env.js';
import { ConversationMemoryRepository } from './conversation-memory.repository.js';
import type { IMemoryMessage } from './conversation-memory.model.js';

export class MessagesService {
  constructor(private readonly repo: ConversationMemoryRepository) {}

  async appendUserMessage(
    userId: Types.ObjectId,
    sessionId: Types.ObjectId,
    remoteJid: string,
    text: string,
    maxMessages?: number
  ): Promise<void> {
    const cap = maxMessages ?? getConfig().AI_MEMORY_MAX_MESSAGES;
    const msg: IMemoryMessage = { role: 'user', text, at: new Date(), remoteJid };
    await this.repo.append(userId, sessionId, remoteJid, msg, cap);
  }

  async appendAssistantMessage(
    userId: Types.ObjectId,
    sessionId: Types.ObjectId,
    remoteJid: string,
    text: string,
    maxMessages?: number
  ): Promise<void> {
    const cap = maxMessages ?? getConfig().AI_MEMORY_MAX_MESSAGES;
    const msg: IMemoryMessage = { role: 'assistant', text, at: new Date(), remoteJid };
    await this.repo.append(userId, sessionId, remoteJid, msg, cap);
  }

  async getContext(sessionId: Types.ObjectId, remoteJid: string, limit: number) {
    return this.repo.getRecent(sessionId, remoteJid, limit);
  }
}
