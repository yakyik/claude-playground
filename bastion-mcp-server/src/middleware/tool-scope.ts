/**
 * Tool-scope authorization middleware.
 *
 * Enforces per-token tool authorization by checking the `tools` array
 * in the auth claims injected by the auth middleware. If the token only
 * authorizes specific tools, requests to other tools are rejected with
 * a JSON-RPC error.
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Create middleware that enforces tool-level authorization.
 *
 * Rules:
 *   - Non-`tools/call` requests pass through (e.g., `initialize`, `tools/list`)
 *   - If `authClaims.tools` is empty → all tools allowed (matches api-key behavior)
 *   - If `authClaims.tools` contains the requested tool name → allowed
 *   - Otherwise → 403 JSON-RPC error
 *   - If no authClaims on request (e.g., stdio transport) → pass through
 */
export function createToolScopeMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Only gate tools/call requests
    if (req.body?.method !== 'tools/call') {
      next();
      return;
    }

    // No auth claims = no restriction (stdio transport or pre-auth path)
    const claims = req.authClaims;
    if (!claims) {
      next();
      return;
    }

    // Empty tools array = authorized for all tools
    if (claims.tools.length === 0) {
      next();
      return;
    }

    const toolName = req.body?.params?.name as string | undefined;
    if (toolName && !claims.tools.includes(toolName)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: `Token not authorized for tool '${toolName}'`,
        },
        id: req.body?.id ?? null,
      });
      return;
    }

    next();
  };
}
