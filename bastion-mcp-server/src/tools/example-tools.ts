/**
 * Example tool registrations for the bastion MCP server.
 *
 * These tools demonstrate the core pattern: each tool receives a request
 * from Claude, validates it with Zod, routes it to a backend service
 * over the tailnet via the backend client, and returns the result.
 *
 * Every tool follows the same lifecycle:
 *   1. Start an audit context
 *   2. Call the backend service
 *   3. Format the response for Claude
 *   4. Finalize the audit (success or failure)
 *
 * To add your own tools, copy one of these and modify the schema,
 * description, and backend call. The audit + backend client plumbing
 * stays the same.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { createBackendClient } from '../services/backend.js';
import { startAudit } from '../services/audit.js';
import { CHARACTER_LIMIT } from '../constants.js';

type BackendClient = ReturnType<typeof createBackendClient>;

/**
 * Register all example tools on the given MCP server instance.
 *
 * This function is called once at startup. It's separated from the
 * server initialization so that tools can be organized into modules
 * (e.g., one file per domain: database tools, API tools, CI tools, etc.)
 * and composed together in index.ts.
 */
export function registerExampleTools(
  server: McpServer,
  backend: BackendClient
): void {
  registerDbQueryTool(server, backend);
  registerInternalApiTool(server, backend);
  registerHealthTool(server, backend);
}

// ─── Database Query Tool ────────────────────────────────────────────────────

/**
 * A read-only SQL query tool that proxies to an internal database service.
 *
 * The backend service is expected to accept POST requests with a JSON body
 * containing { sql, readOnly } and return the query results as JSON.
 * In practice, this would be a lightweight query proxy like pgREST,
 * PostgREST, or a custom service that enforces read-only execution.
 */
function registerDbQueryTool(server: McpServer, backend: BackendClient): void {
  server.registerTool(
    'bastion_db_query',
    {
      title: 'Query Internal Database',
      description: `Run a read-only SQL query against an internal analytics or metrics database.

This tool proxies SQL queries to internal database services reachable via the
bastion's tailnet. Only SELECT queries are permitted — the backend enforces
read-only mode and will reject any DDL or DML statements.

Args:
  - query (string): A SQL SELECT statement to execute
  - database (string): Which database to target — 'analytics' or 'metrics'

Returns:
  JSON object with { columns, rows, rowCount } on success.
  Error message with suggested corrections on failure.

Examples:
  - "How many events last week?" → query="SELECT COUNT(*) FROM events WHERE created_at > NOW() - INTERVAL '7 days'", database="analytics"
  - "Show me the top 10 metrics" → query="SELECT name, value FROM metrics ORDER BY value DESC LIMIT 10", database="metrics"

Notes:
  - Queries are capped at 30 seconds execution time by the backend.
  - Large result sets are truncated to fit within response limits.
  - The backend service enforces column-level access controls.`,
      inputSchema: {
        query: z.string()
          .min(1, 'Query cannot be empty')
          .max(5000, 'Query exceeds maximum length of 5000 characters')
          .describe('SQL SELECT query to execute'),
        database: z.enum(['analytics', 'metrics'])
          .describe('Target database: "analytics" for event/user data, "metrics" for time-series data'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, database }, extra) => {
      // The extra.authInfo is not available in standard MCP, so we pull
      // claims from the request context set by our auth middleware
      const audit = startAudit(
        'bastion_db_query',
        { query, database },
        extra._meta?.authClaims as import('../types.js').AuthClaims | undefined
      );

      try {
        // Map the logical database name to the backend service name.
        // These names must match entries in your service registry config.
        const serviceName = database === 'analytics'
          ? 'analytics-db'
          : 'metrics-db';

        const { data, host } = await backend.request(
          serviceName,
          '/query',
          {
            method: 'POST',
            body: JSON.stringify({ sql: query, readOnly: true }),
          }
        );

        // Format the response for Claude, truncating if needed
        const formatted = JSON.stringify(data, null, 2);
        const text = formatted.length > CHARACTER_LIMIT
          ? formatted.slice(0, CHARACTER_LIMIT) + '\n\n[... response truncated]'
          : formatted;

        audit.success(host, 200);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
        audit.failure(database, statusCode, message);

        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Error querying ${database}: ${message}`,
          }],
        };
      }
    }
  );
}

// ─── Internal API Tool ──────────────────────────────────────────────────────

/**
 * A general-purpose REST proxy for internal APIs on the tailnet.
 *
 * This tool lets Claude make authenticated requests to any registered
 * internal service. The service enum is derived from your config —
 * Claude can only reach services you've explicitly listed.
 */
function registerInternalApiTool(server: McpServer, backend: BackendClient): void {
  server.registerTool(
    'bastion_api_request',
    {
      title: 'Internal API Request',
      description: `Make authenticated HTTP requests to internal services via the bastion.

This tool proxies requests to internal REST APIs reachable over the bastion's
Tailscale mesh. Each service is identified by a logical name that maps to
a tailnet address in the bastion's service registry.

Args:
  - service (string): Logical service name — must match a registered backend
  - method (string): HTTP method — GET for reads, POST for writes
  - path (string): API path to append to the service's base URL (e.g., "/v1/users/123")
  - body (string, optional): JSON body for POST/PUT requests

Returns:
  The JSON response from the internal service, formatted for readability.

Examples:
  - "List all users" → service="users", method="GET", path="/v1/users"
  - "Get order 456" → service="inventory", method="GET", path="/v1/orders/456"
  - "Create a user" → service="users", method="POST", path="/v1/users", body='{"name":"Alice"}'

Notes:
  - Only services registered in the bastion's config are reachable.
  - The bastion adds its own authentication headers to backend requests.
  - Requests are subject to per-service timeout limits.`,
      inputSchema: {
        service: z.string()
          .min(1)
          .describe('Logical service name from the bastion registry (e.g., "users", "inventory", "billing")'),
        method: z.enum(['GET', 'POST', 'PUT', 'DELETE'])
          .describe('HTTP method for the request'),
        path: z.string()
          .min(1)
          .startsWith('/')
          .describe('API path starting with / (e.g., "/v1/users/123")'),
        body: z.string()
          .optional()
          .describe('JSON string body for POST/PUT requests'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,    // POST/PUT/DELETE can modify state
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ service, method, path, body }) => {
      const audit = startAudit('bastion_api_request', { service, method, path });

      try {
        const { data, host } = await backend.request(service, path, {
          method,
          ...(body ? { body } : {}),
        });

        const formatted = JSON.stringify(data, null, 2);
        const text = formatted.length > CHARACTER_LIMIT
          ? formatted.slice(0, CHARACTER_LIMIT) + '\n\n[... response truncated]'
          : formatted;

        audit.success(host, 200);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
        audit.failure(service, statusCode, message);

        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Error calling ${service}${path}: ${message}`,
          }],
        };
      }
    }
  );
}

