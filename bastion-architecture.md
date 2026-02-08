# Bastion Architecture for MCP Transport Bridging Across Claude Surfaces

## The Problem, Restated More Precisely

The original artifact framed the transport challenge as "Claude's API sandbox has zero network access." This turns out to be an oversimplification. The reality is a gradient of network access across three distinct Claude execution surfaces, each with different constraints and different solutions available today. The critical unsolved piece is narrower than it first appears — and the architecture below is designed to collapse all three surfaces into a single connectivity pattern.

## The Three Surfaces and Their Actual Network Posture

### Surface 1: Claude Code (Local CLI)

Claude Code runs as a process on the user's own machine. It has full, unrestricted network access — anything the host OS can reach, Claude Code can reach. MCP servers connect primarily via stdio (spawned as subprocesses) or via Streamable HTTP to remote endpoints. Since June 2025, Claude Code natively supports `claude mcp add --transport http <url>` for remote MCP servers with OAuth 2.0 authentication. Tailscale, if installed on the same machine, is directly accessible. There is no transport gap here.

### Surface 2: Claude.ai (Web/Mobile Chat with Code Execution)

When Claude.ai uses the code execution sandbox (the environment I'm running in right now), it operates inside a containerized Ubuntu environment with *configurable* network egress. The configuration hierarchy works as follows. The default for Team plans is "Allow network egress to package managers only," which allowlists npm, PyPI, GitHub, and a handful of other package registries. Enterprise Owners can escalate this to "Allow network egress to package managers and specific domains" — adding individual domains to a whitelist. The most permissive option is "All domains," which grants full internet access minus Anthropic's legal blocklist. There is also a separate mechanism for Remote MCP servers: Claude.ai (Max, Team, Enterprise) can connect to remote MCP servers directly via Streamable HTTP or SSE, with OAuth support, independent of the code execution sandbox's network policy. This is the "Integrations" feature in the Claude.ai UI.

The important distinction: the code execution sandbox's domain allowlist and the Remote MCP integration feature are two separate pathways. A skill running code in the sandbox hits the domain allowlist. A remote MCP server configured as an Integration bypasses the sandbox entirely — Claude talks to it via Anthropic's infrastructure.

There is a known bug (GitHub issue #19087, filed ~3 weeks ago) where custom domains added to "Additional allowed domains" in claude.ai/settings/capabilities are not being included in the JWT token issued to the sandbox container. This means sandbox-side HTTP calls to your bastion may fail even if you've configured the domain. This is a bug, not a design limitation, and is expected to be fixed.

### Surface 3: API Sandbox (CI/CD, GitHub Actions, Programmatic Use)

When Claude Code runs in automated/headless mode (e.g., `claude-code-action` in GitHub Actions), it operates in a container with an `experimental_allowed_domains` parameter that restricts outbound connections to a whitelist. Provider API domains (Anthropic, AWS Bedrock, Google Vertex) are auto-added. Everything else must be explicitly listed. This is the most constrained surface, but it is configurable — you can add your bastion's domain to the allowlist in your GitHub Action configuration.

## The Architectural Insight

All three surfaces share one thing in common: they can reach a known HTTPS endpoint on the public internet (or at least, one that is resolvable and routable from their network). The bastion pattern exploits this by presenting a single, stable HTTPS surface that all three surfaces can target, while the bastion itself lives on a Tailscale tailnet and uses Tailscale ACLs to control what internal services it can reach.

The key insight is that we don't need Tailscale inside the sandbox. We need Tailscale behind the bastion, and HTTPS in front of it.

## Architecture Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PUBLIC INTERNET                              │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  Claude.ai   │  │ Claude Code  │  │  API Sandbox (CI/CD)     │  │
│  │  Sandbox     │  │ (Local CLI)  │  │  claude-code-action      │  │
│  │              │  │              │  │                          │  │
│  │ Allowlisted  │  │ Full Network │  │ experimental_allowed_    │  │
│  │ Domains      │  │ Access       │  │ domains                  │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                 │                        │                │
│         │    HTTPS + OAuth 2.1 / mTLS / API Key    │                │
│         │                 │                        │                │
│         └─────────────────┼────────────────────────┘                │
│                           │                                         │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              BASTION HOST                                    │   │
│  │              bastion.yourcompany.com                         │   │
│  │                                                              │   │
│  │  ┌──────────────────────────────────────────────────────┐   │   │
│  │  │  Reverse Proxy (Caddy / nginx / Cloudflare Tunnel)   │   │   │
│  │  │  - TLS termination                                    │   │   │
│  │  │  - Rate limiting                                      │   │   │
│  │  │  - Request authentication                             │   │   │
│  │  │  - Audit logging                                      │   │   │
│  │  └──────────────────────┬───────────────────────────────┘   │   │
│  │                         │                                    │   │
│  │  ┌──────────────────────▼───────────────────────────────┐   │   │
│  │  │  MCP Gateway (Streamable HTTP)                        │   │   │
│  │  │  - Tool registry & routing                            │   │   │
│  │  │  - Request validation (Zod/Pydantic schemas)          │   │   │
│  │  │  - Response formatting                                │   │   │
│  │  │  - Stateless JSON mode (no session affinity needed)   │   │   │
│  │  └──────────────────────┬───────────────────────────────┘   │   │
│  │                         │                                    │   │
│  │  ┌──────────────────────▼───────────────────────────────┐   │   │
│  │  │  Tailscale (userspace or kernel)                      │   │   │
│  │  │  - Authenticated to your tailnet                      │   │   │
│  │  │  - ACLs restrict which internal hosts are reachable   │   │   │
│  │  │  - All traffic WireGuard-encrypted                    │   │   │
│  │  └──────────────────────┬───────────────────────────────┘   │   │
│  └─────────────────────────┼────────────────────────────────────┘   │
│                            │                                        │
└────────────────────────────┼────────────────────────────────────────┘
                             │
                     ┌───────▼──────────────────────────────────┐
                     │           YOUR TAILNET                    │
                     │                                           │
                     │  ┌───────────┐  ┌───────────────────┐    │
                     │  │ Database  │  │ Internal APIs      │    │
                     │  │ Server    │  │ (REST/gRPC)        │    │
                     │  │ 100.x.x.1│  │ 100.x.x.2         │    │
                     │  └───────────┘  └───────────────────┘    │
                     │                                           │
                     │  ┌───────────┐  ┌───────────────────┐    │
                     │  │ Git Repos │  │ Monitoring /       │    │
                     │  │ (Gitea/   │  │ Observability      │    │
                     │  │  GitLab)  │  │ (Prometheus, etc.) │    │
                     │  │ 100.x.x.3│  │ 100.x.x.4         │    │
                     │  └───────────┘  └───────────────────┘    │
                     │                                           │
                     └───────────────────────────────────────────┘
```

## Component Breakdown

### Layer 1: The Public-Facing Reverse Proxy

The outermost layer handles TLS termination and authentication before any MCP logic runs. The key design choice here is that this is the only component that needs a public IP or DNS record. Everything behind it is internal.

There are several options for this layer, each with distinct trade-offs. Caddy is appealing because it handles automatic HTTPS certificates via Let's Encrypt and has a simple configuration syntax. Nginx is the battle-tested choice for teams that already have operational familiarity. Cloudflare Tunnel is interesting because it eliminates the need for a public IP entirely — the bastion dials out to Cloudflare, and Cloudflare routes inbound traffic to it. This means the bastion doesn't need any inbound firewall rules at all, which is a significant security win.

Authentication at this layer should validate that the request is coming from an authorized Claude surface. Options include OAuth 2.1 (which Claude.ai's Remote MCP integration supports natively), mutual TLS (mTLS) where the client presents a certificate, or a simpler API key/bearer token approach for lower-security use cases. For the Claude.ai Integrations pathway, OAuth 2.1 is the natural choice since Claude handles the OAuth flow. For the sandbox pathway (where code in the sandbox makes raw HTTP calls), bearer tokens or mTLS work better since there's no interactive OAuth flow available.

### Layer 2: The MCP Gateway

This is a Streamable HTTP MCP server that implements the actual tool definitions. It runs in stateless JSON mode (no session affinity), which means any request can be handled by any instance — important for reliability and for keeping the architecture simple. The gateway is the point where tool calls are validated, routed, and formatted.

The gateway should use the MCP TypeScript SDK or Python FastMCP, implementing tools with proper Zod/Pydantic schemas, annotations (readOnlyHint, destructiveHint, etc.), and structured output where possible. It receives authenticated, validated requests from the reverse proxy, translates them into calls to internal services via Tailscale, and returns the results.

One important design decision: should the gateway be a generic proxy that forwards MCP tool calls to downstream MCP servers on the tailnet, or should it be a purpose-built server that directly implements the tools? The answer depends on your use case. For a small number of well-defined tools (querying a database, reading from a Git repo, triggering a deployment), a purpose-built server is simpler and more secure. For a large, evolving ecosystem of internal MCP servers, a proxy/router pattern makes more sense — the gateway discovers and federates tools from multiple downstream servers.

### Layer 3: Tailscale

Tailscale runs on the bastion host and authenticates it into your tailnet. The bastion becomes a node on your private network, able to reach other nodes according to your ACL policy. The key security property is that the bastion can only reach the specific internal hosts that the ACL permits — it doesn't get blanket access to everything on the tailnet.

Tailscale can run in kernel mode (requires root/admin) or userspace mode (runs as a regular process). For a bastion that's a dedicated VM or container, kernel mode is fine. For a bastion running alongside other services, userspace mode provides better isolation.

## Tailscale ACL Configuration

The ACL policy is where the real security enforcement happens. Here's a concrete example that restricts the bastion to only the services it needs:

```jsonc
{
  "tagOwners": {
    // The bastion tag is owned by your infra team
    "tag:mcp-bastion": ["group:infra-admins"],
    // Tags for each internal service the bastion can reach
    "tag:internal-db":  ["group:infra-admins"],
    "tag:internal-api": ["group:infra-admins"],
    "tag:internal-git": ["group:infra-admins"]
  },

  "acls": [
    // The bastion can reach the internal database on port 5432 only
    {
      "action": "accept",
      "src":    ["tag:mcp-bastion"],
      "dst":    ["tag:internal-db:5432"]
    },
    // The bastion can reach the internal API on port 8080 only
    {
      "action": "accept",
      "src":    ["tag:mcp-bastion"],
      "dst":    ["tag:internal-api:8080"]
    },
    // The bastion can reach the Git server on ports 443 and 22
    {
      "action": "accept",
      "src":    ["tag:mcp-bastion"],
      "dst":    ["tag:internal-git:443", "tag:internal-git:22"]
    },
    // Nothing else — implicit deny for all other traffic from the bastion
  ],

  "tests": [
    // Verify the bastion can reach the DB
    {
      "src":    "tag:mcp-bastion",
      "accept": ["tag:internal-db:5432"]
    },
    // Verify the bastion CANNOT reach other services
    {
      "src":  "tag:mcp-bastion",
      "deny": ["tag:internal-db:22", "100.64.0.0/10:*"]
    }
  ]
}
```

This is the Tailscale equivalent of a traditional firewall policy, but with two important advantages. First, ACLs follow the identity of the node, not its IP address — if the bastion's IP changes (as Tailscale IPs can), the policy still applies. Second, the `tests` block lets you write assertions about your policy that are verified every time you save, catching misconfigurations before they go live.

## Configuration Per Surface

### For Claude.ai (Remote MCP Integration — the "Integrations" pathway)

This is the cleanest path. Claude.ai natively supports Remote MCP servers. You add your bastion's Streamable HTTP endpoint as an Integration:

1. In Claude.ai, go to Settings → Integrations (Team/Enterprise) or the Integrations panel (Max/Pro).
2. Add a new custom integration pointing to `https://bastion.yourcompany.com/mcp`.
3. If using OAuth, configure the OAuth callback URL as `https://claude.ai/api/mcp/auth_callback`.
4. Claude.ai will discover tools from your MCP server and make them available in conversations.

This path does not use the code execution sandbox at all — Claude talks to the MCP server via Anthropic's infrastructure. No domain allowlist configuration needed.

### For Claude.ai (Code Execution Sandbox — the "skill runs code" pathway)

If a skill needs to make HTTP calls to your bastion from within the sandbox (e.g., a Python script that calls your internal API), you need the bastion's domain on the sandbox allowlist:

1. In Admin Settings → Capabilities, enable "Allow network egress to package managers and specific domains."
2. Add `bastion.yourcompany.com` to the additional allowed domains.
3. Code in the sandbox can now `curl` or `requests.get()` your bastion.

Note the JWT bug (#19087): as of early 2026, custom domains may not be propagated to the sandbox's JWT. Monitor this issue. The workaround, if needed, is to use the Remote MCP Integration pathway instead.

### For Claude Code (Local CLI)

Claude Code can connect directly to the bastion:

```bash
# Add the bastion as a remote MCP server
claude mcp add --transport http bastion-mcp https://bastion.yourcompany.com/mcp

# If OAuth is configured, Claude Code will open a browser for authentication
# If using API key auth, set the environment variable
export MCP_BASTION_API_KEY="your-key"
```

Alternatively, if Claude Code's machine is on the Tailscale tailnet, it can bypass the bastion entirely and talk to internal MCP servers directly. The bastion is primarily useful for Claude Code when the developer's machine is not on the tailnet (e.g., working from a coffee shop without Tailscale running).

### For API Sandbox (GitHub Actions / CI/CD)

In your GitHub Action configuration:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    experimental_allowed_domains: |
      bastion.yourcompany.com
    # ... other configuration
```

The action container can now reach your bastion over HTTPS.

## The Cloudflare Tunnel Variant

For teams that want to avoid exposing any public IP at all, Cloudflare Tunnel (formerly Argo Tunnel) is a compelling alternative to a traditional reverse proxy. The bastion runs `cloudflared` which dials out to Cloudflare's edge. Inbound traffic to `bastion.yourcompany.com` is routed through Cloudflare's network to the tunnel, which delivers it to the bastion without the bastion needing any inbound ports open.

The architecture looks the same from Claude's perspective — it still makes HTTPS requests to `bastion.yourcompany.com`. But the bastion's attack surface is dramatically reduced: no inbound firewall rules, no public IP, no Let's Encrypt certificate management. Cloudflare handles TLS and DDoS protection at the edge.

The trade-off is a dependency on Cloudflare's infrastructure and the need to configure Cloudflare Access policies (which are analogous to the reverse proxy authentication layer). For enterprise teams already using Cloudflare, this is often the path of least resistance.

```
Claude Surface ──HTTPS──▶ Cloudflare Edge ──Tunnel──▶ Bastion ──Tailscale──▶ Internal Services
                          (TLS, WAF, Auth)           (no public IP)
```

## Security Model

The security posture of this architecture rests on four complementary layers:

**Layer 1 — Network boundary**: Only HTTPS on port 443 is exposed. The bastion has no other inbound ports. If using Cloudflare Tunnel, there are zero inbound ports.

**Layer 2 — Authentication**: Every request must present valid credentials (OAuth token, mTLS cert, or API key) before reaching the MCP gateway. This prevents unauthorized access even if someone discovers the bastion's URL.

**Layer 3 — Authorization at the MCP layer**: The MCP gateway validates tool calls against schemas and enforces tool-level permissions. A read-only tool cannot be tricked into performing writes. Destructive tools require explicit authorization. The gateway can also enforce per-user or per-team authorization if the authentication layer passes identity information through.

**Layer 4 — Tailscale ACLs**: Even if all three layers above are compromised, the bastion can only reach the specific internal services permitted by the Tailscale ACL policy. The blast radius of a compromise is limited to those services, on those ports, with those protocols. There is no lateral movement capability.

**Audit trail**: Each layer produces logs. The reverse proxy logs all inbound requests with timestamps, source IPs, and authentication outcomes. The MCP gateway logs tool invocations with parameters and results. Tailscale logs all connections between nodes. Together, these provide a complete audit trail from Claude's request to the internal service response.

## What Changes When Anthropic Expands Sandbox Networking

The architecture is designed with a clear upgrade path. Today, the bastion must be reachable over the public internet (or via Cloudflare Tunnel). If Anthropic introduces any of the following capabilities, the architecture simplifies:

**If sandboxes gain Tailscale/WireGuard support**: The bastion's public-facing reverse proxy becomes optional. The sandbox connects directly to the bastion (or even directly to internal services) over the tailnet. The Tailscale ACL layer still enforces access control.

**If sandboxes gain arbitrary network egress**: The bastion still provides value as a security choke point (authentication, authorization, audit logging), but the domain allowlist configuration step goes away.

**If Anthropic builds native VPN/tunnel integration** (as proposed in GitHub issue #10051): The bastion pattern may become unnecessary entirely. Claude's infrastructure would provision encrypted tunnels to registered environments, using Claude's own authentication to gate access.

In all three scenarios, the internal-facing architecture (MCP gateway + Tailscale ACLs + internal services) remains unchanged. Only the ingress layer simplifies.

## Implementation Checklist

1. **Provision the bastion host**: A small VM (2 CPU, 4GB RAM is plenty) in a cloud provider, or a machine in your own infrastructure. Install Tailscale and authenticate it to your tailnet. Tag it as `tag:mcp-bastion`.

2. **Configure Tailscale ACLs**: Write ACL rules that restrict the bastion to only the internal services your MCP tools need. Run the built-in ACL tests.

3. **Deploy the MCP gateway**: Implement a Streamable HTTP MCP server (TypeScript recommended for SDK maturity) that exposes the tools you need. Use stateless JSON mode. Test with the MCP Inspector (`npx @modelcontextprotocol/inspector`).

4. **Set up the reverse proxy**: Caddy, nginx, or Cloudflare Tunnel. Configure TLS and authentication. Test that unauthenticated requests are rejected.

5. **Configure each Claude surface**:
   - Claude.ai: Add as Remote MCP Integration and/or add domain to sandbox allowlist.
   - Claude Code: `claude mcp add --transport http bastion-mcp https://bastion.yourcompany.com/mcp`
   - CI/CD: Add to `experimental_allowed_domains`.

6. **Test end-to-end**: From each surface, invoke a tool and verify it reaches the internal service and returns correct results. Check audit logs at every layer.

7. **Monitor**: Set up alerting on authentication failures, unexpected tool invocations, and Tailscale ACL denials.

## Open Questions and Future Work

**Latency**: The round-trip through the public internet to the bastion and back through Tailscale adds latency compared to direct access. For interactive use in Claude.ai, this is likely acceptable (MCP tool calls are already async). For high-frequency tool calls in CI/CD, measure and optimize.

**Multi-region**: If your internal services span regions, consider running multiple bastion instances (one per region) with a GeoDNS or load-balancer in front, all on the same tailnet.

**Tool discovery and federation**: As the number of internal MCP servers grows, the bastion gateway needs a way to discover and federate tools from multiple downstream servers. This could be a simple config file, a service registry, or dynamic discovery via the MCP protocol itself.

**The Anthropic-Tailscale partnership possibility**: Lee Briggs from Tailscale explicitly called out the dream of giving Claude Tailscale OAuth credentials so it can provision its own private network for MCP connections. If this materializes, it would be the most elegant solution — zero public surface, zero bastion, just a direct tailnet connection from Claude to your services. The architecture above is designed to collapse cleanly into that future.
