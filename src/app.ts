import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { IncomingMessage } from 'http';
import type { AppContainer } from './container.js';
import { logger } from './common/logger.js';
import { errorMiddleware } from './middleware/error.middleware.js';
import { authRouter } from './http/routes/auth.routes.js';
import { sessionsRouter } from './http/routes/sessions.routes.js';
import { aiAgentsRouter } from './http/routes/ai-agents.routes.js';

export function createApp(container: AppContainer): express.Application {
  const app = express();

  // Trust proxy headers (important for Render.com)
  app.set('trust proxy', 1);

  // Helmet security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
    })
  );

  // CORS configuration - production safe
  const corsOptions = {
    // Allow all origins by default (Render frontend can be on a different domain).
    // NOTE: `credentials: true` is incompatible with `origin: '*'` in browsers.
    origin: '*',
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
    maxAge: 86400, // 24 hours
  };

  app.use(cors(corsOptions));

  // Body parsing
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ limit: '2mb', extended: true }));

  // Request timeout (30 seconds)
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.setTimeout(30000);
    res.setTimeout(30000);
    next();
  });

  // HTTP logging with Pino
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req: IncomingMessage) => {
          const u = req.url ?? '';
          return u === '/health' || u === '/';
        },
      },
    })
  );

  // Health check endpoint (used by Render.com)
  app.get('/health', (_req: Request, res: Response) =>
    res.json({ ok: true, timestamp: new Date().toISOString() })
  );

  // Root endpoint
  app.get('/', (_req: Request, res: Response) =>
    res.json({
      ok: true,
      name: 'whatsapp-ai-saas-backend',
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      health: '/health',
      api: '/api',
    })
  );

  // API routes
  app.use('/api/auth', authRouter(container));
  app.use('/api/sessions', sessionsRouter(container));
  app.use('/api/ai-agents', aiAgentsRouter(container));

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
      },
    });
  });

  // Global error handler
  app.use(errorMiddleware);

  return app;
}
