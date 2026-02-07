/**
 * Configuration loader for the bastion MCP server.
 *
 * The loader follows a layered approach:
 *   1. Hardcoded defaults (defined in constants.ts)
 *   2. Config file (optional, JSON or YAML at BASTION_CONFIG_PATH)
 *   3. Environment variables (highest precedence, override everything)
 *
 * This means you can deploy with just env vars for simple setups,
 * or use a config file for complex multi-service registries.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { BastionConfig, AuthConfig, BackendService } from '../types.js';
import {
  DEFAULT_SERVER_NAME,
  DEFAULT_SERVER_VERSION,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
} from '../constants.js';

/**
 * Load and validate the bastion configuration.
 * Throws with a clear message if required config is missing.
 */
export function loadConfig(): BastionConfig {
  // Start with defaults
  const config: BastionConfig = {
    serverName: DEFAULT_SERVER_NAME,
    serverVersion: DEFAULT_SERVER_VERSION,
    port: DEFAULT_PORT,
    auth: loadAuthConfig(),
    services: loadServiceRegistry(),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    healthCheckEnabled: process.env.HEALTH_CHECK_ENABLED !== 'false',
  };

  // Override with env vars
  if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
  }
  if (process.env.SERVER_NAME) {
    config.serverName = process.env.SERVER_NAME;
  }

  return config;
}

/**
 * Determine the auth strategy and load the corresponding secrets.
 *
 * The loader checks for JWT config first (since it's the more secure option),
 * then falls back to API key. If neither is configured, it throws — running
 * the bastion without auth is never acceptable.
 */
function loadAuthConfig(): AuthConfig {
  // JWT strategy takes precedence if configured
  if (process.env.BASTION_JWT_SECRET) {
    return {
      strategy: 'jwt',
      jwtSecret: process.env.BASTION_JWT_SECRET,
      jwtIssuer: process.env.BASTION_JWT_ISSUER ?? 'bastion-mcp-server',
    };
  }

  // Fall back to API key
  if (process.env.BASTION_API_KEY) {
    return {
      strategy: 'api-key',
      apiKey: process.env.BASTION_API_KEY,
    };
  }

  throw new Error(
    'Authentication not configured. Set either BASTION_JWT_SECRET (recommended) ' +
    'or BASTION_API_KEY environment variable. Running the bastion without auth is not supported.'
  );
}

/**
 * Load the service registry from a config file or environment variable.
 *
 * The registry maps logical service names to their tailnet connection
 * details. You can define this in two ways:
 *
 * 1. A JSON config file at BASTION_CONFIG_PATH:
 *    {
 *      "services": [
 *        { "name": "analytics-db", "url": "http://analytics-db.tail1234.ts.net:5432", "timeoutMs": 5000 },
 *        { "name": "users-api", "url": "http://users-api.tail1234.ts.net:8080" }
 *      ]
 *    }
 *
 * 2. The BASTION_SERVICES env var (JSON array):
 *    BASTION_SERVICES='[{"name":"analytics-db","url":"http://analytics-db.tail1234.ts.net:5432"}]'
 *
 * If neither is provided, the server starts with an empty registry
 * (useful for development — you'd register tools programmatically).
 */
function loadServiceRegistry(): BackendService[] {
  // Try config file first
  const configPath = process.env.BASTION_CONFIG_PATH;
  if (configPath && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as { services?: BackendService[] };
      return (parsed.services ?? []).map(normalizeService);
    } catch (err) {
      throw new Error(
        `Failed to parse config file at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Try env var
  if (process.env.BASTION_SERVICES) {
    try {
      const parsed = JSON.parse(process.env.BASTION_SERVICES) as BackendService[];
      return parsed.map(normalizeService);
    } catch (err) {
      throw new Error(
        `Failed to parse BASTION_SERVICES env var: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Empty registry — tools will be registered programmatically
  return [];
}

/**
 * Ensure every service entry has all required fields and sensible defaults.
 */
function normalizeService(svc: Partial<BackendService> & { name: string; url: string }): BackendService {
  return {
    name: svc.name,
    url: svc.url.replace(/\/$/, ''), // Strip trailing slash
    healthCheckPath: svc.healthCheckPath ?? '/health',
    timeoutMs: svc.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: svc.headers ?? {},
  };
}
