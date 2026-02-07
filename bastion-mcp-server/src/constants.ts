/**
 * Shared constants for the bastion MCP server.
 *
 * Centralizing these avoids magic numbers/strings scattered through the
 * codebase and makes it easy to tune operational parameters.
 */

/** Maximum character count for a single tool response before truncation */
export const CHARACTER_LIMIT = 50_000;

/** Default timeout for backend service requests (10 seconds) */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Default page size for tools that support pagination */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum page size to prevent accidentally huge responses */
export const MAX_PAGE_SIZE = 100;

/** Rate limit: max requests per minute per authenticated principal */
export const RATE_LIMIT_RPM = 60;

/** Rate limit window duration in milliseconds (1 minute) */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Server name used in MCP handshake if not overridden by config */
export const DEFAULT_SERVER_NAME = 'bastion-mcp-server';

/** Server version — should match package.json */
export const DEFAULT_SERVER_VERSION = '0.1.0';

/** Default port for the HTTP server */
export const DEFAULT_PORT = 3001;

/** Health check path (no auth required) */
export const HEALTH_CHECK_PATH = '/health';

/** MCP endpoint path */
export const MCP_ENDPOINT_PATH = '/mcp';
