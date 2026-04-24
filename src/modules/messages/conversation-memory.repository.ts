import { getConfig } from '../../config/env.js';
import { ConversationMemoryModel, type IMemoryMessage } from './conversation-memory.model.js';
import type { Types } from 'mongoose';

export class ConversationMemoryRepository {
  /**
   * Append one message and keep at most `maxMessages` entries for this chat (FIFO trim in MongoDB).
   * `maxMessages` is capped by env `AI_MEMORY_MAX_MESSAGES` (hard server ceiling).
   */
  async append(
    userId: Types.ObjectId,
    sessionId: Types.ObjectId,
    remoteJid: string,
    msg: IMemoryMessage,
    maxMessages: number
  ): Promise<void> {
    const envMax = getConfig().AI_MEMORY_MAX_MESSAGES;
    const cap = Math.max(1, Math.min(Math.floor(maxMessages), envMax));
    await ConversationMemoryModel.findOneAndUpdate(
      { sessionId, remoteJid },
      {
        $setOnInsert: { userId, sessionId, remoteJid },
        $push: {
          messages: {
            $each: [msg],
            $slice: -cap,
          },
        },
      },
      { upsert: true }
    );
  }

  async getRecent(
    sessionId: Types.ObjectId,
    remoteJid: string,
    limit: number
  ): Promise<IMemoryMessage[]> {
    const doc = await ConversationMemoryModel.findOne({ sessionId, remoteJid })
      .select({ messages: { $slice: -limit } })
      .lean();
    return doc?.messages ?? [];
  }

  async removeMessagesOlderThan(
    sessionId: Types.ObjectId,
    remoteJid: string,
    cutoffTime: Date
  ): Promise<void> {
    await ConversationMemoryModel.findOneAndUpdate(
      { sessionId, remoteJid },
      {
        $pull: {
          messages: { at: { $lt: cutoffTime } },
        },
      }
    );
  }

  async getMessageCount(sessionId: Types.ObjectId, remoteJid: string): Promise<number> {
    const doc = await ConversationMemoryModel.findOne({ sessionId, remoteJid }).lean();
    return doc?.messages?.length ?? 0;
  }

  async clearMessages(sessionId: Types.ObjectId, remoteJid: string): Promise<void> {
    await ConversationMemoryModel.findOneAndUpdate(
      { sessionId, remoteJid },
      { $set: { messages: [] } }
    );
  }
}
