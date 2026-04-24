import { Router } from 'express';
import { z } from 'zod';
import type { AppContainer } from '../../container.js';
import { sendOk, sendError } from '../../common/http.js';
import { asyncRoute } from '../async-route.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function authRouter(c: AppContainer): Router {
  const r = Router();

  r.post(
    '/register',
    asyncRoute(async (req, res) => {
      try {
        const body = registerSchema.parse(req.body);
        const out = await c.authService.register(body.email, body.password);
        sendOk(res, out, 201);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  r.post(
    '/login',
    asyncRoute(async (req, res) => {
      try {
        const body = loginSchema.parse(req.body);
        const out = await c.authService.login(body.email, body.password);
        sendOk(res, out);
      } catch (e) {
        sendError(res, e);
      }
    })
  );

  return r;
}
