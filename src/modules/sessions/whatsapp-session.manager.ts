import { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Types } from 'mongoose';
import { logger } from '../../common/logger.js';
import { useMongoAuthState, deleteMongoAuthState } from './mongo-auth-state.js';
import type { SessionRepository } from './session.repository.js';
import type { ISession } from './session.model.js';
import { extractDirectImageUrls, stripImageUrls } from './ai-reply-image-delivery.js';

/** Serializable WA message key for quoting / reactions (from `messages.upsert`). */
export type InboundSourceMessageKey = {
  remoteJid: string;
  id: string;
  fromMe: boolean;
  participant?: string;
};

function minimalQuotedMessage(key: InboundSourceMessageKey): WAMessage {
  return {
    key: {
      remoteJid: key.remoteJid,
      id: key.id,
      fromMe: key.fromMe,
      ...(key.participant ? { participant: key.participant } : {}),
    },
    message: {},
  } as WAMessage;
}

export type WaRuntimeHooks = {
  onInboundChatMessage: (ctx: {
    sessionPublicId: string;
    userId: string;
    sessionMongoId: string;
    remoteJid: string;
    text: string;
    sourceMessageKey?: InboundSourceMessageKey;
  }) => Promise<void>;
};

type Active = {
  socket: WASocket;
  saveCreds: () => Promise<void>;
  userId: string;
  sessionMongoId: string;
};

function unwrapBaileysMessage(message: unknown): any {
  let m: any = message;
  // Baileys wraps some payloads (ephemeral/viewOnce) one level deeper.
  for (let i = 0; i < 4; i++) {
    if (!m || typeof m !== 'object') break;
    const next =
      m?.ephemeralMessage?.message ??
      m?.viewOnceMessage?.message ??
      m?.viewOnceMessageV2?.message ??
      null;
    if (!next) break;
    m = next;
  }
  return m;
}

function extractInboundText(message: Record<string, unknown> | null | undefined): string {
  if (!message) return '';
  const m = unwrapBaileysMessage(message);

  const conv = typeof m.conversation === 'string' ? m.conversation : '';
  if (conv) return conv;

  const extended = m.extendedTextMessage;
  if (extended && typeof extended.text === 'string' && extended.text.trim()) return extended.text;

  if (typeof m.imageMessage?.caption === 'string' && m.imageMessage.caption.trim()) return m.imageMessage.caption;
  if (typeof m.videoMessage?.caption === 'string' && m.videoMessage.caption.trim()) return m.videoMessage.caption;
  if (typeof m.documentMessage?.caption === 'string' && m.documentMessage.caption.trim()) return m.documentMessage.caption;

  // Interactive replies (buttons/lists/templates)
  if (typeof m.buttonsResponseMessage?.selectedDisplayText === 'string' && m.buttonsResponseMessage.selectedDisplayText.trim()) {
    return m.buttonsResponseMessage.selectedDisplayText;
  }
  if (typeof m.listResponseMessage?.title === 'string' && m.listResponseMessage.title.trim()) {
    return m.listResponseMessage.title;
  }
  if (typeof m.templateButtonReplyMessage?.selectedDisplayText === 'string' && m.templateButtonReplyMessage.selectedDisplayText.trim()) {
    return m.templateButtonReplyMessage.selectedDisplayText;
  }

  return '';
}

function makeNonTextFallback(message: Record<string, unknown> | null | undefined): string {
  if (!message) return '[Non-text message received]';
  const m = unwrapBaileysMessage(message);
  if (!m || typeof m !== 'object') return '[Non-text message received]';
  const keys = Object.keys(m);
  const likelyType = keys[0] ? String(keys[0]) : 'unknown';
  return `[Non-text message received: ${likelyType}]`;
}

/**
 * Only these disconnect reasons should stop automatic reconnect.
 * Most idle / network / server drops use `connectionClosed` (428) — we must reconnect for those,
 * otherwise sessions appear "disconnected" until the user manually starts again.
 */
function shouldNotAutoReconnect(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return false;
  return (
    statusCode === DisconnectReason.loggedOut ||
    statusCode === DisconnectReason.badSession ||
    statusCode === DisconnectReason.forbidden ||
    statusCode === DisconnectReason.multideviceMismatch
  );
}

