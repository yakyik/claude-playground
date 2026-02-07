# MCP Bastion Bridge — Architecture Design Document

**Version:** 0.1.0-draft  
**Status:** Design / Iteration  
**Last updated:** 2026-02-07  

---

## 1. Problem Statement

Claude operates across three execution surfaces — Claude.ai (sandboxed container), Claude Code (local CLI), and the Anthropic API (developer-hosted) — each with different network postures. Skills and MCP servers that need to reach external services face a **transport gap**: the sandboxed surfaces can only reach a curated allowlist of domains, while local Claude Code has full network freedom.

The original assessment framed this as "zero network access" for sandboxed surfaces. That was an overstatement. The real situation is **configurable, domain-allowlisted egress** that is still maturing. This document designs an architecture that works within current constraints and is ready to absorb future relaxations the moment they ship.

### 1.1 Design Goals

The architecture must satisfy five properties simultaneously:

1. **Single-domain surface area** — the sandbox only needs one domain on its allowlist, minimizing admin burden and attack surface.
2. **Defense in depth via Tailscale ACLs** — the bastion can only reach the specific internal services each MCP tool needs, nothing more.
3. **Works today** — no dependency on unreleased Anthropic features. Uses current allowlist mechanisms.
4. **Progressive enhancement** — when Anthropic ships native WireGuard/Tailscale integration or broader egress, the architecture upgrades gracefully without redesign.
5. **Unified MCP interface** — skills and tools see the same MCP protocol surface regardless of which Claude execution surface they're running on.

---

## 2. Architecture Overview

The core idea is a **bastion host** that presents a single authenticated HTTPS endpoint to the outside world, while internally it fans out to services over a Tailscale mesh network governed by fine-grained ACLs.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        YOUR TAILNET                                 │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │ Database  │    │ Internal │    │ Git/CI   │    │  Other   │      │
│  │ Service   │    │   API    │    │ Service  │    │ Services │      │
│  └─────┬────┘    └─────┬────┘    └─────┬────┘    └─────┬────┘      │
│        │               │               │               │            │
│        │      Tailscale ACLs govern    │               │            │
│        │       which paths exist        │               │            │
│        │               │               │               │            │
│  ┌─────┴───────────────┴───────────────┴───────────────┴──────┐     │
│  │                    BASTION HOST                             │     │
│  │                                                            │     │
│  │  ┌────────────────────────────────────────────────────┐    │     │
│  │  │              MCP Streamable HTTP Server             │    │     │
│  │  │                                                    │    │     │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐        │    │     │
│  │  │  │ Tool:    │  │ Tool:    │  │ Tool:    │  ...    │    │     │
│  │  │  │ db_query │  │ api_call │  │ git_ops  │        │    │     │
│  │  │  └──────────┘  └──────────┘  └──────────┘        │    │     │
│  │  └────────────────────────────────────────────────────┘    │     │
│  │                                                            │     │
│  │  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐   │     │
│  │  │ TLS Term   │  │ Auth Layer   │  │ Rate Limiter /   │   │     │
│  │  │ (nginx/    │  │ (JWT/API Key │  │ Audit Logger     │   │     │
│  │  │  caddy)    │  │  validation) │  │                  │   │     │
│  │  └────────────┘  └──────────────┘  └──────────────────┘   │     │
│  └────────────────────────────────────────────────────────────┘     │
│                            │                                        │
└────────────────────────────┼────────────────────────────────────────┘
                             │
                    Public HTTPS :443
                    bastion.yourcompany.com
                             │
           ┌─────────────────┼──────────────────────┐
           │                 │                       │
    ┌──────┴──────┐   ┌─────┴──────┐   ┌───────────┴───────────┐
    │  Claude.ai  │   │ Claude Code│   │  API Sandbox          │
    │  Sandbox    │   │  (Local)   │   │  (CI/CD container)    │
    │             │   │            │   │                       │
    │ Allowlist:  │   │ Full net   │   │ experimental_         │
    │ bastion.    │   │ access —   │   │ allowed_domains:      │
    │ yourco.com  │   │ can also   │   │ bastion.yourco.com    │
    │             │   │ use stdio  │   │                       │
    └─────────────┘   └────────────┘   └───────────────────────┘
