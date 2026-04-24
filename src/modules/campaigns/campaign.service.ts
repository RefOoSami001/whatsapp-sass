import type { Types } from 'mongoose';
import { AppError } from '../../common/errors.js';
import type { AppConfig } from '../../config/env.js';
import type { SessionRepository } from '../sessions/session.repository.js';
import type { CampaignQueueService } from '../../queues/campaign-queue.service.js';
import type { CampaignRepository } from './campaign.repository.js';
import type { ICampaign } from './campaign.model.js';

export type CreateCampaignInput = {
  recipients: string[];
  text?: string;
  imageUrls?: string[];
  baseDelayMs?: number;
  jitterMs?: number;
  maxSendsPerHour?: number;
  scheduledAt?: string;
};

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function mapCampaign(c: ICampaign) {
  return {
    campaignId: c.publicId,
    status: c.status,
    scheduledAt: c.scheduledAt,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    message: c.message,
    options: c.options,
    totalRecipients: c.totalRecipients,
    pendingCount: c.pendingCount,
    sentCount: c.sentCount,
    failedCount: c.failedCount,
    skippedCount: c.skippedCount,
    lastError: c.lastError,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export class CampaignService {
  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly campaignRepo: CampaignRepository,
    private readonly campaignQueue: CampaignQueueService,
    private readonly getConfig: () => AppConfig
  ) {}

  async create(
    userId: Types.ObjectId,
    sessionPublicId: string,
    input: CreateCampaignInput
  ) {
    const cfg = this.getConfig();
    const session = await this.sessionRepo.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const recipientsRaw = input.recipients.map((r) => r.trim()).filter(Boolean);
    const recipients = [...new Set(recipientsRaw)];
    if (recipients.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'At least one recipient is required', 400);
    }
    if (recipients.length > cfg.CAMPAIGN_MAX_RECIPIENTS) {
      throw new AppError(
        'CAMPAIGN_TOO_LARGE',
        `Maximum ${cfg.CAMPAIGN_MAX_RECIPIENTS} recipients per campaign`,
        400
      );
    }

    for (const r of recipients) {
      if (r.length < 5 || r.length > 64) {
        throw new AppError('VALIDATION_ERROR', 'Each recipient must be 5–64 characters', 400);
      }
    }

    const imageUrls = (input.imageUrls ?? []).filter(Boolean);
    for (const u of imageUrls) {
      if (!isHttpsUrl(u)) {
        throw new AppError('VALIDATION_ERROR', 'imageUrls must be valid https URLs', 400);
      }
    }

    const text = input.text?.trim() ?? '';
    if (!text && imageUrls.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'Provide text and/or imageUrls', 400);
    }

    const baseDelayMs = input.baseDelayMs ?? 3000;
    const jitterMs = input.jitterMs ?? 0;
    if (baseDelayMs < 0 || baseDelayMs > 600_000) {
      throw new AppError('VALIDATION_ERROR', 'baseDelayMs must be between 0 and 600000', 400);
    }
    if (jitterMs < 0 || jitterMs > 120_000) {
      throw new AppError('VALIDATION_ERROR', 'jitterMs must be between 0 and 120000', 400);
    }

    const maxSendsPerHour = input.maxSendsPerHour;
    if (maxSendsPerHour !== undefined && (maxSendsPerHour < 1 || maxSendsPerHour > 10_000)) {
      throw new AppError('VALIDATION_ERROR', 'maxSendsPerHour must be between 1 and 10000', 400);
    }

    const now = new Date();
    let status: ICampaign['status'];
    let scheduledAt: Date | undefined;
    let startedAt: Date | undefined;

    if (input.scheduledAt) {
      const d = new Date(input.scheduledAt);
      if (Number.isNaN(d.getTime())) {
        throw new AppError('VALIDATION_ERROR', 'scheduledAt must be a valid ISO date', 400);
      }
      if (d > now) {
        status = 'scheduled';
        scheduledAt = d;
      } else {
        status = 'running';
        startedAt = now;
      }
    } else {
      status = 'running';
      startedAt = now;
    }

    const message = {
      ...(text ? { text } : {}),
      imageUrls,
    };

    const options = {
      baseDelayMs,
      jitterMs,
      ...(maxSendsPerHour !== undefined ? { maxSendsPerHour } : {}),
    };

    const campaign = await this.campaignRepo.createCampaign({
      userId,
      sessionId: session._id,
      status,
      scheduledAt,
      startedAt,
      message,
      options,
      totalRecipients: recipients.length,
      pendingCount: recipients.length,
    });

    await this.campaignRepo.insertRecipients(campaign._id, recipients);

    if (status === 'running') {
      this.campaignQueue.enqueueCampaign(campaign._id.toString());
    }

    const full = await this.campaignRepo.findById(campaign._id);
    return mapCampaign(full!);
  }

  async list(
    userId: Types.ObjectId,
    sessionPublicId: string,
    page: number,
    pageSize: number
  ) {
    const session = await this.sessionRepo.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      this.campaignRepo.listForSession(userId, session._id, skip, pageSize),
      this.campaignRepo.countForSession(userId, session._id),
    ]);

    return {
      items: items.map(mapCampaign),
      total,
      page,
      pageSize,
    };
  }

  async get(userId: Types.ObjectId, sessionPublicId: string, campaignPublicId: string) {
    const session = await this.sessionRepo.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const c = await this.campaignRepo.findByPublicIdForUser(campaignPublicId, userId, session._id);
    if (!c) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campaign not found', 404);

    const recentFailures = await this.campaignRepo.listRecentFailed(c._id, 20);

    return {
      ...mapCampaign(c),
      recentFailures,
    };
  }

  async pause(userId: Types.ObjectId, sessionPublicId: string, campaignPublicId: string) {
    const session = await this.sessionRepo.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const c = await this.campaignRepo.findByPublicIdForUser(campaignPublicId, userId, session._id);
    if (!c) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campaign not found', 404);

    if (['completed', 'cancelled', 'failed'].includes(c.status)) {
      throw new AppError('CAMPAIGN_TERMINAL', 'Campaign is already finished', 400);
    }
    if (c.status === 'paused') {
      return mapCampaign(c);
    }

    await this.campaignRepo.updateById(c._id, { status: 'paused' });
    const updated = await this.campaignRepo.findById(c._id);
    return mapCampaign(updated!);
  }

  async resume(userId: Types.ObjectId, sessionPublicId: string, campaignPublicId: string) {
    const session = await this.sessionRepo.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const c = await this.campaignRepo.findByPublicIdForUser(campaignPublicId, userId, session._id);
    if (!c) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campaign not found', 404);

    if (c.status !== 'paused') {
      throw new AppError('CAMPAIGN_NOT_PAUSED', 'Campaign is not paused', 400);
    }

    const active = await this.campaignRepo.countPendingLike(c._id);
    if (active === 0) {
      throw new AppError('CAMPAIGN_EMPTY', 'No pending recipients to resume', 400);
    }

    const now = new Date();
    if (c.scheduledAt && c.scheduledAt > now) {
      await this.campaignRepo.updateById(c._id, { status: 'scheduled' });
    } else {
      await this.campaignRepo.updateById(c._id, { status: 'running' });
      this.campaignQueue.enqueueCampaign(c._id.toString());
    }

    const updated = await this.campaignRepo.findById(c._id);
    return mapCampaign(updated!);
  }

  async cancel(userId: Types.ObjectId, sessionPublicId: string, campaignPublicId: string) {
    const session = await this.sessionRepo.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const c = await this.campaignRepo.findByPublicIdForUser(campaignPublicId, userId, session._id);
    if (!c) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campaign not found', 404);

    if (['completed', 'cancelled', 'failed'].includes(c.status)) {
      throw new AppError('CAMPAIGN_TERMINAL', 'Campaign is already finished', 400);
    }

    const n = await this.campaignRepo.skipPendingAndProcessing(c._id);
    await this.campaignRepo.applySkipBulk(c._id, n);
    await this.campaignRepo.updateById(c._id, {
      status: 'cancelled',
      finishedAt: new Date(),
    });

    const updated = await this.campaignRepo.findById(c._id);
    return mapCampaign(updated!);
  }

  async remove(userId: Types.ObjectId, sessionPublicId: string, campaignPublicId: string) {
    const session = await this.sessionRepo.findByPublicIdForUser(sessionPublicId, userId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found', 404);

    const c = await this.campaignRepo.findByPublicIdForUser(campaignPublicId, userId, session._id);
    if (!c) throw new AppError('CAMPAIGN_NOT_FOUND', 'Campaign not found', 404);

    if (!['completed', 'cancelled', 'failed'].includes(c.status)) {
      throw new AppError(
        'CAMPAIGN_ACTIVE',
        'Only completed, cancelled, or failed campaigns can be deleted',
        409
      );
    }

    await this.campaignRepo.deleteByPublicIdForUser(campaignPublicId, userId, session._id);
    return { ok: true as const };
  }
}
