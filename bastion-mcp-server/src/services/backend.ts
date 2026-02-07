/**
 * Backend client for making requests to services on the tailnet.
 *
 * This is the "outbound" half of the bastion — it takes requests from
 * MCP tool handlers and forwards them to internal services over the
 * Tailscale mesh. The client handles:
 *
 *   - Service registry lookups (logical name → tailnet URL)
 *   - Timeout enforcement
 *   - Custom headers per-service
 *   - Health checks on startup
 *   - Error normalization (so tool handlers get consistent error shapes)
 *
 * The client uses the native fetch() API (available in Node 20+) to
 * avoid unnecessary dependencies. For older Node versions, you'd need
 * the 'undici' or 'node-fetch' package.
 */

import type { ServiceRegistry, BackendService } from '../types.js';
import { logger } from './logger.js';
import { DEFAULT_TIMEOUT_MS } from '../constants.js';

/**
 * Error thrown when a backend service request fails.
 * Includes the HTTP status code (if available) for audit logging.
 */
export class BackendError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly serviceName: string
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * Create a backend client bound to a service registry.
 *
 * The registry is loaded at startup from config and doesn't change at
 * runtime. If you need to add services dynamically, you'd extend this
 * to support registry reloads (e.g., watching a config file).
 */
export function createBackendClient(registry: ServiceRegistry) {
  /**
   * Make an HTTP request to a named backend service.
   *
   * @param serviceName - Logical name from the service registry
   * @param path        - Path to append to the service's base URL
   * @param options     - Standard fetch options (method, headers, body, etc.)
   * @returns           - The parsed JSON response from the backend
   * @throws BackendError if the service is unknown, unreachable, or returns an error
   */
  async function request<T = unknown>(
    serviceName: string,
    path: string,
    options: RequestInit = {}
  ): Promise<{ data: T; status: number; host: string }> {
    const service = registry.get(serviceName);
    if (!service) {
      throw new BackendError(
        `Unknown backend service: '${serviceName}'. Available services: ${[...registry.keys()].join(', ')}`,
        404,
        serviceName
      );
    }

    const url = `${service.url}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      service.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...service.headers,
          ...options.headers,
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '(no body)');
        throw new BackendError(
          `Backend ${serviceName} returned ${response.status}: ${body}`,
          response.status,
          serviceName
        );
      }

      const data = (await response.json()) as T;
      // Extract just the hostname for audit logging (strip path and query)
      const host = new URL(service.url).host;

      return { data, status: response.status, host };
    } catch (err) {
      if (err instanceof BackendError) throw err;

      // Handle fetch-level errors (network, timeout, DNS)
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('abort');
      throw new BackendError(
        isTimeout
          ? `Request to ${serviceName} timed out after ${service.timeoutMs}ms`
          : `Failed to reach ${serviceName}: ${message}`,
        isTimeout ? 504 : 502,
        serviceName
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Run health checks against all registered services.
   *
   * Called once at startup to verify the bastion can reach its backends.
   * Logs warnings for unreachable services but doesn't prevent startup —
   * a service might come up later, and the bastion should be resilient.
   */
  async function healthCheckAll(): Promise<void> {
    const entries = [...registry.entries()];
    if (entries.length === 0) {
      logger.info('No backend services configured — skipping health checks');
      return;
    }

    logger.info(`Running health checks for ${entries.length} backend services`);

    const results = await Promise.allSettled(
      entries.map(async ([name, service]) => {
        const checkPath = service.healthCheckPath ?? '/health';
        try {
          await request(name, checkPath, { method: 'GET' });
          logger.info(`Health check passed: ${name}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Health check failed: ${name} — ${msg}`);
        }
      })
    );

    const passed = results.filter((r) => r.status === 'fulfilled').length;
    logger.info(`Health checks complete: ${passed}/${entries.length} passed`);
  }

  return { request, healthCheckAll, getRegistry: () => registry };
}

/**
 * Build a ServiceRegistry Map from the config array.
 */
export function buildRegistry(services: BackendService[]): ServiceRegistry {
  const registry: ServiceRegistry = new Map();
  for (const svc of services) {
    if (registry.has(svc.name)) {
      logger.warn(`Duplicate service name in registry: '${svc.name}'. Last one wins.`);
    }
    registry.set(svc.name, svc);
  }
  return registry;
}
