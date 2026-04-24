import { Types } from 'mongoose';
import { getConfig, type AppConfig } from './config/env.js';
import { logger } from './common/logger.js';
import { UserRepository } from './modules/users/user.repository.js';
import { SessionRepository } from './modules/sessions/session.repository.js';
import { ConversationMemoryRepository } from './modules/messages/conversation-memory.repository.js';
import { AiAgentRepository } from './modules/ai-agents/ai-agent.repository.js';
import { AuthService } from './modules/auth/auth.service.js';
import { WhatsAppSessionManager } from './modules/sessions/whatsapp-session.manager.js';
import { SessionsService } from './modules/sessions/sessions.service.js';
import { MessagesService } from './modules/messages/messages.service.js';
import { AiAgentsService } from './modules/ai-agents/ai-agents.service.js';
import { OpenRouterService } from './modules/ai-agents/openrouter.service.js';
import { AiReplyQueueService } from './queues/ai-reply-queue.service.js';
import { CampaignQueueService } from './queues/campaign-queue.service.js';
import { effectiveMemoryMessageCap } from './modules/messages/memory-cap.util.js';
import { CampaignRepository } from './modules/campaigns/campaign.repository.js';
import { CampaignService } from './modules/campaigns/campaign.service.js';

export type AppContainer = {
  config: AppConfig;
  logger: typeof logger;
  userRepo: UserRepository;
  sessionRepo: SessionRepository;
  memoryRepo: ConversationMemoryRepository;
  agentRepo: AiAgentRepository;
  authService: AuthService;
  wa: WhatsAppSessionManager;
  aiReplyQueue: AiReplyQueueService;
  campaignRepo: CampaignRepository;
  campaignQueue: CampaignQueueService;
  campaignService: CampaignService;
  sessionsService: SessionsService;
  messagesService: MessagesService;
  aiAgentsService: AiAgentsService;
  openRouterService: OpenRouterService;
};

export function createContainer(): AppContainer {
  const config = getConfig();
  const userRepo = new UserRepository();
  const sessionRepo = new SessionRepository();
  const memoryRepo = new ConversationMemoryRepository();
  const agentRepo = new AiAgentRepository();
  const authService = new AuthService(userRepo);
  const messagesService = new MessagesService(memoryRepo);
  const openRouterService = new OpenRouterService(() => config);

  const waSlot: { current?: WhatsAppSessionManager } = {};

  const campaignRepo = new CampaignRepository();
  const campaignQueue = new CampaignQueueService({
    campaignRepo,
    sessionRepo,
    getWa: () => waSlot.current!,
    getConfig: () => config,
  });
  const campaignService = new CampaignService(
    sessionRepo,
    campaignRepo,
    campaignQueue,
    () => config
  );

  const aiReplyQueue = new AiReplyQueueService({
    sessionRepo,
    agentRepo,
    memoryRepo,
    messagesService,
    openRouterService,
    getWa: () => waSlot.current!,
  });

  const wa = new WhatsAppSessionManager(sessionRepo, {
    onInboundChatMessage: async (ctx) => {
      logger.debug(
        { sessionPublicId: ctx.sessionPublicId, remoteJid: ctx.remoteJid, textPreview: ctx.text.slice(0, 80) },
        'Container received inbound message'
      );

      const session = await sessionRepo.findByPublicId(ctx.sessionPublicId);
      if (!session) {
        logger.warn({ sessionPublicId: ctx.sessionPublicId }, 'Inbound message ignored: session not found');
        return;
      }

      const agent = await agentRepo.findBySession(session._id);
      const memoryCap = effectiveMemoryMessageCap(agent);

      await messagesService.appendUserMessage(
        new Types.ObjectId(ctx.userId),
        session._id,
        ctx.remoteJid,
        ctx.text,
        memoryCap
      );
      logger.debug(
        { sessionId: session._id.toString(), remoteJid: ctx.remoteJid },
        'Enqueuing AI reply job (agent check in queue)'
      );
      aiReplyQueue.enqueue({
        sessionPublicId: ctx.sessionPublicId,
        userId: ctx.userId,
        remoteJid: ctx.remoteJid,
        text: ctx.text,
        ...(ctx.sourceMessageKey ? { sourceMessageKey: ctx.sourceMessageKey } : {}),
      });
    },
  });
  waSlot.current = wa;

  const sessionsService = new SessionsService(sessionRepo, wa, campaignRepo);
  const aiAgentsService = new AiAgentsService(agentRepo, sessionRepo);

  return {
    config,
    logger,
    userRepo,
    sessionRepo,
    memoryRepo,
    agentRepo,
    authService,
    wa,
    aiReplyQueue,
    campaignRepo,
    campaignQueue,
    campaignService,
    sessionsService,
    messagesService,
    aiAgentsService,
    openRouterService,
  };
}