// ─── Health / Connectivity Check Tool ───────────────────────────────────────

/**
 * A diagnostic tool that lets Claude check which backend services are
 * reachable. Useful for debugging connectivity issues or verifying that
 * the bastion's tailnet connection is working.
 */
function registerHealthTool(server: McpServer, backend: BackendClient): void {
  server.registerTool(
    'bastion_check_connectivity',
    {
      title: 'Check Backend Connectivity',
      description: `Check which internal services are reachable through the bastion.

Pings each registered backend service's health endpoint and reports
the status. Use this to diagnose connectivity issues or verify that
the bastion's Tailscale mesh is functioning correctly.

Args: None required.

Returns:
  A table showing each service's name, URL, and health status (ok/unreachable/error).`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const audit = startAudit('bastion_check_connectivity', {});

      try {
        const registry = backend.getRegistry();
        const entries = [...registry.entries()];

        if (entries.length === 0) {
          audit.success('bastion', 200);
          return {
            content: [{
              type: 'text',
              text: '# Backend Service Connectivity\n\nNo backend services configured.',
            }],
          };
        }

        const results = await Promise.allSettled(
          entries.map(async ([name, service]) => {
            const healthPath = service.healthCheckPath ?? '/health';
            const start = Date.now();
            try {
              const { status } = await backend.request(name, healthPath, { method: 'GET' });
              return { name, url: service.url, healthPath, status: `${status} OK`, latency: Date.now() - start };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              return { name, url: service.url, healthPath, status: `ERROR: ${msg}`, latency: Date.now() - start };
            }
          })
        );

        const rows = results.map((r) => {
          const val = r.status === 'fulfilled' ? r.value : { name: '?', url: '?', healthPath: '?', status: 'rejected', latency: 0 };
          return `| ${val.name} | ${val.url} | ${val.healthPath} | ${val.status} | ${val.latency}ms |`;
        });

        const table = [
          '# Backend Service Connectivity\n',
          '| Service | URL | Health Path | Status | Latency |',
          '|---------|-----|-------------|--------|---------|',
          ...rows,
        ].join('\n');

        audit.success('bastion', 200);
        return { content: [{ type: 'text', text: table }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        audit.failure('bastion', 500, message);
        return {
          isError: true,
          content: [{ type: 'text', text: `Connectivity check failed: ${message}` }],
        };
      }
    }
  );
}
