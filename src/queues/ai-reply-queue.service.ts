import PQueue from 'p-queue';
import { Types } from 'mongoose';
import { logger } from '../common/logger.js';
import { getConfig } from '../config/env.js';
import type { SessionRepository } from '../modules/sessions/session.repository.js';
import type { AiAgentRepository } from '../modules/ai-agents/ai-agent.repository.js';
import type { ConversationMemoryRepository } from '../modules/messages/conversation-memory.repository.js';
import type { MessagesService } from '../modules/messages/messages.service.js';
import type { OpenRouterService } from '../modules/ai-agents/openrouter.service.js';
import type {
  InboundSourceMessageKey,
  WhatsAppSessionManager,
} from '../modules/sessions/whatsapp-session.manager.js';
import { effectiveMemoryMessageCap } from '../modules/messages/memory-cap.util.js';
import { allowSend, aiRateKey, maxAiPerMinute } from '../infra/rate-limit.js';

export type AiJobData = {
  sessionPublicId: string;
  userId: string;
  remoteJid: string;
  text: string;
  /** Last inbound WA message key in this debounce window (for reply + reactions). */
  sourceMessageKey?: InboundSourceMessageKey;
};

export class AiReplyQueueService {
  // 🔥 تقليل الضغط
  private readonly q = new PQueue({ concurrency: 3 });

  private readonly debounceMs = getConfig().AI_DEBOUNCE_MS;
  private readonly debounceMaxBufferMsgs = getConfig().AI_DEBOUNCE_MAX_BUFFER_MSGS;
  private readonly debounceMaxWaitMs = getConfig().AI_DEBOUNCE_MAX_WAIT_MS;

  // 🔥 منع التكرار
  private readonly processedMessages = new Set<string>();

  private readonly pendingByChat = new Map<
    string,
    {
      data: Omit<AiJobData, 'text' | 'sourceMessageKey'>;
      fragments: string[];
      lastSourceMessageKey?: InboundSourceMessageKey;
      firstAt: number;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly deps: {
      sessionRepo: SessionRepository;
      agentRepo: AiAgentRepository;
      memoryRepo: ConversationMemoryRepository;
      messagesService: MessagesService;
      openRouterService: OpenRouterService;
      getWa: () => WhatsAppSessionManager;
    }
  ) {}

  // =========================
  // 🔑 Helpers
  // =========================

  private buildMessageKey(data: AiJobData): string {
    return `${data.sessionPublicId}:${data.remoteJid}:${data.text}`;
  }