```

### 2.1 Why This Shape

Think of the bastion as a **security funnel**. The wide end faces your internal network through Tailscale, where ACLs provide granular, auditable access control. The narrow end faces the public internet through a single HTTPS port, where TLS, authentication, and rate limiting provide the outer perimeter. Claude's sandboxed surfaces only need to know about the narrow end — one domain, one port.

This is the same pattern used by API gateways, reverse proxies, and jump boxes. The novel twist is that the service behind the funnel speaks MCP's Streamable HTTP transport, so Claude treats it as a native tool surface rather than a raw HTTP API.

---

## 3. Component Detail

### 3.1 The Bastion Host

The bastion runs three layers:

**Layer 1 — TLS Termination and Reverse Proxy.** Caddy or nginx terminates TLS using a certificate from Let's Encrypt (or your internal CA). This is the only component with a public-facing port. Caddy is preferred because it handles certificate provisioning automatically.

```
# Caddyfile — minimal config
bastion.yourcompany.com {
    # TLS is automatic with Caddy + Let's Encrypt
    
    # Forward MCP Streamable HTTP to the local server
    reverse_proxy localhost:3001 {
        # Pass through SSE if needed for streaming responses
        flush_interval -1
    }
    
    # Health check endpoint (no auth required)
    handle /health {
        respond "ok" 200
    }
}
```

**Layer 2 — Authentication and Authorization.** Every request must carry a valid credential. Two strategies depending on your threat model:

The **API key approach** is the simplest: a shared secret passed in the `Authorization` header. This is sufficient if the bastion is only reachable from Claude's sandboxes and your tailnet. The key is injected as an environment variable in the Claude.ai project or API call configuration.

The **JWT with scopes approach** is more robust: the bastion issues short-lived JWTs scoped to specific tool sets. This lets you grant different Claude instances access to different subsets of tools. A lightweight token endpoint on the bastion handles issuance.

```typescript
// Auth middleware (Express-style, runs in the MCP server process)
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  
  try {
    // Verify the JWT and extract tool-scoped claims
    const claims = jwt.verify(token, process.env.BASTION_JWT_SECRET!);
    req.allowedTools = claims.tools; // e.g., ["db_query", "api_call"]
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }
}
```

**Layer 3 — The MCP Server.** A Streamable HTTP MCP server that registers tools corresponding to the internal services you want Claude to access. Each tool handler reaches its backing service over the Tailscale mesh.

```typescript
// Bastion MCP server — TypeScript with @modelcontextprotocol/sdk
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'bastion-bridge',
  version: '0.1.0',
});

