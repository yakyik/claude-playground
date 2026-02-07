/**
 * Core type definitions for the bastion MCP server.
 *
 * These types define the contracts between the auth layer, the tool registry,
 * the audit system, and the backend service connections. They're separated
 * from implementation so that each layer can be developed and tested independently.
 */

// ─── Authentication & Authorization ─────────────────────────────────────────

/**
 * Claims extracted from a validated JWT or API key lookup.
 * These travel with the request through the middleware chain and
 * determine which tools the caller is authorized to invoke.
 */
export interface AuthClaims {
  /** Unique identifier for the authenticated principal (user or service) */
  sub: string;
  /** Which Claude surface originated this request */
  source: 'claude-ai' | 'claude-code' | 'api-sandbox' | 'unknown';
  /** Tool names this token is authorized to invoke. Empty array = all tools. */
  tools: string[];
  /** ISO 8601 timestamp when this token expires */
  exp: string;
  /** Optional: team or project scope for multi-tenant bastions */
  scope?: string;
}

/**
 * Supported authentication strategies. The bastion picks one based on config.
 * - 'api-key': Simple shared secret in Authorization header
 * - 'jwt': Signed tokens with tool-scoped claims
 */
export type AuthStrategy = 'api-key' | 'jwt';

export interface AuthConfig {
  strategy: AuthStrategy;
  /** For api-key strategy: the expected key value (from env var) */
  apiKey?: string;
  /** For jwt strategy: the HMAC secret or RSA public key */
  jwtSecret?: string;
  /** For jwt strategy: expected issuer claim */
  jwtIssuer?: string;
}

// ─── Backend Service Registry ───────────────────────────────────────────────

/**
 * Defines a backend service that the bastion can reach over the tailnet.
 * Each service maps to one or more MCP tools.
 */
export interface BackendService {
  /** Logical name used in tool definitions (e.g., 'analytics-db') */
  name: string;
  /** Tailnet URL — only routable inside the mesh (e.g., 'http://analytics-db.tail1234.ts.net:5432') */
  url: string;
  /** Optional health check path. The bastion pings this on startup. */
  healthCheckPath?: string;
  /** Connection timeout in milliseconds */
  timeoutMs: number;
  /** Optional: additional headers to send with every request to this backend */
  headers?: Record<string, string>;
}

/**
 * The full service registry loaded from config. Maps logical service
 * names to their tailnet connection details.
 */
export type ServiceRegistry = Map<string, BackendService>;

// ─── Audit Logging ──────────────────────────────────────────────────────────

/**
 * Every MCP tool invocation produces one of these. They're shipped to
 * your log aggregation system (Datadog, Loki, CloudWatch, etc.) for
 * compliance, debugging, and anomaly detection.
 */
export interface AuditEntry {
  /** ISO 8601 timestamp of when the invocation started */
  timestamp: string;
  /** UUID for correlating this entry with other logs */
  requestId: string;
  /** Which MCP tool was invoked */
  tool: string;
  /** Sanitized inputs — secrets and PII should be redacted before logging */
  inputs: Record<string, unknown>;
  /** Which Claude surface originated this request */
  source: string;
  /** Who initiated the request (from auth claims) */
  userId: string;
  /** Which tailnet service was called (the backend URL, with path stripped) */
  backendHost: string;
  /** HTTP status code from the backend */
  responseCode: number;
  /** End-to-end latency in milliseconds */
  durationMs: number;
  /** Error message if the invocation failed */
  error?: string;
}

// ─── Tool Definition Helpers ────────────────────────────────────────────────

/**
 * Configuration for a tool that proxies requests to a backend service.
 * This is a higher-level abstraction over the raw MCP registerTool call,
 * making it easy to define tools declaratively in config files.
 */
export interface ProxyToolConfig {
  /** MCP tool name (snake_case, e.g., 'bastion_db_query') */
  name: string;
  /** Human-readable title for the tool */
  title: string;
  /** Detailed description including args, returns, and examples */
  description: string;
  /** Which backend service this tool proxies to */
  backendService: string;
  /** HTTP method to use when calling the backend */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path template on the backend (supports {param} interpolation) */
  pathTemplate: string;
  /** MCP tool annotations */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

// ─── Server Configuration ───────────────────────────────────────────────────

/**
 * Top-level configuration for the bastion server. Loaded from environment
 * variables and/or a config file. See src/config/loader.ts for details.
 */
export interface BastionConfig {
  /** Server name reported in MCP handshake */
  serverName: string;
  /** Server version reported in MCP handshake */
  serverVersion: string;
  /** Port for the HTTP server to listen on */
  port: number;
  /** Authentication configuration */
  auth: AuthConfig;
  /** Registry of backend services reachable via the tailnet */
  services: BackendService[];
  /** Log level: 'debug' | 'info' | 'warn' | 'error' */
  logLevel: string;
  /** Whether to enable the /health endpoint without auth */
  healthCheckEnabled: boolean;
}

// ─── Express Request Extension ──────────────────────────────────────────────

/**
 * Extends the Express Request type to include auth claims injected
 * by the auth middleware. This avoids unsafe type casts in handlers.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authClaims?: AuthClaims;
      requestId?: string;
    }
  }
}
