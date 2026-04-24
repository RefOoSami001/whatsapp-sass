import { Router } from 'express';
import { z } from 'zod';
import type { AppContainer } from '../../container.js';
import { sendOk, sendError } from '../../common/http.js';
import { AppError } from '../../common/errors.js';
import { asyncRoute } from '../async-route.js';
import { requireAuth, type AuthedRequest } from '../../middleware/auth.middleware.js';
import { Types } from 'mongoose';
import { getConfig } from '../../config/env.js';

const createSchema = z.object({ label: z.string().optional() });

const sendMessageSchema = z.object({
  to: z.string().min(5).max(64),
  text: z.string().min(1).max(4096),
});

function isHttpsUrlString(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

const createCampaignSchema = z
  .object({
    recipients: z.array(z.string().min(5).max(64)).min(1),
    text: z.string().min(1).max(4096).optional(),
    imageUrls: z.array(z.string()).optional(),
    baseDelayMs: z.coerce.number().optional(),
    jitterMs: z.coerce.number().optional(),
    maxSendsPerHour: z.coerce.number().int().positive().optional(),
    scheduledAt: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const imgs = val.imageUrls ?? [];
    const t = val.text?.trim() ?? '';
    if (!t && imgs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide text and/or imageUrls',
      });
    }
    for (let i = 0; i < imgs.length; i++) {
      if (!isHttpsUrlString(imgs[i])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Each imageUrls entry must be a valid https URL',
          path: ['imageUrls', i],
        });
      }
    }
  });

const campaignListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const agentPutSchema = z.object({
  businessName: z.string().min(1).max(500),
  businessDescription: z.string().min(1).max(8000),
  languagePreference: z.string().min(2).max(32),
  toneOfVoice: z.string().min(2).max(80),
  enabled: z.boolean(),
  memoryMessageLimit: z
    .coerce
    .number()
    .int()
    .min(1)
    .max(getConfig().AI_MEMORY_MAX_MESSAGES),
  temperature: z.coerce.number().min(0.0).max(2.0).default(0.7),
  reactionEmoji: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === null) return null;
      const t = v.trim();
      return t.length ? t.slice(0, 32) : null;
    }),
  typingIndicator: z
    .object({
      enabled: z.boolean(),
      typingDurationMs: z.coerce.number().int().min(100).max(3000).optional(),
    })
    .refine((v) => (v.enabled ? v.typingDurationMs !== undefined : true), {
      message: 'typingDurationMs is required when typingIndicator.enabled is true',
    })
    .transform((v) => ({
      enabled: v.enabled,
      typingDurationMs: v.typingDurationMs ?? 1000,
    })),
});

const agentPatchSchema = z
  .object({
    businessName: z.string().min(1).max(500).optional(),
    businessDescription: z.string().min(1).max(8000).optional(),
    languagePreference: z.string().min(2).max(32).optional(),
    toneOfVoice: z.string().min(2).max(80).optional(),
    enabled: z.boolean().optional(),
    memoryMessageLimit: z
      .coerce
      .number()
      .int()
      .min(1)
      .max(getConfig().AI_MEMORY_MAX_MESSAGES)
      .optional(),
    temperature: z.coerce.number().min(0.0).max(2.0).optional(),
    reactionEmoji: z
      .union([z.string(), z.literal(''), z.null()])
      .optional()
      .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        const t = v.trim();
        return t.length ? t.slice(0, 32) : null;
      }),
    typingIndicator: z
      .object({
        enabled: z.boolean().optional(),
        typingDurationMs: z.coerce.number().int().min(100).max(3000).optional(),
      })
      .refine((v) => Object.keys(v).length > 0, {
        message: 'typingIndicator: pass at least one of enabled, typingDurationMs',
      })
      .refine((v) => (v.enabled === true ? v.typingDurationMs !== undefined : true), {
        message: 'typingDurationMs is required when typingIndicator.enabled is true',
      })
      .optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'At least one field is required' });

