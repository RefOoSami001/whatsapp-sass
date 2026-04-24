import { Router } from 'express';
import type { AppContainer } from '../../container.js';
import { sendOk, sendError } from '../../common/http.js';
import { asyncRoute } from '../async-route.js';
import { requireAuth, type AuthedRequest } from '../../middleware/auth.middleware.js';
import { Types } from 'mongoose';

/** List all AI agents (one per session) for the authenticated user. */
export function aiAgentsRouter(c: AppContainer): Router {
  const r = Router();
  r.use(requireAuth);

  r.get(
    '/',
    asyncRoute(async (req: AuthedRequest, res) => {
      try {
        const list = await c.aiAgentsService.listForUser(new Types.ObjectId(req.userId!));
        sendOk(res, list);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  return r;
}
