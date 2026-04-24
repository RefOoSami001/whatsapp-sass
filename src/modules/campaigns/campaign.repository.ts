import { randomUUID } from 'crypto';
import type { Types } from 'mongoose';
import {
  CampaignModel,
  type ICampaign,
  type ICampaignMessage,
  type ICampaignOptions,
  type CampaignStatus,
} from './campaign.model.js';
import { CampaignRecipientModel, type ICampaignRecipient } from './campaign-recipient.model.js';

export class CampaignRepository {
  async createCampaign(input: {
    userId: Types.ObjectId;
    sessionId: Types.ObjectId;
    status: CampaignStatus;
    scheduledAt?: Date;
    startedAt?: Date;
    message: ICampaignMessage;
    options: ICampaignOptions;
    totalRecipients: number;
    pendingCount: number;
  }): Promise<ICampaign> {
    return CampaignModel.create({
      publicId: randomUUID(),
      userId: input.userId,
      sessionId: input.sessionId,
      status: input.status,
      scheduledAt: input.scheduledAt,
      startedAt: input.startedAt,
      message: input.message,
      options: input.options,
      totalRecipients: input.totalRecipients,
      pendingCount: input.pendingCount,
      sentCount: 0,
      failedCount: 0,
      skippedCount: 0,
    });
  }

  async insertRecipients(
    campaignId: Types.ObjectId,
    recipients: string[]
  ): Promise<void> {
    if (recipients.length === 0) return;
    await CampaignRecipientModel.insertMany(
      recipients.map((to, index) => ({
        campaignId,
        index,
        to,
        status: 'pending' as const,
      }))
    );
  }

  async findByPublicIdForUser(
    campaignPublicId: string,
    userId: Types.ObjectId,
    sessionId: Types.ObjectId
  ): Promise<ICampaign | null> {
    return CampaignModel.findOne({
      publicId: campaignPublicId,
      userId,
      sessionId,
    });
  }

  async findById(campaignId: Types.ObjectId): Promise<ICampaign | null> {
    return CampaignModel.findById(campaignId);
  }

  async listForSession(
    userId: Types.ObjectId,
    sessionId: Types.ObjectId,
    skip: number,
    limit: number
  ): Promise<ICampaign[]> {
    return CampaignModel.find({ userId, sessionId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  }

  async countForSession(userId: Types.ObjectId, sessionId: Types.ObjectId): Promise<number> {
    return CampaignModel.countDocuments({ userId, sessionId });
  }

  async updateById(
    campaignId: Types.ObjectId,
    patch: Partial<
      Pick<
        ICampaign,
        | 'status'
        | 'scheduledAt'
        | 'startedAt'
        | 'finishedAt'
        | 'pendingCount'
        | 'sentCount'
        | 'failedCount'
        | 'skippedCount'
        | 'lastError'
      >
    >
  ): Promise<void> {
    await CampaignModel.updateOne({ _id: campaignId }, { $set: patch });
  }

  async findRunningCampaignIds(): Promise<Types.ObjectId[]> {
    const rows = await CampaignModel.find({ status: 'running' }).select('_id').lean();
    return rows.map((r) => r._id as Types.ObjectId);
  }

  async findDueScheduled(now: Date): Promise<ICampaign[]> {
    return CampaignModel.find({
      status: 'scheduled',
      scheduledAt: { $lte: now },
    }).exec();
  }

  async deleteByPublicIdForUser(
    campaignPublicId: string,
    userId: Types.ObjectId,
    sessionId: Types.ObjectId
  ): Promise<ICampaign | null> {
    const c = await CampaignModel.findOne({
      publicId: campaignPublicId,
      userId,
      sessionId,
    });
    if (!c) return null;
    await CampaignRecipientModel.deleteMany({ campaignId: c._id });
    await CampaignModel.deleteOne({ _id: c._id });
    return c;
  }

  async deleteRecipientsForCampaign(campaignId: Types.ObjectId): Promise<void> {
    await CampaignRecipientModel.deleteMany({ campaignId });
  }

  async claimNextPendingRecipient(campaignId: Types.ObjectId): Promise<ICampaignRecipient | null> {
    return CampaignRecipientModel.findOneAndUpdate(
      { campaignId, status: 'pending' },
      { $set: { status: 'processing' } },
      { sort: { index: 1 }, new: true }
    );
  }

  async tryMarkRecipientSent(recipientId: Types.ObjectId): Promise<boolean> {
    const res = await CampaignRecipientModel.updateOne(
      { _id: recipientId, status: 'processing' },
      { $set: { status: 'sent', sentAt: new Date() } }
    );
    return (res.modifiedCount ?? 0) > 0;
  }

  async tryMarkRecipientFailed(recipientId: Types.ObjectId, error: string): Promise<boolean> {
    const res = await CampaignRecipientModel.updateOne(
      { _id: recipientId, status: 'processing' },
      { $set: { status: 'failed', error } }
    );
    return (res.modifiedCount ?? 0) > 0;
  }

  async resetStaleProcessing(staleBefore: Date): Promise<number> {
    const res = await CampaignRecipientModel.updateMany(
      { status: 'processing', updatedAt: { $lt: staleBefore } },
      { $set: { status: 'pending' } }
    );
    return res.modifiedCount ?? 0;
  }

  async countSendsInLastHour(campaignId: Types.ObjectId, since: Date): Promise<number> {
    return CampaignRecipientModel.countDocuments({
      campaignId,
      status: 'sent',
      sentAt: { $gte: since },
    });
  }

  async skipPendingAndProcessing(campaignId: Types.ObjectId): Promise<number> {
    const res = await CampaignRecipientModel.updateMany(
      { campaignId, status: { $in: ['pending', 'processing'] } },
      { $set: { status: 'skipped' } }
    );
    return res.modifiedCount ?? 0;
  }

  async incrementSent(campaignId: Types.ObjectId): Promise<void> {
    await CampaignModel.updateOne(
      { _id: campaignId },
      { $inc: { sentCount: 1, pendingCount: -1 } }
    );
  }

  async incrementFailed(campaignId: Types.ObjectId): Promise<void> {
    await CampaignModel.updateOne(
      { _id: campaignId },
      { $inc: { failedCount: 1, pendingCount: -1 } }
    );
  }

  async applySkipBulk(campaignId: Types.ObjectId, count: number): Promise<void> {
    if (count <= 0) return;
    await CampaignModel.updateOne(
      { _id: campaignId },
      { $inc: { skippedCount: count, pendingCount: -count } }
    );
  }

  async listRecentFailed(
    campaignId: Types.ObjectId,
    limit: number
  ): Promise<Pick<ICampaignRecipient, 'to' | 'error' | 'index'>[]> {
    return CampaignRecipientModel.find({ campaignId, status: 'failed' })
      .sort({ index: 1 })
      .limit(limit)
      .select('to error index')
      .lean()
      .exec();
  }

  async countPendingLike(campaignId: Types.ObjectId): Promise<number> {
    return CampaignRecipientModel.countDocuments({
      campaignId,
      status: { $in: ['pending', 'processing'] },
    });
  }

  async deleteManyBySessionId(sessionId: Types.ObjectId): Promise<void> {
    const camps = await CampaignModel.find({ sessionId }).select('_id');
    const ids = camps.map((c) => c._id);
    if (ids.length) {
      await CampaignRecipientModel.deleteMany({ campaignId: { $in: ids } });
    }
    await CampaignModel.deleteMany({ sessionId });
  }
}
