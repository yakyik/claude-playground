import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createToolScopeMiddleware } from '../tool-scope.js';
import type { Request, Response, NextFunction } from 'express';

function mockReq(body: unknown, authClaims?: { tools: string[] }): Partial<Request> {
  const req: Partial<Request> = { body };
  if (authClaims) {
    (req as Request).authClaims = {
      sub: 'test-user',
      source: 'unknown',
      exp: new Date(Date.now() + 86400_000).toISOString(),
      ...authClaims,
    };
  }
  return req;
}

function mockRes(): Partial<Response> & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: null as unknown,
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

describe('Tool-scope middleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  const middleware = createToolScopeMiddleware();

  it('empty tools array → allow all (next called)', () => {
    const req = mockReq(
      { method: 'tools/call', params: { name: 'anything' } },
      { tools: [] }
    );
    const res = mockRes();

    middleware(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('tool in allowed list → next called', () => {
    const req = mockReq(
      { method: 'tools/call', params: { name: 'bastion_db_query' } },
      { tools: ['bastion_db_query', 'bastion_api_request'] }
    );
    const res = mockRes();

    middleware(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('tool NOT in allowed list → 403 JSON-RPC error', () => {
    const req = mockReq(
      { method: 'tools/call', params: { name: 'bastion_db_query' }, id: 42 },
      { tools: ['bastion_api_request'] }
    );
    const res = mockRes();

    middleware(req as Request, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._json).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: "Token not authorized for tool 'bastion_db_query'",
      },
      id: 42,
    });
  });

  it('non-tools/call method (e.g. initialize) → next called', () => {
    const req = mockReq(
      { method: 'initialize', params: {} },
      { tools: ['bastion_db_query'] }
    );
    const res = mockRes();

    middleware(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('no authClaims on request → next called', () => {
    const req = mockReq(
      { method: 'tools/call', params: { name: 'bastion_db_query' } }
      // no authClaims
    );
    const res = mockRes();

    middleware(req as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
