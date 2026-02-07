/**
 * Rate-limiting middleware using a sliding window counter.
 *
 * Keys requests by authenticated principal (`authClaims.sub`) or by IP
 * address for unauthenticated requests. The sliding window ensures that
 * bursty traffic near window boundaries is handled fairly.
 */

import type { Request, Response, NextFunction } from 'express';
import { RATE_LIMIT_RPM, RATE_LIMIT_WINDOW_MS } from '../constants.js';

interface WindowEntry {
  timestamps: number[];
}

/**
 * Create a rate-limiting middleware.
 *
 * @param maxRequests - Maximum requests allowed per window (default: RATE_LIMIT_RPM)
 * @param windowMs   - Sliding window duration in ms (default: RATE_LIMIT_WINDOW_MS)
 */
export function createRateLimitMiddleware(
  maxRequests: number = RATE_LIMIT_RPM,
  windowMs: number = RATE_LIMIT_WINDOW_MS
) {
  const counters = new Map<string, WindowEntry>();

  // Periodic cleanup of stale entries — .unref() prevents keeping process alive
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of counters) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
      if (entry.timestamps.length === 0) {
        counters.delete(key);
      }
    }
  }, windowMs);
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.authClaims?.sub ?? req.ip ?? 'unknown';
    const now = Date.now();

    let entry = counters.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      counters.set(key, entry);
    }

    // Slide the window: remove timestamps older than windowMs
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      // Calculate retry-after from the oldest timestamp in the window
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = windowMs - (now - oldestInWindow);
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('X-RateLimit-Limit', String(maxRequests));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfterSeconds,
      });
      return;
    }

    entry.timestamps.push(now);

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(maxRequests - entry.timestamps.length));

    next();
  };
}
