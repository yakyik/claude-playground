/**
 * Audit service for the bastion MCP server.
 *
 * Every MCP tool invocation flows through here. The audit service captures
 * structured metadata about each request — who called what, from where,
 * how long it took, and whether it succeeded — then ships it to the
 * logger for aggregation.
 *
 * This is the primary observability layer for the bastion. It's designed
 * to answer questions like:
 *   - "Who ran that db_query at 3am?"
 *   - "How many tool calls did the billing-api handle last hour?"
 *   - "What's the p99 latency for internal_api calls?"
 *
 * The audit entries are intentionally flat (no nested objects) so they're
 * easy to index and query in log aggregation systems.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AuditEntry, AuthClaims } from '../types.js';
import { logger } from './logger.js';

/**
 * Start a new audit context for a tool invocation.
 *
 * Call this when a tool handler begins execution. It captures the start
 * time and returns a finalize function that you call when the handler
 * completes (or errors). The finalize function computes the duration
 * and emits the audit log entry.
 *
 * Usage:
 *   const audit = startAudit('db_query', { query: 'SELECT ...' }, claims);
 *   try {
 *     const result = await executeQuery(...);
 *     audit.success('analytics-db.tail1234.ts.net', 200);
 *     return result;
 *   } catch (err) {
 *     audit.failure('analytics-db.tail1234.ts.net', 500, err.message);
 *     throw err;
 *   }
 */
export function startAudit(
  tool: string,
  inputs: Record<string, unknown>,
  claims?: AuthClaims
) {
  const requestId = uuidv4();
  const startTime = Date.now();

  // Sanitize inputs: redact anything that looks like a secret
  const sanitized = sanitizeInputs(inputs);

  function emit(
    backendHost: string,
    responseCode: number,
    error?: string
  ): AuditEntry {
    const entry: AuditEntry = {
      timestamp: new Date(startTime).toISOString(),
      requestId,
      tool,
      inputs: sanitized,
      source: claims?.source ?? 'unknown',
      userId: claims?.sub ?? 'anonymous',
      backendHost,
      responseCode,
      durationMs: Date.now() - startTime,
      ...(error ? { error } : {}),
    };

    // Log at 'info' level for successful invocations, 'warn' for failures
    if (error) {
      logger.warn('Tool invocation failed', { audit: entry });
    } else {
      logger.info('Tool invocation succeeded', { audit: entry });
    }

    return entry;
  }

  return {
    requestId,
    /** Call when the tool invocation succeeds */
    success: (backendHost: string, responseCode: number) =>
      emit(backendHost, responseCode),
    /** Call when the tool invocation fails */
    failure: (backendHost: string, responseCode: number, error: string) =>
      emit(backendHost, responseCode, error),
  };
}

/**
 * Redact values that look like secrets from the audit log.
 *
 * This is a best-effort heuristic — it catches common patterns like
 * API keys, passwords, and tokens. For production deployments, you may
 * want to extend this with a more sophisticated PII detection library.
 */
function sanitizeInputs(
  inputs: Record<string, unknown>
): Record<string, unknown> {
  const sensitivePatterns = [
    /password/i,
    /secret/i,
    /token/i,
    /api[_-]?key/i,
    /auth/i,
    /credential/i,
    /private[_-]?key/i,
  ];

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(inputs)) {
    const isSensitive = sensitivePatterns.some((pattern) => pattern.test(key));
    sanitized[key] = isSensitive ? '[REDACTED]' : value;
  }

  return sanitized;
}
