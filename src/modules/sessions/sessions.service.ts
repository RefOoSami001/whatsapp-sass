import type { Types } from 'mongoose';
import { AppError } from '../../common/errors.js';
import { SessionRepository } from './session.repository.js';
import type { WhatsAppSessionManager } from './whatsapp-session.manager.js';
import { AiAgentModel } from '../ai-agents/ai-agent.model.js';
import { ConversationMemoryModel } from '../messages/conversation-memory.model.js';
import type { CampaignRepository } from '../campaigns/campaign.repository.js';

export class SessionsService {
  constructor(
    private readonly repo: SessionRepository,
    private readonly wa: WhatsAppSessionManager,
    private readonly campaignRepo: CampaignRepository
  ) {}

  async create(userId: Types.ObjectId, label?: string) {
    return this.repo.create(userId, label);
  }

  async list(userId: Types.ObjectId) {
    return this.repo.listForUser(userId);
  }

  async get(userId: Types.ObjectId, publicId: string) {
    const s = await this.repo.findByPublicIdForUser(publicId, userId);
    if (!s) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);
    return s;
  }

  async start(userId: Types.ObjectId, publicId: string) {
    const s = await this.get(userId, publicId);
    await this.wa.startSession(s);
    const updated = await this.get(userId, publicId);
    return { session: updated, qrCode: updated.qrCode };
  }

  async stop(userId: Types.ObjectId, publicId: string) {
    await this.get(userId, publicId);
    await this.wa.stopSession(publicId);
  }

  async sendMessage(userId: Types.ObjectId, publicId: string, to: string, text: string) {
    await this.get(userId, publicId);
    if (!this.wa.isConnected(publicId)) {
      throw new AppError('SESSION_OFFLINE', 'WhatsApp session is not connected', 409);
    }
    await this.wa.sendText(publicId, to, text);
  }

  async delete(userId: Types.ObjectId, publicId: string) {
    const s = await this.get(userId, publicId);
    await this.campaignRepo.deleteManyBySessionId(s._id);
    await AiAgentModel.deleteMany({ sessionId: s._id });
    await ConversationMemoryModel.deleteMany({ sessionId: s._id });
    await this.wa.logoutAndDelete(s);
    await this.repo.deleteById(s._id);
  }
}
