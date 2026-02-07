/**
 * Authentication middleware for the bastion MCP server.
 *
 * This is the first line of defense after TLS termination (handled by
 * Caddy/nginx in front of us). Every request to the /mcp endpoint must
 * pass through this middleware before reaching the MCP tool handlers.
 *
 * The middleware supports two strategies:
 *
 * 1. API Key: The simplest option. A shared secret in the Authorization
 *    header. Good for single-tenant setups where you trust the caller.
 *
 * 2. JWT: A signed token with scoped claims. The token can restrict which
 *    tools the caller is allowed to invoke and which Claude surface the
 *    request originates from. This is the recommended strategy for
 *    production deployments.
 *
 * Both strategies inject AuthClaims into the Express Request object
 * so that downstream handlers can check authorization without re-parsing.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthConfig, AuthClaims } from '../types.js';
import { logger } from '../services/logger.js';

/**
 * Create an Express middleware function configured with the given auth strategy.
 *
 * This factory pattern lets us build the middleware once at startup (when we
 * know the config) and then attach it to the Express app without closures
 * over mutable state.
 */
export function createAuthMiddleware(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      logger.warn('Request missing Authorization header', {
        ip: req.ip,
        path: req.path,
      });
      res.status(401).json({
        error: 'Missing Authorization header',
        hint: 'Include "Authorization: Bearer <token>" in your request headers.',
      });
      return;
    }

    const token = authHeader.replace(/^Bearer\s+/i, '');

    if (!token || token === authHeader) {
      res.status(401).json({
        error: 'Malformed Authorization header',
        hint: 'Use the format "Bearer <token>".',
      });
      return;
    }

    try {
      if (config.strategy === 'jwt') {
        req.authClaims = validateJwt(token, config);
      } else {
        req.authClaims = validateApiKey(token, config);
      }
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      logger.warn('Authentication failed', {
        ip: req.ip,
        reason: message,
      });
      res.status(403).json({ error: message });
    }
  };
}

/**
 * Validate a JWT token and extract claims.
 *
 * The JWT must include:
 *   - sub: who is making the request
 *   - tools: array of tool names the token is authorized for (empty = all)
 *   - source: which Claude surface originated this (optional, defaults to 'unknown')
 *
 * We verify the signature, expiration, and issuer. If any check fails,
 * we throw with a specific error message so the caller knows what went wrong.
 */
function validateJwt(token: string, config: AuthConfig): AuthClaims {
  if (!config.jwtSecret) {
    throw new Error('JWT secret not configured on server');
  }

  const decoded = jwt.verify(token, config.jwtSecret, {
    issuer: config.jwtIssuer,
  }) as Record<string, unknown>;

  // Extract and validate required claims
  const sub = typeof decoded.sub === 'string' ? decoded.sub : 'unknown';
  const tools = Array.isArray(decoded.tools)
    ? (decoded.tools as string[])
    : [];
  const source = typeof decoded.source === 'string'
    ? (decoded.source as AuthClaims['source'])
    : 'unknown';
  const exp = typeof decoded.exp === 'number'
    ? new Date(decoded.exp * 1000).toISOString()
    : new Date(Date.now() + 3600_000).toISOString();

  return { sub, source, tools, exp, scope: decoded.scope as string | undefined };
}

/**
 * Validate a simple API key.
 *
 * For the API key strategy, all authenticated callers get the same
 * permissions (all tools, no scoping). This is simpler but less granular
 * than JWT. Use it for small teams or development environments.
 */
function validateApiKey(token: string, config: AuthConfig): AuthClaims {
  if (!config.apiKey) {
    throw new Error('API key not configured on server');
  }

  // Constant-time comparison to prevent timing attacks.
  // We compare SHA-256 hashes of equal length via timingSafeEqual,
  // which avoids leaking info about which characters matched.
  const expectedHash = createHash('sha256').update(config.apiKey).digest();
  const providedHash = createHash('sha256').update(token).digest();

  if (!timingSafeEqual(expectedHash, providedHash)) {
    throw new Error('Invalid API key');
  }

  return {
    sub: 'api-key-user',
    source: 'unknown',
    tools: [], // Empty = authorized for all tools
    exp: new Date(Date.now() + 86400_000).toISOString(), // 24h nominal expiry
  };
}
