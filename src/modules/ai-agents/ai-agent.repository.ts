import { AiAgentModel, type IAiAgent, type ITypingIndicatorSettings } from './ai-agent.model.js';
import type { Types } from 'mongoose';
import { AppError } from '../../common/errors.js';

export type UpsertAgentInput = {
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  geminiKeyEncrypted?: string;
  businessName: string;
  businessDescription: string;
  languagePreference: string;
  toneOfVoice: string;
  enabled?: boolean;
  typingIndicator?: ITypingIndicatorSettings;
  memoryMessageLimit?: number;
  temperature?: number;
  reactionEmoji?: string | null;
};

export class AiAgentRepository {
  async findBySession(sessionId: Types.ObjectId): Promise<IAiAgent | null> {
    return AiAgentModel.findOne({ sessionId });
  }

  async findBySessionForUser(
    sessionId: Types.ObjectId,
    userId: Types.ObjectId
  ): Promise<IAiAgent | null> {
    return AiAgentModel.findOne({ sessionId, userId });
  }

  async findAllForUser(userId: Types.ObjectId): Promise<IAiAgent[]> {
    return AiAgentModel.find({ userId }).sort({ updatedAt: -1 });
  }

  async upsertForSession(data: UpsertAgentInput): Promise<IAiAgent> {
    const set: Record<string, unknown> = {
      userId: data.userId,
      businessName: data.businessName,
      businessDescription: data.businessDescription,
      languagePreference: data.languagePreference,
      toneOfVoice: data.toneOfVoice,
      geminiKeyEncrypted: data.geminiKeyEncrypted ?? '',
    };
    if (data.enabled !== undefined) set.enabled = data.enabled;
    if (data.typingIndicator !== undefined) set.typingIndicator = data.typingIndicator;
    if (data.memoryMessageLimit !== undefined) set.memoryMessageLimit = data.memoryMessageLimit;
    if (data.temperature !== undefined) set.temperature = data.temperature;
    if (data.reactionEmoji !== undefined) set.reactionEmoji = data.reactionEmoji;

    return AiAgentModel.findOneAndUpdate(
      { sessionId: data.sessionId },
      { $set: set },
      { upsert: true, new: true, runValidators: true }
    ).then((d) => d!);
  }

  async patchForSession(
    sessionId: Types.ObjectId,
    userId: Types.ObjectId,
    patch: Partial<
      Pick<
        IAiAgent,
        | 'businessName'
        | 'businessDescription'
        | 'languagePreference'
        | 'toneOfVoice'
        | 'enabled'
        | 'typingIndicator'
        | 'memoryMessageLimit'
        | 'temperature'
        | 'reactionEmoji'
      >
    > & { geminiKeyEncrypted?: string }
  ): Promise<IAiAgent | null> {
    return AiAgentModel.findOneAndUpdate(
      { sessionId, userId },
      { $set: patch },
      { new: true, runValidators: true }
    );
  }

  async deleteBySessionForUser(sessionId: Types.ObjectId, userId: Types.ObjectId): Promise<boolean> {
    const r = await AiAgentModel.deleteOne({ sessionId, userId });
    return r.deletedCount > 0;
  }
}
