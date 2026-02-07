# Bastion MCP Server

A single authenticated HTTPS endpoint that gives Claude secure access to your private infrastructure over a Tailscale mesh network.

## What This Does

Claude operates in sandboxed environments (Claude.ai, API containers) that can only reach a curated list of domains. This server acts as a **bastion bridge** — you add one domain to Claude's allowlist, and behind that domain, the bastion fans out to your internal services over Tailscale with fine-grained ACLs controlling what's reachable.

```
Claude sandbox ──HTTPS──▶ bastion.yourcompany.com ──Tailscale──▶ internal services
     (one domain                (auth + audit)         (ACLs limit
      on allowlist)                                     blast radius)
```

The bastion speaks [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) Streamable HTTP, so Claude treats it as a native tool surface. You register tools on the bastion that proxy requests to your internal APIs, databases, and services.

## Quick Start

### Prerequisites

You'll need a VM or container with a public IP (or behind a load balancer), [Tailscale](https://tailscale.com) installed and authenticated on your tailnet, and Node.js 20+.

### 1. Clone and install

```bash
git clone https://github.com/yourorg/bastion-mcp-server.git
cd bastion-mcp-server
npm install
```

### 2. Configure

```bash
cp .env.example .env
cp config/services.example.json config/services.json
```

Edit `.env` with your auth secret and Tailscale key. Edit `config/services.json` with your actual tailnet service URLs.

### 3. Run locally (development)

```bash
# HTTP mode — test with curl or MCP Inspector
npm run dev

# stdio mode — test with Claude Code
TRANSPORT=stdio npm run dev
```

### 4. Deploy with Docker Compose (production)

```bash
docker compose up -d
```

This starts the full stack: Caddy (TLS termination), the MCP server, and a Tailscale sidecar container. Caddy automatically provisions Let's Encrypt certificates for your domain.

### 5. Configure Claude's allowlist

For **Claude.ai**: Go to Admin Settings → Capabilities → Network access → Add `bastion.yourcompany.com` to the domain allowlist.

For **Claude Code** (local): No allowlist needed — Claude Code has full network access. Add the bastion as an MCP server:

```bash
claude mcp add bastion --type streamable-http \
  --url https://bastion.yourcompany.com/mcp \
  --header "Authorization: Bearer $BASTION_TOKEN"
```

For **CI/CD** (GitHub Actions with claude-code-action): Add `bastion.yourcompany.com` to `experimental_allowed_domains`.

## Project Structure

```
bastion-mcp-server/
├── src/
│   ├── index.ts              # Entry point — wires everything together
│   ├── types.ts              # TypeScript type definitions
│   ├── constants.ts          # Shared constants (timeouts, limits, paths)
│   ├── config/
│   │   └── loader.ts         # Config from env vars + JSON file
│   ├── middleware/
│   │   └── auth.ts           # JWT / API key validation
│   ├── services/
│   │   ├── logger.ts         # Structured JSON logging (Winston)
│   │   ├── audit.ts          # Tool invocation audit trail
│   │   └── backend.ts        # HTTP client for tailnet services
│   └── tools/
│       └── example-tools.ts  # Example tool registrations
├── config/
│   └── services.example.json # Example service registry
├── docker/
│   ├── Dockerfile            # Multi-stage build for the MCP server
│   └── Caddyfile             # TLS termination config
├── docs/
│   └── tailscale-acl-example.jsonc  # Example Tailscale ACL policy
├── scripts/
│   └── generate-token.mjs    # JWT token generation utility
├── docker-compose.yml        # Full stack: Caddy + MCP server + Tailscale
├── package.json
├── tsconfig.json
└── .env.example
```

## Adding Your Own Tools

Tools live in `src/tools/`. Each tool is a function that registers itself on the MCP server and uses the backend client to reach internal services. Here's the pattern:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startAudit } from '../services/audit.js';

export function registerMyTool(server: McpServer, backend: BackendClient) {
  server.registerTool(
    'bastion_my_tool',
    {
      title: 'My Custom Tool',
      description: 'What this tool does, with examples.',
      inputSchema: {
        param: z.string().describe('What this parameter controls'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ param }) => {
      const audit = startAudit('bastion_my_tool', { param });
      try {
        const { data, host } = await backend.request('my-service', `/api/endpoint?q=${param}`);
        audit.success(host, 200);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        audit.failure('my-service', 500, err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );
}
```

Then import and call your registration function in `src/index.ts`.

## Security Model

The bastion's security comes from **defense in depth** across three layers. The outermost layer is TLS and authentication: Caddy terminates TLS, and every request must carry a valid JWT or API key. The middle layer is Tailscale ACLs: even if the bastion is fully compromised, the attacker can only reach the specific service:port pairs you've listed in the ACL policy. The innermost layer is audit logging: every tool invocation is recorded with enough detail to reconstruct what happened.

See `docs/tailscale-acl-example.jsonc` for a complete ACL policy template.

## Architecture

For the full architecture design document (including deployment topologies, progressive enhancement roadmap, and threat model), see the companion architecture doc in the project's design files.

## Token Generation

Generate scoped JWT tokens for different Claude surfaces:

```bash
node scripts/generate-token.mjs \
  --secret "$BASTION_JWT_SECRET" \
  --sub "alice@yourcompany.com" \
  --source "claude-ai" \
  --tools "bastion_db_query,bastion_api_request" \
  --ttl "24h"
```

The `--tools` flag restricts which MCP tools the token can invoke. Leave it empty to allow all tools.

## Known Issues

The Claude.ai "Additional allowed domains" setting has a [known bug](https://github.com/anthropics/claude-code/issues/19087) where custom domains may not propagate to the sandbox JWT. Monitor that issue — when fixed, the allowlist approach works end-to-end without workarounds.

## License

MIT