  private estimateTypingTime(text: string): number {
    const base = 800;
    const perChar = 15;
    return Math.min(4000, base + text.length * perChar);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async safeSend(
    wa: WhatsAppSessionManager,
    sessionPublicId: string,
    remoteJid: string,
    text: string,
    sourceMessageKey: InboundSourceMessageKey | undefined,
    retries = 2
  ): Promise<void> {
    for (let i = 0; i <= retries; i++) {
      try {
        await wa.sendAiReplyWithImages(sessionPublicId, remoteJid, text, sourceMessageKey);
        return;
      } catch (e) {
        if (i === retries) throw e;
        await this.sleep(500 * (i + 1));
      }
    }
  }

  private async sendTypingIndicator(
    wa: WhatsAppSessionManager,
    sessionPublicId: string,
    remoteJid: string,
    durationMs: number
  ): Promise<void> {
    try {
      await wa.sendTyping(sessionPublicId, remoteJid);
      await this.sleep(durationMs);
    } catch (e) {
      logger.warn({ sessionPublicId, remoteJid }, 'Typing indicator failed');
    }
  }

  // =========================
  // 🔄 Debounce System
  // =========================

  enqueue(data: AiJobData): void {
    const key = `${data.sessionPublicId}:${data.remoteJid}`;
    const now = Date.now();

    const existing = this.pendingByChat.get(key);

    if (!existing) {
      const entry = {
        data: {
          sessionPublicId: data.sessionPublicId,
          userId: data.userId,
          remoteJid: data.remoteJid,
        },
        fragments: [data.text],
        lastSourceMessageKey: data.sourceMessageKey,
        firstAt: now,
      };

      this.pendingByChat.set(key, entry);
      this.scheduleFlush(key, this.debounceMs);
      return;
    }

    existing.fragments.push(data.text);
    if (data.sourceMessageKey) {
      existing.lastSourceMessageKey = data.sourceMessageKey;
    }

    const ageMs = now - existing.firstAt;
    const mustFlush =
      existing.fragments.length >= this.debounceMaxBufferMsgs ||
      ageMs >= this.debounceMaxWaitMs;

    if (mustFlush) {
      this.flushNow(key);
      return;
    }

    this.scheduleFlush(key, this.debounceMs);
  }

  private scheduleFlush(key: string, delayMs: number): void {
    const entry = this.pendingByChat.get(key);
    if (!entry) return;

    if (entry.timer) clearTimeout(entry.timer);

    entry.timer = setTimeout(() => this.flushNow(key), delayMs);
    entry.timer.unref?.();
  }

  private flushNow(key: string): void {
    const entry = this.pendingByChat.get(key);
    if (!entry) return;

    if (entry.timer) clearTimeout(entry.timer);

    this.pendingByChat.delete(key);

    const mergedText = this.mergeFragments(entry.fragments);
    if (!mergedText) return;

    void this.q.add(() =>
      this.process({
        ...entry.data,
        text: mergedText,
        sourceMessageKey: entry.lastSourceMessageKey,
      })
    );
  }

  private mergeFragments(fragments: string[]): string {
    const cleaned = fragments.map((s) => s.trim()).filter(Boolean);
    return cleaned.join(' ');
  }

  // =========================
  // 🧠 Main Processing
  // =========================

  private async process(data: AiJobData): Promise<void> {
    const { sessionPublicId, userId, remoteJid, text, sourceMessageKey } = data;

    // 🔥 deduplication
    const msgKey = this.buildMessageKey(data);
    if (this.processedMessages.has(msgKey)) return;

    this.processedMessages.add(msgKey);
    setTimeout(() => this.processedMessages.delete(msgKey), 60_000);

    const session = await this.deps.sessionRepo.findByPublicIdForUser(
      sessionPublicId,
      new Types.ObjectId(userId)
    );
    if (!session) return;

    const wa = this.deps.getWa();
    if (!wa.isConnected(sessionPublicId)) return;

    try {
      const agent = await this.deps.agentRepo.findBySessionForUser(
        session._id,
        new Types.ObjectId(userId)
      );

      if (!agent || !agent.enabled) return;

      // ⛔ Rate limit
      const rateKey = aiRateKey(session._id.toString());
      while (!allowSend(rateKey, maxAiPerMinute())) {
        await this.sleep(1000);
      }

      const memoryCap = effectiveMemoryMessageCap(agent);
      const history = await this.deps.memoryRepo.getRecent(
        session._id,
        remoteJid,
        memoryCap
      );

      // 🤖 Generate reply
      const reactionEmoji =
        typeof agent.reactionEmoji === 'string' && agent.reactionEmoji.trim()
          ? agent.reactionEmoji.trim()
          : '';

      if (reactionEmoji && sourceMessageKey) {
        try {
          await wa.sendReaction(sessionPublicId, remoteJid, sourceMessageKey, reactionEmoji);
        } catch (e) {
          logger.warn({ sessionPublicId, remoteJid, err: String(e) }, 'AI reaction send failed');
        }
      }

      const reply = await this.deps.openRouterService.generateReply({
        agent: {
          businessName: agent.businessName,
          businessDescription: agent.businessDescription,
          languagePreference: agent.languagePreference,
          toneOfVoice: agent.toneOfVoice,
          temperature: agent.temperature,
        },
        history,
        userMessage: text,
      });

      // ⌨️ realistic typing
      if (agent.typingIndicator?.enabled) {
        await this.sendTypingIndicator(
          wa,
          sessionPublicId,
          remoteJid,
          this.estimateTypingTime(reply)
        );
      }

      const cleanTextToSend = reply;

      // 💾 save message
      await this.deps.messagesService.appendAssistantMessage(
        new Types.ObjectId(userId),
        session._id,
        remoteJid,
        cleanTextToSend,
        memoryCap
      );

      // 📤 send safely
      await this.safeSend(
        wa,
        sessionPublicId,
        remoteJid,
        cleanTextToSend,
        sourceMessageKey
      );

      logger.info({ sessionPublicId, remoteJid }, 'AI reply sent');

    } catch (e) {
      logger.error(
        { sessionPublicId, remoteJid, error: String(e) },
        'AI processing error'
      );
    }
  }
}