function mapSession(s: {
  publicId: string;
  status: string;
  phoneNumber?: string;
  label?: string;
  qrCode?: string;
  createdAt?: Date;
}) {
  return {
    sessionId: s.publicId,
    status: s.status,
    phoneNumber: s.phoneNumber,
    label: s.label,
    qrCode: s.qrCode,
    createdAt: s.createdAt,
  };
}

export function sessionsRouter(c: AppContainer): Router {
  const r = Router();
  r.use(requireAuth);

  r.post(
    '/',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const body = createSchema.parse(req.body);
        const s = await c.sessionsService.create(new Types.ObjectId(req.userId!), body.label);
        sendOk(res, mapSession(s), 201);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.get(
    '/',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const list = await c.sessionsService.list(new Types.ObjectId(req.userId!));
        sendOk(res, list.map(mapSession));
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.get(
    '/:publicId/ai-agent',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const out = await c.aiAgentsService.getForSession(
          new Types.ObjectId(req.userId!),
          req.params.publicId
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.put(
    '/:publicId/ai-agent',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const body = agentPutSchema.parse(req.body);
        const out = await c.aiAgentsService.upsertForSession(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          body
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.patch(
    '/:publicId/ai-agent',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const body = agentPatchSchema.parse(req.body);
        const out = await c.aiAgentsService.patchForSession(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          body
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.delete(
    '/:publicId/ai-agent',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        await c.aiAgentsService.deleteForSession(
          new Types.ObjectId(req.userId!),
          req.params.publicId
        );
        sendOk(res, { ok: true });
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.post(
    '/:publicId/send',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const body = sendMessageSchema.parse(req.body);
        await c.sessionsService.sendMessage(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          body.to,
          body.text
        );
        sendOk(res, { ok: true });
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.post(
    '/:publicId/campaigns',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const body = createCampaignSchema.parse(req.body);
        const out = await c.campaignService.create(new Types.ObjectId(req.userId!), req.params.publicId, body);
        sendOk(res, out, 201);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.get(
    '/:publicId/campaigns',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const q = campaignListQuerySchema.parse(req.query);
        const out = await c.campaignService.list(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          q.page,
          q.pageSize
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.get(
    '/:publicId/campaigns/:campaignPublicId',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const out = await c.campaignService.get(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          req.params.campaignPublicId
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.post(
    '/:publicId/campaigns/:campaignPublicId/pause',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const out = await c.campaignService.pause(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          req.params.campaignPublicId
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.post(
    '/:publicId/campaigns/:campaignPublicId/resume',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const out = await c.campaignService.resume(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          req.params.campaignPublicId
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.post(
    '/:publicId/campaigns/:campaignPublicId/cancel',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const out = await c.campaignService.cancel(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          req.params.campaignPublicId
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.delete(
    '/:publicId/campaigns/:campaignPublicId',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const out = await c.campaignService.remove(
          new Types.ObjectId(req.userId!),
          req.params.publicId,
          req.params.campaignPublicId
        );
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.get(
    '/:publicId',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const s = await c.sessionsService.get(new Types.ObjectId(req.userId!), req.params.publicId);
        sendOk(res, mapSession(s));
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.post(
    '/:publicId/start',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const result = await c.sessionsService.start(new Types.ObjectId(req.userId!), req.params.publicId);
        const s = await c.sessionsService.get(new Types.ObjectId(req.userId!), req.params.publicId);
        sendOk(res, {
          session: mapSession(s),
          qrCode: result.qrCode,
        });
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.post(
    '/:publicId/stop',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        await c.sessionsService.stop(new Types.ObjectId(req.userId!), req.params.publicId);
        sendOk(res, { ok: true });
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.delete(
    '/:publicId',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        await c.sessionsService.delete(new Types.ObjectId(req.userId!), req.params.publicId);
        sendOk(res, { ok: true });
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  return r;
}
