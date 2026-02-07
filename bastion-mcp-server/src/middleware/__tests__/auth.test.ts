import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { createAuthMiddleware } from '../auth.js';
import type { AuthConfig } from '../../types.js';
import type { Request, Response, NextFunction } from 'express';

// Suppress logger output during tests
vi.mock('../../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function mockReq(headers: Record<string, string> = {}): Partial<Request> {
  return {
    headers,
    ip: '127.0.0.1',
    path: '/mcp',
  };
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

describe('Auth middleware', () => {
  const jwtSecret = 'test-secret-key-for-tests';
  const jwtIssuer = 'bastion-mcp-server';
  const apiKey = 'test-api-key-12345';

  const jwtConfig: AuthConfig = {
    strategy: 'jwt',
    jwtSecret,
    jwtIssuer,
  };

  const apiKeyConfig: AuthConfig = {
    strategy: 'api-key',
    apiKey,
  };

  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  // ── API Key tests ──

  it('valid API key → sets authClaims with sub "api-key-user" and calls next()', () => {
    const middleware = createAuthMiddleware(apiKeyConfig);
    const req = mockReq({ authorization: `Bearer ${apiKey}` }) as Request;
    const res = mockRes();

    middleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.authClaims).toBeDefined();
    expect(req.authClaims!.sub).toBe('api-key-user');
    expect(req.authClaims!.tools).toEqual([]);
  });

  it('wrong API key → 403', () => {
    const middleware = createAuthMiddleware(apiKeyConfig);
    const req = mockReq({ authorization: 'Bearer wrong-key' }) as Request;
    const res = mockRes();

    middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  // ── JWT tests ──

  it('valid JWT → extracts sub, tools, source from claims', () => {
    const token = jwt.sign(
      { sub: 'test-user', tools: ['bastion_db_query'], source: 'claude-code' },
      jwtSecret,
      { issuer: jwtIssuer, expiresIn: '1h' }
    );
    const middleware = createAuthMiddleware(jwtConfig);
    const req = mockReq({ authorization: `Bearer ${token}` }) as Request;
    const res = mockRes();

    middleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.authClaims).toBeDefined();
    expect(req.authClaims!.sub).toBe('test-user');
    expect(req.authClaims!.tools).toEqual(['bastion_db_query']);
    expect(req.authClaims!.source).toBe('claude-code');
  });

  it('expired JWT → 403', () => {
    const token = jwt.sign(
      { sub: 'test-user', tools: [] },
      jwtSecret,
      { issuer: jwtIssuer, expiresIn: '-10s' }
    );
    const middleware = createAuthMiddleware(jwtConfig);
    const req = mockReq({ authorization: `Bearer ${token}` }) as Request;
    const res = mockRes();

    middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('JWT signed with wrong secret → 403', () => {
    const token = jwt.sign(
      { sub: 'test-user', tools: [] },
      'wrong-secret',
      { issuer: jwtIssuer, expiresIn: '1h' }
    );
    const middleware = createAuthMiddleware(jwtConfig);
    const req = mockReq({ authorization: `Bearer ${token}` }) as Request;
    const res = mockRes();

    middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  // ── Missing/malformed header tests ──

  it('missing Authorization header → 401', () => {
    const middleware = createAuthMiddleware(jwtConfig);
    const req = mockReq({}) as Request;
    const res = mockRes();

    middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });

  it('malformed Bearer → 401', () => {
    const middleware = createAuthMiddleware(jwtConfig);
    const req = mockReq({ authorization: 'Basic abc123' }) as Request;
    const res = mockRes();

    middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});
