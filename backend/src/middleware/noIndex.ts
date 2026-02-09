import { Request, Response, NextFunction } from 'express';

export function noIndexMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}