export class WhatsAppSessionManager {
  private readonly sockets = new Map<string, Active>();
  private readonly starting = new Set<string>();
  /** User called stop — do not auto-reconnect on socket close. */
  private readonly userRequestedStop = new Set<string>();
  /** Consecutive auto-reconnect attempts per session (reset on successful open). */
  private readonly reconnectAttempts = new Map<string, number>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly hooks: WaRuntimeHooks
  ) {}

  isConnected(publicId: string): boolean {
    const a = this.sockets.get(publicId);
    return !!a?.socket?.user;
  }

  getSocket(publicId: string): WASocket | undefined {
    return this.sockets.get(publicId)?.socket;
  }

  async startSession(session: ISession): Promise<void> {
    const publicId = session.publicId;
    this.userRequestedStop.delete(publicId);
    if (this.sockets.has(publicId) || this.starting.has(publicId)) return;
    this.starting.add(publicId);
    try {
      await this.sessions.updateById(session._id, { status: 'connecting', lastError: undefined });
      const { state, saveCreds } = await useMongoAuthState(session._id);
      const { version } = await fetchLatestBaileysVersion();
      const waLogger = logger.child({ waSession: publicId });
      const sock = makeWASocket({
        ...DEFAULT_CONNECTION_CONFIG,
        version,
        browser: Browsers.macOS('Chrome'),
        auth: state,
        logger: waLogger as unknown as typeof DEFAULT_CONNECTION_CONFIG.logger,
        printQRInTerminal: false,
        markOnlineOnConnect: true,
        /** Slightly more aggressive than default 30s to reduce idle server-side closes on long-lived Render processes. */
        keepAliveIntervalMs: 20_000,
      });

      this.sockets.set(publicId, {
        socket: sock,
        saveCreds,
        userId: session.userId.toString(),
        sessionMongoId: session._id.toString(),
      });

      const ctxBase = {
        sessionPublicId: publicId,
        userId: session.userId.toString(),
        sessionMongoId: session._id.toString(),
      };

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        const count = Array.isArray(messages) ? messages.length : 0;
        logger.debug({ publicId, waType: type, count }, 'WA messages.upsert received');

        for (const msg of messages ?? []) {
          const msgId = msg?.key?.id;
          const fromMe = Boolean(msg?.key?.fromMe);
          const remote = msg?.key?.remoteJid;

          if (fromMe) {
            logger.debug({ publicId, msgId, remote }, 'Skip WA message from bot (fromMe=true)');
            continue;
          }

          if (!remote) {
            logger.warn({ publicId, msgId }, 'WA message missing remoteJid - cannot reply');
            continue;
          }

          let normalizedRemote = remote;
          try {
            normalizedRemote = jidNormalizedUser(remote);
          } catch {
            // Keep original remote if normalization fails (e.g. unexpected jid format).
          }

          const extracted = extractInboundText(msg.message as Record<string, unknown>);
          const text = (extracted.trim() || makeNonTextFallback(msg.message as Record<string, unknown>)).trim();

          logger.debug(
            {
              publicId,
              msgId,
              waType: type,
              remote: normalizedRemote,
              textPreview: text.slice(0, 80),
            },
            'WA inbound message routed to AI hook'
          );

          const rawKey = msg.key;
          const sourceMessageKey: InboundSourceMessageKey | undefined =
            rawKey?.remoteJid && rawKey?.id
              ? {
                  remoteJid: rawKey.remoteJid,
                  id: rawKey.id,
                  fromMe: Boolean(rawKey.fromMe),
                  ...(rawKey.participant ? { participant: rawKey.participant } : {}),
                }
              : undefined;

          await this.hooks.onInboundChatMessage({
            ...ctxBase,
            remoteJid: normalizedRemote,
            text,
            ...(sourceMessageKey ? { sourceMessageKey } : {}),
          });
        }
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          await this.sessions.updateById(session._id, { status: 'qr_pending', qrCode: qr });
          logger.info({ publicId }, 'QR code generated - check API response to display');
        }
        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const active = this.sockets.get(publicId);
          if (active) {
            try {
              await active.saveCreds();
            } catch (e) {
              logger.warn({ e, publicId }, 'saveCreds on connection close failed');
            }
          }
          this.sockets.delete(publicId);

          if (this.userRequestedStop.has(publicId)) {
            this.userRequestedStop.delete(publicId);
            this.reconnectAttempts.delete(publicId);
            await this.sessions.updateById(session._id, {
              status: 'disconnected',
              lastError: lastDisconnect?.error?.message ?? 'stopped',
            });
            logger.info({ publicId }, 'WhatsApp closed after user stop');
            return;
          }

          if (!shouldNotAutoReconnect(statusCode)) {
            const prev = this.reconnectAttempts.get(publicId) ?? 0;
            const attempt = prev + 1;
            this.reconnectAttempts.set(publicId, attempt);
            await this.sessions.updateById(session._id, {
              status: 'connecting',
              lastError: undefined,
            });
            logger.info(
              { publicId, statusCode, attempt },
              'WhatsApp closed; auto-reconnecting (transient disconnect — creds preserved in MongoDB)'
            );
            const base =
              statusCode === DisconnectReason.restartRequired ? 2500 : statusCode === DisconnectReason.timedOut ? 3000 : 1500;
            const delayMs = Math.min(60_000, base * Math.pow(2, Math.min(attempt - 1, 5)));
            setTimeout(() => {
              void this.sessions.findByPublicId(publicId).then((s) => {
                if (!s) return;
                void this.startSession(s).catch((err) =>
                  logger.error({ err, publicId }, 'WA auto-reconnect failed')
                );
              });
            }, delayMs);
            return;
          }

          this.reconnectAttempts.delete(publicId);
          logger.warn({ publicId, statusCode }, 'WhatsApp connection closed (no auto-reconnect for this reason)');
          await this.sessions.updateById(session._id, {
            status: 'disconnected',
            lastError: lastDisconnect?.error?.message ?? 'closed',
          });
        } else if (connection === 'open') {
          this.reconnectAttempts.delete(publicId);
          const phone = sock.user?.id?.split(':')[0];
          const activeOpen = this.sockets.get(publicId);
          if (activeOpen) {
            try {
              await activeOpen.saveCreds();
            } catch (e) {
              logger.warn({ e, publicId }, 'saveCreds on connection open failed');
            }
          }
          await this.sessions.updateById(session._id, {
            status: 'connected',
            phoneNumber: phone,
            lastError: undefined,
          });
          logger.info({ publicId, phone }, 'WhatsApp session connected');
        }
      });
    } finally {
      this.starting.delete(publicId);
    }
  }

  async stopSession(publicId: string): Promise<void> {
    this.userRequestedStop.add(publicId);
    this.reconnectAttempts.delete(publicId);
    const a = this.sockets.get(publicId);
    if (!a) return;
    try {
      a.socket.end(undefined);
    } catch {
      /* ignore */
    }
    this.sockets.delete(publicId);
    const s = await this.sessions.findByPublicId(publicId);
    if (s) await this.sessions.updateById(s._id, { status: 'disconnected' });
  }

  async logoutAndDelete(session: ISession): Promise<void> {
    this.userRequestedStop.add(session.publicId);
    const a = this.sockets.get(session.publicId);
    if (a) {
      try {
        await a.socket.logout();
      } catch {
        try {
          a.socket.end(undefined);
        } catch {
          /* ignore */
        }
      }
      this.sockets.delete(session.publicId);
    }
    await deleteMongoAuthState(session._id);
  }

  private resolveRecipientJid(toPhoneOrJid: string): string {
    return toPhoneOrJid.includes('@')
      ? jidNormalizedUser(toPhoneOrJid)
      : `${toPhoneOrJid.replace(/\D/g, '')}@s.whatsapp.net`;
  }

  async sendText(
    publicId: string,
    toPhoneOrJid: string,
    text: string,
    sourceMessageKey?: InboundSourceMessageKey
  ): Promise<void> {
    const a = this.sockets.get(publicId);
    if (!a?.socket?.user) {
      throw new Error('SESSION_NOT_CONNECTED');
    }
    const jid = this.resolveRecipientJid(toPhoneOrJid);
    const quoted = sourceMessageKey ? minimalQuotedMessage(sourceMessageKey) : undefined;
    await a.socket.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
  }

  /**
   * Send an image from a public HTTPS URL (Baileys fetches server-side).
   */
  async sendImageFromUrl(
    publicId: string,
    toPhoneOrJid: string,
    url: string,
    caption?: string,
    sourceMessageKey?: InboundSourceMessageKey
  ): Promise<void> {
    const a = this.sockets.get(publicId);
    if (!a?.socket?.user) {
      throw new Error('SESSION_NOT_CONNECTED');
    }
    const jid = this.resolveRecipientJid(toPhoneOrJid);
    const cap = caption?.trim();
    const quoted = sourceMessageKey ? minimalQuotedMessage(sourceMessageKey) : undefined;
    await a.socket.sendMessage(
      jid,
      {
        image: { url },
        ...(cap ? { caption: cap } : {}),
      },
      quoted ? { quoted } : undefined
    );
  }

  /**
   * Bulk campaign payload: optional text; if image URLs are present, first image gets text as caption.
   */
  async sendCampaignPayload(
    publicId: string,
    toPhoneOrJid: string,
    text: string | undefined,
    imageUrls: string[]
  ): Promise<void> {
    const trimmed = text?.trim();
    const urls = imageUrls.filter(Boolean);
    if (urls.length === 0) {
      if (!trimmed) {
        throw new Error('EMPTY_CAMPAIGN_MESSAGE');
      }
      await this.sendText(publicId, toPhoneOrJid, trimmed);
      return;
    }
    await this.sendImageFromUrl(publicId, toPhoneOrJid, urls[0], trimmed || undefined);
    for (let i = 1; i < urls.length; i++) {
      await this.sendImageFromUrl(publicId, toPhoneOrJid, urls[i]);
    }
  }

  /**
   * If the reply contains direct image URLs, send image(s) via WhatsApp media instead of plain links.
   * On any failure, falls back to sending the full original text.
   */
  async sendAiReplyWithImages(
    publicId: string,
    toPhoneOrJid: string,
    reply: string,
    sourceMessageKey?: InboundSourceMessageKey
  ): Promise<void> {
    const urls = extractDirectImageUrls(reply);
    if (urls.length === 0) {
      await this.sendText(publicId, toPhoneOrJid, reply, sourceMessageKey);
      return;
    }

    logger.debug(
      { publicId, urlCount: urls.length, mode: urls.length === 1 ? 'single' : 'multi' },
      'AI reply: sending direct image URL(s) as media'
    );

    try {
      const stripped = stripImageUrls(reply);
      if (urls.length === 1) {
        await this.sendImageFromUrl(
          publicId,
          toPhoneOrJid,
          urls[0],
          stripped || undefined,
          sourceMessageKey
        );
        return;
      }
      if (stripped) {
        await this.sendText(publicId, toPhoneOrJid, stripped, sourceMessageKey);
      }
      for (const u of urls) {
        await this.sendImageFromUrl(publicId, toPhoneOrJid, u, undefined, sourceMessageKey);
      }
    } catch (e) {
      logger.warn(
        { publicId, err: String(e) },
        'AI reply image send failed; falling back to plain text with original reply'
      );
      await this.sendText(publicId, toPhoneOrJid, reply, sourceMessageKey);
    }
  }

  async sendReaction(
    publicId: string,
    toPhoneOrJid: string,
    target: InboundSourceMessageKey,
    emoji: string
  ): Promise<void> {
    const a = this.sockets.get(publicId);
    if (!a?.socket?.user) {
      throw new Error('SESSION_NOT_CONNECTED');
    }
    const jid = this.resolveRecipientJid(toPhoneOrJid);
    await a.socket.sendMessage(jid, {
      react: {
        text: emoji,
        key: {
          remoteJid: target.remoteJid,
          id: target.id,
          fromMe: target.fromMe,
          ...(target.participant ? { participant: target.participant } : {}),
        },
      },
    });
  }

  async sendTyping(publicId: string, toPhoneOrJid: string): Promise<void> {
    const a = this.sockets.get(publicId);
    if (!a?.socket?.user) {
      throw new Error('SESSION_NOT_CONNECTED');
    }
    const jid = this.resolveRecipientJid(toPhoneOrJid);
    
    // Send composition (typing) indicator
    await a.socket.sendPresenceUpdate('composing', jid);
  }

}
