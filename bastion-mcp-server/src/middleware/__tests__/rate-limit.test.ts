import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimitMiddleware } from '../rate-limit.js';
import type { Request, Response, NextFunction } from 'express';

function mockReq(sub?: string): Partial<Request> {
  const req: Partial<Request> = { ip: '127.0.0.1' };
  if (sub) {
    (req as Request).authClaims = {
      sub,
      source: 'unknown',
      tools: [],
      exp: new Date(Date.now() + 86400_000).toISOString(),
    };
  }
  return req;
}

function mockRes(): Partial<Response> & {
  _status: number;
  _json: unknown;
  _headers: Record<string, string>;
} {
  const res = {
    _status: 0,
    _json: null as unknown,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res as unknown as Response;
    },
    status(code: number) {
      res._status = code;
      return res as unknown as Response;
    },
    json(body: unknown) {
      res._json = body;
      return res as unknown as Response;
    },
  };
  return res;
}

describe('Rate limit middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    vi.useFakeTimers();
    next = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('N requests within limit → all pass', () => {
    const maxRequests = 3;
    const middleware = createRateLimitMiddleware(maxRequests, 60_000);

    for (let i = 0; i < maxRequests; i++) {
      const req = mockReq('user-a');
      const res = mockRes();
      middleware(req as Request, res as unknown as Response, next);
    }

    expect(next).toHaveBeenCalledTimes(maxRequests);
  });

  it('N+1 request → 429 with Retry-After header', () => {
    const maxRequests = 3;
    const middleware = createRateLimitMiddleware(maxRequests, 60_000);

    // Exhaust the limit
    for (let i = 0; i < maxRequests; i++) {
      const req = mockReq('user-b');
      const res = mockRes();
      middleware(req as Request, res as unknown as Response, next);
    }

    // N+1 should be rate limited
    const req = mockReq('user-b');
    const res = mockRes();
    middleware(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(maxRequests); // not maxRequests+1
    expect(res._status).toBe(429);
    expect(res._headers['Retry-After']).toBeDefined();
    expect(res._headers['X-RateLimit-Remaining']).toBe('0');
  });

  it('after window expires → allowed again', () => {
    const maxRequests = 2;
    const windowMs = 60_000;
    const middleware = createRateLimitMiddleware(maxRequests, windowMs);

    // Exhaust the limit
    for (let i = 0; i < maxRequests; i++) {
      const req = mockReq('user-c');
      const res = mockRes();
      middleware(req as Request, res as unknown as Response, next);
    }

    expect(next).toHaveBeenCalledTimes(maxRequests);

    // Advance past the window
    vi.advanceTimersByTime(windowMs + 1);

    // Should be allowed again
    const req = mockReq('user-c');
    const res = mockRes();
    middleware(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(maxRequests + 1);
  });

  it('different principals → isolated counters', () => {
    const maxRequests = 1;
    const middleware = createRateLimitMiddleware(maxRequests, 60_000);

    // User A
    const reqA = mockReq('user-x');
    const resA = mockRes();
    middleware(reqA as Request, resA as unknown as Response, next);

    // User B (different principal)
    const reqB = mockReq('user-y');
    const resB = mockRes();
    middleware(reqB as Request, resB as unknown as Response, next);

    // Both should pass (isolated counters)
    expect(next).toHaveBeenCalledTimes(2);
  });
});
