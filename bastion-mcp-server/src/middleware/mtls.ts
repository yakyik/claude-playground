/**
 * mTLS authentication middleware.
 *
 * Extracts client certificate information from the TLS connection
 * and maps the certificate CN to auth claims. The server must be
 * configured with a CA certificate to validate client certs.
 */

import type { Request, Response, NextFunction } from 'express';
import type { TLSSocket } from 'node:tls';
import type { AuthClaims } from '../types.js';
import { logger } from '../services/logger.js';

export interface MtlsConfig {
  /** Whether mTLS is required (reject clients without certs) */
  required: boolean;
}

/**
 * Create mTLS authentication middleware.
 *
 * This middleware reads the peer certificate from the TLS socket
 * and extracts the Common Name (CN) as the authenticated subject.
 * The Express/Node server must be configured with `requestCert: true`
 * and a CA certificate for this to work.
 */
export function createMtlsMiddleware(config: MtlsConfig = { required: true }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const socket = req.socket as TLSSocket;

    // Check if this is actually a TLS connection
    if (typeof socket.getPeerCertificate !== 'function') {
      if (config.required) {
        logger.warn('mTLS required but connection is not TLS');
        res.status(401).json({ error: 'TLS connection required for mTLS authentication' });
        return;
      }
      next();
      return;
    }

    const cert = socket.getPeerCertificate();

    // No client cert presented
    if (!cert || !cert.subject) {
      if (config.required) {
        logger.warn('mTLS required but no client certificate presented');
        res.status(401).json({ error: 'Client certificate required' });
        return;
      }
      next();
      return;
    }

    // Check if the cert was actually authorized by our CA
    if (!socket.authorized) {
      const authError = socket.authorizationError;
      logger.warn('Client certificate not authorized', { error: String(authError) });
      res.status(403).json({
        error: 'Client certificate not authorized',
        detail: String(authError),
      });
      return;
    }

    // Extract claims from the certificate
    const claims: AuthClaims = {
      sub: cert.subject.CN ?? 'unknown',
      source: 'unknown',
      tools: [],
      exp: cert.valid_to
        ? new Date(cert.valid_to).toISOString()
        : new Date(Date.now() + 86400_000).toISOString(),
    };

    req.authClaims = claims;

    logger.debug('mTLS authentication succeeded', {
      cn: cert.subject.CN,
      issuer: cert.issuer?.CN,
    });

    next();
  };
}
