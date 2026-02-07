#!/usr/bin/env node

/**
 * Bastion MCP Server — Main Entry Point
 *
 * This file is the orchestration layer. It wires together:
 *   - Configuration loading (env vars, config file)
 *   - The Express HTTP server with auth middleware
 *   - The MCP server with Streamable HTTP transport
 *   - The backend client bound to the service registry
 *   - Tool registration from the tools/ directory
 *
 * The server supports two transport modes:
 *   - HTTP (default): Streamable HTTP for remote access from Claude.ai
 *     sandboxes and API containers. This is the primary use case.
 *   - stdio: For local development and testing with Claude Code.
 *
 * Set TRANSPORT=stdio to switch to stdio mode.
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config/loader.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';
import { createToolScopeMiddleware } from './middleware/tool-scope.js';
import { createBackendClient, buildRegistry } from './services/backend.js';
import { registerExampleTools } from './tools/example-tools.js';
import { registerExecTools } from './tools/exec-tools.js';
import { logger } from './services/logger.js';
import { HEALTH_CHECK_PATH, MCP_ENDPOINT_PATH } from './constants.js';

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load configuration from env vars and optional config file
  const config = loadConfig();
  logger.info('Configuration loaded', {
    serverName: config.serverName,
    authStrategy: config.auth.strategy,
    serviceCount: config.services.length,
    transport: process.env.TRANSPORT ?? 'http',
  });

  // 2. Build the service registry and backend client
  const registry = buildRegistry(config.services);
  const backend = createBackendClient(registry);

  // 3. Run health checks against all registered backends (non-blocking)
  backend.healthCheckAll().catch((err) => {
    logger.warn('Health check sweep encountered errors', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // 4. Create the MCP server and register tools
  const mcpServer = new McpServer({
    name: config.serverName,
    version: config.serverVersion,
  });

  registerExampleTools(mcpServer, backend);
  registerExecTools(mcpServer, backend);
  logger.info('MCP tools registered');

  // 5. Start the appropriate transport
  const transport = process.env.TRANSPORT ?? 'http';
  if (transport === 'stdio') {
    await runStdio(mcpServer);
  } else {
    await runHttp(mcpServer, config);
  }
}

// ─── HTTP Transport (Primary) ───────────────────────────────────────────────

/**
 * Start the Express server with Streamable HTTP transport.
 *
 * This is the production path. The server exposes:
 *   - POST /mcp — The MCP Streamable HTTP endpoint (auth required)
 *   - GET /health — Health check (no auth required)
 *
 * In production, this sits behind Caddy or nginx which handles TLS
 * termination. The Express server itself listens on HTTP only.
 */
async function runHttp(mcpServer: McpServer, config: ReturnType<typeof loadConfig>): Promise<void> {
  const app = express();
  app.use(express.json());

  // Health check endpoint — no auth, used by load balancers and monitoring
  app.get(HEALTH_CHECK_PATH, (_req, res) => {
    res.json({
      status: 'ok',
      server: config.serverName,
      version: config.serverVersion,
      timestamp: new Date().toISOString(),
    });
  });

  // Middleware chain on the MCP endpoint: auth → rate limit → tool scope
  const authMiddleware = createAuthMiddleware(config.auth);
  const rateLimitMiddleware = createRateLimitMiddleware();
  const toolScopeMiddleware = createToolScopeMiddleware();

  // MCP Streamable HTTP endpoint — auth required
  //
  // Each request gets a fresh transport instance. This is the stateless
  // pattern recommended by the MCP SDK — no session affinity needed,
  // which makes the bastion easy to scale horizontally behind a load balancer.
  app.post(MCP_ENDPOINT_PATH, authMiddleware, rateLimitMiddleware, toolScopeMiddleware, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,   // Stateless — no sessions
        enableJsonResponse: true,        // JSON responses (not SSE)
      });

      // Clean up the transport when the HTTP connection closes
      res.on('close', () => transport.close());

      // Connect the MCP server to this request's transport and handle it
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('MCP request handling failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Start listening
  app.listen(config.port, () => {
    logger.info(`Bastion MCP server listening on port ${config.port}`, {
      healthCheck: `http://localhost:${config.port}${HEALTH_CHECK_PATH}`,
      mcpEndpoint: `http://localhost:${config.port}${MCP_ENDPOINT_PATH}`,
      transport: 'streamable-http',
    });
  });
}

// ─── stdio Transport (Development / Claude Code) ────────────────────────────

/**
 * Start the server with stdio transport for local development.
 *
 * In this mode, the server reads MCP messages from stdin and writes
 * responses to stdout. Auth is skipped (the local user is trusted).
 * This is useful for testing with the MCP Inspector or connecting
 * directly from Claude Code via `claude mcp add`.
 */
async function runStdio(mcpServer: McpServer): Promise<void> {
  logger.info('Starting in stdio mode (no auth, local development)');
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  logger.info('MCP server connected via stdio');
}

// ─── Entry Point ────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error('Fatal error during startup', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
