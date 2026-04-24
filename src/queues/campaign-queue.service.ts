import PQueue from 'p-queue';
import { Types } from 'mongoose';
import { logger } from '../common/logger.js';
import type { AppConfig } from '../config/env.js';
import type { CampaignRepository } from '../modules/campaigns/campaign.repository.js';
import type { WhatsAppSessionManager } from '../modules/sessions/whatsapp-session.manager.js';
import type { SessionRepository } from '../modules/sessions/session.repository.js';
import type { ICampaign } from '../modules/campaigns/campaign.model.js';
import { CampaignModel } from '../modules/campaigns/campaign.model.js';

export class CampaignQueueService {
  private readonly q: PQueue;
  private readonly activeCampaignIds = new Set<string>();
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      campaignRepo: CampaignRepository;
      sessionRepo: SessionRepository;
      getWa: () => WhatsAppSessionManager;
      getConfig: () => AppConfig;
    }
  ) {
    this.q = new PQueue({ concurrency: deps.getConfig().CAMPAIGN_WORKER_CONCURRENCY });
  }

  startScheduler(): void {
    if (this.schedulerTimer) return;
    const ms = this.deps.getConfig().CAMPAIGN_SCHEDULER_INTERVAL_MS;
    this.schedulerTimer = setInterval(() => {
      void this.promoteDueScheduled().catch((e) =>
        logger.warn({ err: String(e) }, 'campaign scheduler tick failed')
      );
    }, ms);
    this.schedulerTimer.unref?.();
  }

  recoverAfterBoot(): void {
    void this.deps.campaignRepo
      .resetStaleProcessing(new Date(Date.now() - 15 * 60 * 1000))
      .then((n) => {
        if (n > 0) logger.info({ count: n }, 'Reset stale campaign recipients to pending');
      })
      .catch((e) => logger.warn({ err: String(e) }, 'resetStaleProcessing failed'));

    void this.deps.campaignRepo
      .findRunningCampaignIds()
      .then((ids) => {
        for (const id of ids) this.enqueueCampaign(id.toString());
      })
      .catch((e) => logger.warn({ err: String(e) }, 'recover running campaigns failed'));

    void this.promoteDueScheduled().catch((e) =>
      logger.warn({ err: String(e) }, 'initial campaign schedule promotion failed')
    );
  }

  enqueueCampaign(campaignId: string): void {
    if (this.activeCampaignIds.has(campaignId)) return;
    this.activeCampaignIds.add(campaignId);
    void this.q
      .add(() => this.runCampaignLoop(campaignId))
      .catch((e) => logger.error({ campaignId, err: String(e) }, 'campaign worker crashed'))
      .finally(() => {
        this.activeCampaignIds.delete(campaignId);
      });
  }

  private async promoteDueScheduled(): Promise<void> {
    const now = new Date();
    const due = await this.deps.campaignRepo.findDueScheduled(now);
    for (const c of due) {
      const promoted = await CampaignModel.findOneAndUpdate(
        { _id: c._id, status: 'scheduled', scheduledAt: { $lte: now } },
        { $set: { status: 'running', startedAt: c.startedAt ?? now } },
        { new: true }
      );
      if (promoted) {
        logger.info({ campaignId: promoted._id.toString() }, 'Scheduled campaign promoted to running');
        this.enqueueCampaign(promoted._id.toString());
      }
    }
  }

  private async reloadCampaign(campaignId: Types.ObjectId): Promise<ICampaign | null> {
    return this.deps.campaignRepo.findById(campaignId);
  }

  private computeDelayMs(c: ICampaign): number {
    const cfg = this.deps.getConfig();
    const base = Math.max(c.options.baseDelayMs, cfg.CAMPAIGN_MIN_DELAY_MS);
    const jitter = Math.max(0, c.options.jitterMs);
    if (jitter <= 0) return base;
    return base + Math.floor(Math.random() * (jitter + 1));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  private async throttleHourlyLimit(campaignId: Types.ObjectId, maxPerHour?: number): Promise<void> {
    if (!maxPerHour || maxPerHour <= 0) return;
    for (;;) {
      const camp = await this.reloadCampaign(campaignId);
      if (!camp || camp.status !== 'running') return;

      const since = new Date(Date.now() - 60 * 60 * 1000);
      const sentLastHour = await this.deps.campaignRepo.countSendsInLastHour(campaignId, since);
      if (sentLastHour < maxPerHour) return;

      logger.debug({ campaignId: campaignId.toString(), sentLastHour, maxPerHour }, 'Campaign hourly cap; waiting');
      await this.sleep(10_000);
    }
  }

  private async maybeFinalize(campaignId: Types.ObjectId): Promise<void> {
    const active = await this.deps.campaignRepo.countPendingLike(campaignId);
    if (active > 0) return;
    const c = await this.reloadCampaign(campaignId);
    if (!c || c.status === 'cancelled' || c.status === 'paused') return;
    if (c.status === 'running') {
      await this.deps.campaignRepo.updateById(campaignId, {
        status: 'completed',
        finishedAt: new Date(),
      });
      logger.info({ campaignId: campaignId.toString() }, 'Campaign completed');
    }
  }

  private async runCampaignLoop(campaignIdStr: string): Promise<void> {
    let campaignId: Types.ObjectId;
    try {
      campaignId = new Types.ObjectId(campaignIdStr);
    } catch {
      logger.warn({ campaignIdStr }, 'Invalid campaign id');
      return;
    }

    for (;;) {
      const c = await this.reloadCampaign(campaignId);
      if (!c) return;

      if (c.status === 'paused' || c.status === 'cancelled' || c.status === 'completed') {
        return;
      }

      if (c.status === 'scheduled') {
        if (c.scheduledAt && c.scheduledAt > new Date()) {
          return;
        }
        await CampaignModel.updateOne(
          { _id: campaignId, status: 'scheduled' },
          { $set: { status: 'running', startedAt: c.startedAt ?? new Date() } }
        );
        continue;
      }

      if (c.status !== 'running') {
        return;
      }

      const session = await this.deps.sessionRepo.findByIdForUser(c.sessionId, c.userId);
      if (!session) {
        await this.deps.campaignRepo.updateById(campaignId, {
          status: 'failed',
          lastError: 'SESSION_NOT_FOUND',
          finishedAt: new Date(),
        });
        return;
      }

      const wa = this.deps.getWa();
      if (!wa.isConnected(session.publicId)) {
        const recipient = await this.deps.campaignRepo.claimNextPendingRecipient(campaignId);
        if (!recipient) {
          await this.maybeFinalize(campaignId);
          return;
        }
        const marked = await this.deps.campaignRepo.tryMarkRecipientFailed(
          recipient._id,
          'SESSION_OFFLINE'
        );
        if (marked) await this.deps.campaignRepo.incrementFailed(campaignId);
        await this.deps.campaignRepo.updateById(campaignId, {
          lastError: 'WhatsApp session offline; recipient marked failed',
        });
        const delayAfter = await this.reloadCampaign(campaignId);
        await this.sleep(delayAfter ? this.computeDelayMs(delayAfter) : 2000);
        continue;
      }

      await this.throttleHourlyLimit(campaignId, c.options.maxSendsPerHour);

      const mid = await this.reloadCampaign(campaignId);
      if (!mid || mid.status !== 'running') {
        return;
      }

      const recipient = await this.deps.campaignRepo.claimNextPendingRecipient(campaignId);
      if (!recipient) {
        await this.maybeFinalize(campaignId);
        return;
      }

      const msg = mid.message;
      const text = msg.text?.trim() || undefined;
      const urls = msg.imageUrls ?? [];

      try {
        await wa.sendCampaignPayload(session.publicId, recipient.to, text, urls);
        const ok = await this.deps.campaignRepo.tryMarkRecipientSent(recipient._id);
        if (ok) await this.deps.campaignRepo.incrementSent(campaignId);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        const ok = await this.deps.campaignRepo.tryMarkRecipientFailed(recipient._id, err);
        if (ok) await this.deps.campaignRepo.incrementFailed(campaignId);
        await this.deps.campaignRepo.updateById(campaignId, { lastError: err });
      }

      await this.maybeFinalize(campaignId);

      const after = await this.reloadCampaign(campaignId);
      if (!after || after.status !== 'running') return;

      await this.sleep(this.computeDelayMs(after));
    }
  }
}
