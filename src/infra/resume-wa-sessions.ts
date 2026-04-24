import { logger } from '../common/logger.js';
import type { AppContainer } from '../container.js';
import { sessionHasPersistedLogin } from '../modules/sessions/mongo-auth-state.js';

const RESUME_STATUSES = ['connected', 'connecting'] as const;

const STAGGER_MS = 800;

/**
 * After a server restart, Baileys sockets are gone but MongoDB still has session rows marked
 * connected and WA auth material. Re-open sockets so send / AI / sync work without calling POST /start again.
 */
export async function resumePersistedWhatsAppSessions(c: AppContainer): Promise<void> {
  const sessions = await c.sessionRepo.findAllByStatuses([...RESUME_STATUSES]);
  const toStart = [];
  for (const s of sessions) {
    if (await sessionHasPersistedLogin(s._id)) {
      toStart.push(s);
    }
  }
  if (!toStart.length) {
    logger.info('No persisted WhatsApp logins to resume on startup');
    return;
  }
  logger.info({ count: toStart.length }, 'Resuming WhatsApp sessions from Mongo auth (post-restart)');
  for (const session of toStart) {
    void c.wa.startSession(session).catch((err) =>
      logger.error({ err, publicId: session.publicId }, 'WA session resume on startup failed')
    );
    await new Promise((r) => setTimeout(r, STAGGER_MS));
  }
}
