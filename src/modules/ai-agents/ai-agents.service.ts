import type { Types } from 'mongoose';
import { AppError } from '../../common/errors.js';
import { getConfig } from '../../config/env.js';
import { AiAgentRepository } from './ai-agent.repository.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import type { IAiAgent, ITypingIndicatorSettings } from './ai-agent.model.js';

/** Mongoose nested subdocs do not spread like plain objects; merge would drop fields. */
function plainTypingIndicator(ti: ITypingIndicatorSettings | undefined | null): ITypingIndicatorSettings {
  if (!ti || typeof ti !== 'object') {
    return { enabled: true, typingDurationMs: 1000 };
  }
  const maybe = ti as ITypingIndicatorSettings & { toObject?: () => ITypingIndicatorSettings };
  const src = typeof maybe.toObject === 'function' ? maybe.toObject() : maybe;
  const ms = Number(src.typingDurationMs);
  return {
    enabled: Boolean(src.enabled),
    typingDurationMs: Number.isFinite(ms) && ms >= 100 ? ms : 1000,
  };
}

export type AiAgentPublicDto = {
  agentId: string;
  sessionPublicId: string;
  sessionLabel?: string;
  businessName: string;
  businessDescription: string;
  languagePreference: string;
  toneOfVoice: string;
  enabled: boolean;
  /** True when the server has `OPENROUTER_API_KEY` (hosted AI); not a per-user Gemini key. */
  hasGeminiKey: boolean;
  updatedAt?: Date;
  typingIndicator: ITypingIndicatorSettings;
  memoryMessageLimit: number;
  temperature: number;
  /** Non-empty string = react with this emoji; null = disabled. */
  reactionEmoji: string | null;
};

export class AiAgentsService {
  constructor(
    private readonly repo: AiAgentRepository,
    private readonly sessions: SessionRepository
  ) {}

  private mapPublic(agent: IAiAgent, sessionPublicId: string, sessionLabel?: string): AiAgentPublicDto {
    return {
      agentId: agent._id.toString(),
      sessionPublicId,
      sessionLabel,
      businessName: agent.businessName,
      businessDescription: agent.businessDescription,
      languagePreference: agent.languagePreference,
      toneOfVoice: agent.toneOfVoice,
      enabled: agent.enabled,
      hasGeminiKey: Boolean(getConfig().OPENROUTER_API_KEY?.trim()),
      updatedAt: agent.updatedAt,
      typingIndicator: plainTypingIndicator(agent.typingIndicator),
      memoryMessageLimit: agent.memoryMessageLimit,
      temperature: agent.temperature,
      reactionEmoji:
        typeof agent.reactionEmoji === 'string' && agent.reactionEmoji.trim()
          ? agent.reactionEmoji.trim()
          : null,
    };
  }

  async listForUser(userId: Types.ObjectId): Promise<AiAgentPublicDto[]> {
    const agents = await this.repo.findAllForUser(userId);
    const out: AiAgentPublicDto[] = [];
    for (const a of agents) {
      const session = await this.sessions.findByIdForUser(a.sessionId, userId);
      if (!session) continue;
      out.push(this.mapPublic(a, session.publicId, session.label));
    }
    return out;
  }

  async getForSession(userId: Types.ObjectId, sessionPublicId: string): Promise<AiAgentPublicDto> {
    const session = await this.sessions.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);
    const agent = await this.repo.findBySessionForUser(session._id, userId);
    if (!agent) throw new AppError('AGENT_NOT_FOUND', 'No AI agent configured for this session', 404);
    return this.mapPublic(agent, sessionPublicId, session.label);
  }

  async upsertForSession(
    userId: Types.ObjectId,
    sessionPublicId: string,
    body: {
      businessName: string;
      businessDescription: string;
      languagePreference: string;
      toneOfVoice: string;
      enabled?: boolean;
      typingIndicator?: ITypingIndicatorSettings;
      memoryMessageLimit?: number;
      temperature?: number;
      reactionEmoji?: string | null;
    }
  ): Promise<AiAgentPublicDto> {
    const session = await this.sessions.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const agent = await this.repo.upsertForSession({
      userId,
      sessionId: session._id,
      geminiKeyEncrypted: '',
      businessName: body.businessName,
      businessDescription: body.businessDescription,
      languagePreference: body.languagePreference,
      toneOfVoice: body.toneOfVoice,
      enabled: body.enabled,
      typingIndicator: body.typingIndicator,
      memoryMessageLimit: body.memoryMessageLimit,
      temperature: body.temperature,
      reactionEmoji: body.reactionEmoji,
    });

    return this.mapPublic(agent, sessionPublicId, session.label);
  }

  async patchForSession(
    userId: Types.ObjectId,
    sessionPublicId: string,
    patch: {
      businessName?: string;
      businessDescription?: string;
      languagePreference?: string;
      toneOfVoice?: string;
      enabled?: boolean;
      typingIndicator?: Partial<ITypingIndicatorSettings>;
      memoryMessageLimit?: number;
      temperature?: number;
      reactionEmoji?: string | null;
    }
  ): Promise<AiAgentPublicDto> {
    const session = await this.sessions.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const existing = await this.repo.findBySessionForUser(session._id, userId);
    if (!existing) {
      throw new AppError('AGENT_NOT_FOUND', 'No AI agent configured for this session', 404);
    }

    const mongoPatch: Parameters<AiAgentRepository['patchForSession']>[2] = {};
    if (patch.businessName !== undefined) mongoPatch.businessName = patch.businessName;
    if (patch.businessDescription !== undefined) mongoPatch.businessDescription = patch.businessDescription;
    if (patch.languagePreference !== undefined) mongoPatch.languagePreference = patch.languagePreference;
    if (patch.toneOfVoice !== undefined) mongoPatch.toneOfVoice = patch.toneOfVoice;
    if (patch.enabled !== undefined) mongoPatch.enabled = patch.enabled;
    if (patch.typingIndicator !== undefined) {
      const base = plainTypingIndicator(existing.typingIndicator);
      const p = patch.typingIndicator;
      mongoPatch.typingIndicator = {
        enabled: p.enabled !== undefined ? p.enabled : base.enabled,
        typingDurationMs:
          p.typingDurationMs !== undefined ? p.typingDurationMs : base.typingDurationMs,
      };
    }
    if (patch.memoryMessageLimit !== undefined) mongoPatch.memoryMessageLimit = patch.memoryMessageLimit;
    if (patch.temperature !== undefined) mongoPatch.temperature = patch.temperature;
    if (patch.reactionEmoji !== undefined) mongoPatch.reactionEmoji = patch.reactionEmoji;

    const updated = await this.repo.patchForSession(session._id, userId, mongoPatch);
    if (!updated) throw new AppError('AGENT_NOT_FOUND', 'No AI agent configured for this session', 404);
    return this.mapPublic(updated, sessionPublicId, session.label);
  }

  async deleteForSession(userId: Types.ObjectId, sessionPublicId: string): Promise<void> {
    const session = await this.sessions.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);
    const ok = await this.repo.deleteBySessionForUser(session._id, userId);
    if (!ok) throw new AppError('AGENT_NOT_FOUND', 'No AI agent configured for this session', 404);
  }
}
