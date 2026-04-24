import { RequestHandler } from 'express';

export function asyncRoute(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
