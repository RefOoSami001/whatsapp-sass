import { Response } from 'express';
import { AppError, toErrorResponse } from './errors.js';
import { logger } from './logger.js';

export function sendOk<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function sendError(res: Response, err: unknown) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(toErrorResponse(err));
  }
  logger.error({ err }, 'sendError');
  return res.status(500).json(toErrorResponse(err));
}