// Example tool: query an internal database reachable via tailnet.
// The URL uses Tailscale MagicDNS — only routable inside the tailnet.
server.registerTool(
  'db_query',
  {
    title: 'Query Internal Database',
    description: 'Run a read-only SQL query against the internal analytics DB.',
    inputSchema: {
      query: z.string().describe('SQL SELECT query to execute'),
      database: z.enum(['analytics', 'metrics']).describe('Target database'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, database }) => {
    // MagicDNS names resolve only within the tailnet
    const dbProxy = database === 'analytics'
      ? 'http://analytics-db.tail1234.ts.net:5432/query'
      : 'http://metrics-db.tail1234.ts.net:5432/query';
    
    const result = await fetch(dbProxy, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: query, readOnly: true }),
    });
    
    const data = await result.json();
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Example tool: call an internal REST API.
// The service map translates logical names to tailnet addresses.
server.registerTool(
  'internal_api',
  {
    title: 'Internal API Request',
    description: 'Make authenticated requests to internal services.',
    inputSchema: {
      service: z.enum(['inventory', 'billing', 'users']),
      method: z.enum(['GET', 'POST']),
      path: z.string().describe('API path, e.g. /v1/users/123'),
      body: z.string().optional().describe('JSON body for POST requests'),
    },
  },
  async ({ service, method, path, body }) => {
    const serviceMap: Record<string, string> = {
      inventory: 'http://inventory-api.tail1234.ts.net:8080',
      billing:   'http://billing-api.tail1234.ts.net:8080',
      users:     'http://users-api.tail1234.ts.net:8080',
    };
    
    const response = await fetch(`${serviceMap[service]}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body } : {}),
    });
    
    return {
      content: [{ type: 'text', text: await response.text() }],
    };
  }
);
```

### 3.2 Tailscale ACL Configuration

This is where the real security lives. The bastion's Tailscale ACLs follow **least-privilege by tool** — each internal service the bastion can reach must be explicitly enumerated. Everything else is implicitly denied (Tailscale's default-deny posture).

```jsonc
// tailscale ACL policy (relevant excerpt)
{
  "acls": [
    // The bastion can ONLY reach these specific service:port pairs.
    // If an attacker compromises the bastion, this is the blast radius.
    {
      "action": "accept",
      "src":    ["tag:bastion"],
      "dst": [
        "tag:analytics-db:5432",
        "tag:metrics-db:5432",
        "tag:inventory-api:8080",
        "tag:billing-api:8080",
        "tag:users-api:8080"
      ]
    },
    
    // Everything not listed above is implicitly denied for tag:bastion.
    // The bastion cannot SSH anywhere, cannot port-scan, cannot reach
    // production databases on other ports.
    
    // Your other internal ACLs for human access, CI, etc.
    {
      "action": "accept",
      "src":    ["group:engineering"],
      "dst":    ["*:*"]
    }
  ],
  
  // Tag owners control who can assign these tags to devices.
  // This prevents someone from self-tagging as "bastion" to inherit its ACLs.
  "tagOwners": {
    "tag:bastion":        ["group:platform-team"],
    "tag:analytics-db":   ["group:data-team"],
    "tag:metrics-db":     ["group:data-team"],
    "tag:inventory-api":  ["group:backend-team"],
    "tag:billing-api":    ["group:backend-team"],
    "tag:users-api":      ["group:backend-team"]
  }
}
```

The key insight: even if someone compromises the bastion entirely, Tailscale's ACLs prevent lateral movement. The bastion can only reach the five service:port combinations listed above. It cannot SSH to other machines, cannot access services on unlisted ports, and cannot scan the rest of the tailnet.

### 3.3 Audit and Observability

Every MCP tool invocation through the bastion should be logged with enough detail to reconstruct what happened. This is critical for compliance and debugging.

```typescript
// Audit log entry structure — ship these to your log aggregation
// (Datadog, Loki, CloudWatch, etc.)
interface AuditEntry {
  timestamp:    string;       // ISO 8601
  requestId:    string;       // UUID for correlation
  tool:         string;       // MCP tool name invoked
  inputs:       object;       // Sanitized inputs (redact secrets/PII)
  source:       string;       // Which Claude surface (from auth token claims)
  userId:       string;       // Who initiated (from auth token)
  backendHost:  string;       // Which tailnet service was called
  responseCode: number;       // HTTP status from backend
  durationMs:   number;       // End-to-end latency
  error?:       string;       // Error message if failed
}
```

Set up alerts for unusual patterns: high error rates, unexpected tool/service combinations, or requests outside business hours.

---

## 4. Deployment Topologies

### 4.1 Minimal (Single VM)

For small teams or proof-of-concept. Everything runs on one VM that has Tailscale installed and a public IP (or sits behind a cloud load balancer).

```
┌─────────────────────────────────────────┐
│  Single VM (e.g., t3.small on AWS)      │
│                                         │
│  ┌─────────┐  ┌──────────────────────┐  │
│  │ Caddy   │──│ MCP Server (Node.js) │  │
│  │ :443    │  │ :3001                │  │
│  └─────────┘  └──────────────────────┘  │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │ Tailscale (userspace or kernel) │    │
│  │ Tagged: tag:bastion             │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

Estimated cost: roughly $10-20/month for a small VM plus the free Tailscale tier (up to 100 devices). Caddy handles TLS automatically via Let's Encrypt.

### 4.2 Production (Container Orchestrated)

For teams with existing Kubernetes or ECS infrastructure. The bastion runs as a deployment with a Tailscale sidecar container.

```
┌─ Kubernetes Namespace: mcp-bastion ──────────────────────────┐
│                                                               │
│  ┌─ Pod ───────────────────────────────────────────────────┐  │
│  │                                                         │  │
│  │  ┌──────────────┐    ┌──────────────────────────────┐   │  │
│  │  │  tailscale   │    │  mcp-bastion-server          │   │  │
│  │  │  sidecar     │◄──►│  (Streamable HTTP on :3001)  │   │  │
│  │  │              │    │                              │   │  │
│  │  │  Tagged:     │    │  Env:                        │   │  │
│  │  │  tag:bastion │    │    BASTION_JWT_SECRET         │   │  │
│  │  │              │    │    (from K8s Secret)          │   │  │
│  │  └──────────────┘    └──────────────────────────────┘   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ Ingress ────────────────────────────────────────────────┐ │
│  │  bastion.yourcompany.com → Service:mcp-bastion:3001      │ │
│  │  TLS: cert-manager / cloud LB                            │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

The Tailscale Kubernetes operator handles auth key injection and tag assignment. The MCP server container has no direct internet access — it only talks to the tailnet through the sidecar.

### 4.3 Claude Code Direct (No Bastion Needed)

When running Claude Code locally, the bastion is optional. Tailscale is already on your machine, and MCP servers connect via stdio. This is worth documenting because the skill system should detect which surface it's running on and choose the appropriate transport.

```
┌─ Your Laptop ──────────────────────────────────┐
│                                                 │
│  ┌────────────┐    stdio    ┌───────────────┐   │
│  │ Claude Code │◄──────────►│ MCP Server    │   │
│  │ (CLI)       │            │ (local proc)  │   │
│  └────────────┘            └───────┬───────┘   │
│                                     │           │
│  ┌──────────────────────────────────┴────────┐  │
│  │ Tailscale (already running on your laptop)│  │
│  │ → can reach all services per your ACLs    │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## 5. Configuration for Each Claude Surface

### 5.1 Claude.ai (Web/Mobile)

**Admin setup (one-time):** Navigate to Admin Settings → Capabilities → Code execution and file creation → Network access. Add `bastion.yourcompany.com` to the "Additional allowed domains" list.

> ⚠️ **Known bug (as of early 2026):** Custom domains added via the settings UI may not propagate to the JWT issued for sandbox sessions. See [GitHub issue #19087](https://github.com/anthropics/claude-code/issues/19087). Monitor this — when fixed, the allowlist approach works cleanly.

**Workaround while the bug persists:** The skill operates in "generate instructions" mode — it produces the MCP tool calls as curl commands or a Python script that the user runs locally. Less seamless but maintains full functionality.

**In the Claude.ai Project:** Add the bastion as a Remote MCP server in Project settings, or have the skill make direct HTTP calls using `fetch()` in the sandbox.

### 5.2 Claude Code (Local CLI)

Two options, from simplest to most flexible:

**Option A — Direct stdio MCP (no bastion needed):**
```bash
# Add local MCP server that talks to tailnet directly
claude mcp add internal-tools --type stdio -- \
  node /path/to/mcp-server/dist/index.js
```

**Option B — Connect to bastion via Streamable HTTP:**
```bash
# If you want consistency with the sandboxed path
claude mcp add bastion --type streamable-http \
  --url https://bastion.yourcompany.com/mcp \
  --header "Authorization: Bearer $BASTION_TOKEN"
```

### 5.3 API Sandbox / CI (GitHub Actions, etc.)

```yaml
# In your GitHub Actions workflow using claude-code-action
- uses: anthropics/claude-code-action@v1
  with:
    experimental_allowed_domains: |
      bastion.yourcompany.com
    mcp_config: |
      {
        "mcpServers": {
          "bastion": {
            "type": "streamable-http",
            "url": "https://bastion.yourcompany.com/mcp",
            "headers": {
              "Authorization": "Bearer ${{ secrets.BASTION_TOKEN }}"
            }
          }
        }
      }
```

---

## 6. Security Analysis

### 6.1 Threat Model

**Bastion compromise leading to lateral movement.** Mitigated by Tailscale ACLs that restrict the bastion to enumerated service:port pairs only. Even with root on the bastion, the attacker can only reach the five services listed in the ACL.

**Stolen API key or JWT leading to unauthorized access.** Mitigated by short-lived JWTs with tool-scoped claims, key rotation policy, and rate limiting at the Caddy layer.

**Prompt injection causing Claude to make malicious tool calls.** Mitigated by the auth layer validating tool access per-token, the audit log catching anomalies, and using read-only tool annotations where possible.

**Man-in-the-middle on bastion HTTPS.** Mitigated by TLS termination with a valid certificate and HSTS headers. Certificate pinning is optional for higher assurance.

**Sandbox escape leading to direct tailnet access.** Not possible — the sandbox has no Tailscale client installed. It can only reach the bastion domain via HTTPS through the egress proxy.

**DDoS on bastion endpoint.** Mitigated by rate limiting at the Caddy/nginx layer and optionally a cloud WAF if using a cloud load balancer.

### 6.2 The "Blast Radius" Principle

Even in a worst-case scenario where both the Claude sandbox and the bastion are fully compromised, the attacker can only reach the specific internal services listed in the Tailscale ACL. They cannot pivot to other machines, cannot access services on unlisted ports, and every action is logged. Compare this to giving the sandbox full network access — the blast radius difference is enormous.

---

## 7. Progressive Enhancement Roadmap

This section tracks how the architecture evolves as Anthropic ships new capabilities. The design absorbs each enhancement without requiring a redesign.

### 7.1 Current State (Early 2026)

| Capability | Status |
|-----------|--------|
| Claude.ai domain allowlists | ✅ Available (bug on custom domain propagation) |
| Claude Code full local network | ✅ Works perfectly |
| Claude Code Action `experimental_allowed_domains` | ✅ Available |
| Remote MCP servers (Enterprise) | ✅ Available |
| Native WireGuard/Tailscale in sandboxes | ❌ Not available |
| Anthropic-managed tunnel provisioning | ❌ Not available |

### 7.2 When Custom Domain Allowlisting Bug is Fixed

**Impact:** The bastion pattern works end-to-end for Claude.ai without workarounds. **Action:** Remove "generate instructions" fallback mode from skills; switch to direct `fetch()` calls to bastion.

### 7.3 When Anthropic Ships Broader Sandbox Networking

**Impact:** May be able to reach the bastion without explicit allowlisting. **Action:** Simplify admin setup. The bastion still provides auth/ACL/audit value even if the allowlist step becomes unnecessary.

### 7.4 When/If Native Tailscale Integration Ships

This would mean Tailscale runs inside the sandbox, allowing direct MCP connections to tailnet services without a public-facing bastion.

**Impact:** Bastion becomes optional for the transport layer, but remains valuable as an auth gateway and audit chokepoint. **Action:** Offer both paths — direct-to-tailnet for teams that trust ACLs alone, bastion-mediated for teams that want the additional auth/audit/rate-limiting layer.

### 7.5 When Anthropic Ships Auth-Provisioned Tunnels

Per [feature request #10051](https://github.com/anthropics/claude-code/issues/10051), the dream scenario: Claude's own authentication auto-provisions an encrypted tunnel to your dev environment.

**Impact:** Zero-config connectivity. The bastion's transport role disappears entirely. **Action:** Bastion pivots to pure governance — audit logging, policy enforcement, and tool-level authorization. The transport is handled by Anthropic's infrastructure.

---

## 8. Skill Integration Pattern

For skills that need to work across all Claude surfaces, the recommended pattern is a **transport adapter** that detects the execution environment and chooses the right connection strategy.

```typescript
// transport-adapter.ts — used by skills at runtime to pick the
// optimal connection strategy based on where Claude is executing.

async function getMcpConnection(toolName: string): Promise<McpClient> {
  const env = detectEnvironment(); 
  
  switch (env) {
    case 'claude-code-local':
      // Best case: direct tailnet access via stdio MCP, no bastion needed
      return connectViaStdio(toolName);
      
    case 'claude-ai-sandbox':
    case 'api-sandbox':
      // Route through the bastion over HTTPS
      const bastionUrl = process.env.BASTION_URL 
        || 'https://bastion.yourcompany.com/mcp';
      const token = process.env.BASTION_TOKEN;
      return connectViaStreamableHttp(bastionUrl, token, toolName);
  }
}

function detectEnvironment(): string {
  // Claude Code sets this env var when running locally
  if (process.env.CLAUDE_CODE === 'true') return 'claude-code-local';
  
  // Claude.ai sandbox containers have a sandbox identifier
  if (process.env.SANDBOX_ID) return 'claude-ai-sandbox';
  
  // Default to most-restrictive assumption
  return 'api-sandbox';
}
```

---

## 9. Open Questions

These are items to resolve through iteration:

1. **Token lifecycle.** How long should bastion JWTs live? Short-lived tokens (5 min) are more secure but require a refresh mechanism. Long-lived tokens (24h) are simpler but riskier. Need to balance against Claude's typical conversation duration patterns.

2. **Tool discovery.** Should the bastion expose an MCP `tools/list` endpoint that's filterable by token scope? This would let Claude discover only the tools it's authorized to use, reducing hallucinated tool calls to nonexistent tools.

3. **Streaming vs. request/response.** The current design uses stateless Streamable HTTP (single request → single response). Some tools might benefit from streaming (e.g., tailing logs, watching deployments). Need to decide if the bastion should support SSE streaming or stick to request/response for simplicity.

4. **Multi-tenant bastion.** If multiple teams share one bastion, should tool namespacing be enforced at the bastion level (e.g., `team-a/db_query` vs `team-b/db_query`) or handled purely through token scopes?

5. **Fallback behavior.** When the bastion is unreachable (network issue, maintenance), should the skill gracefully degrade to "generate instructions" mode, or fail loudly? Probably configurable per-skill.

6. **Cost of the allowlist bug.** Is the [#19087 bug](https://github.com/anthropics/claude-code/issues/19087) a blocker for your team, or can you work around it with Enterprise Remote MCP server configuration?

---

## Appendix A: Quick-Start Checklist

For teams who want to stand this up in an afternoon:

- [ ] Provision a small VM (or container) with a public IP / domain
- [ ] Install Tailscale, authenticate, and assign `tag:bastion`
- [ ] Configure Tailscale ACLs to restrict bastion to only needed services
- [ ] Install Caddy for automatic TLS
- [ ] Deploy the MCP Streamable HTTP server (Node.js/TypeScript)
- [ ] Generate a bastion API key or JWT signing secret
- [ ] Add `bastion.yourcompany.com` to Claude.ai's domain allowlist
- [ ] Test from Claude.ai: can a skill `fetch()` the bastion's `/health` endpoint?
- [ ] Test MCP tool invocation end-to-end
- [ ] Set up audit log shipping to your log aggregation
- [ ] Document the bastion URL and auth mechanism for your team's skills

---

## Appendix B: Related Issues and References

- [GitHub #19087](https://github.com/anthropics/claude-code/issues/19087) — Custom allowlist domains not propagating to sandbox JWT
- [GitHub #10223](https://github.com/anthropics/claude-code/issues/10223) — Inconsistent network behavior in default cloud environment
- [GitHub #10051](https://github.com/anthropics/claude-code/issues/10051) — Feature request: integrated terminal + authenticated VPN in Claude mobile
- [Tailscale blog: MCP connectivity](https://tailscale.com/blog/model-for-mcp-connectivity-lee-briggs) — Lee Briggs on Tailscale + MCP patterns
- [Claude.ai network egress docs](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude) — Official allowlist configuration
- [MCP Streamable HTTP spec](https://modelcontextprotocol.io/specification/draft) — Transport protocol details

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0-draft | 2026-02-07 | Initial architecture sketch. Bastion pattern with Tailscale ACLs, three deployment topologies, progressive enhancement roadmap. |
