import { Request, Response, NextFunction } from 'express';
import { AppError, toErrorResponse } from '../common/errors.js';
import { logger } from '../common/logger.js';

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(toErrorResponse(err));
  }
  logger.error({ err }, 'Unhandled error');
  return res.status(500).json(toErrorResponse(err));
}
