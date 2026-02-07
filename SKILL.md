---
name: bastion-bridge
description: Secure bridge to internal infrastructure via Tailscale mesh
version: 0.1.0
tools:
  - bastion_db_query
  - bastion_api_request
  - bastion_check_connectivity
auth: Bearer token (JWT or API key)
transport: Streamable HTTP (POST /mcp)
---

# Bastion Bridge Skill

This skill provides Claude with authenticated access to private internal
services through an MCP bastion server running on a Tailscale mesh.

## Available Tools

### `bastion_db_query`
Run read-only SQL queries against internal analytics or metrics databases.

```
query: "SELECT COUNT(*) FROM events WHERE created_at > NOW() - INTERVAL '7 days'"
database: "analytics"  # or "metrics"
```

### `bastion_api_request`
Make authenticated HTTP requests to internal REST APIs.

```
service: "users"        # Logical service name from the registry
method: "GET"           # GET, POST, PUT, DELETE
path: "/v1/users/123"   # API path (must start with /)
body: '{"name":"Alice"}' # Optional JSON body for POST/PUT
```

### `bastion_check_connectivity`
Ping all registered backend services and report their health status.
No arguments required — returns a markdown table of service status and latency.

## Authentication

Every request to the bastion requires a Bearer token:

- **JWT** (recommended): Scoped tokens with `sub`, `tools`, `source`, and `exp` claims.
  The `tools` array restricts which MCP tools the token can invoke.
- **API Key**: Simple shared secret for single-tenant setups.

## Configuration Profiles

The bastion supports base + overlay configuration for multi-environment deployments:

| Profile | Use Case |
|---------|----------|
| `mac-local` | Local Docker Compose backends on localhost |
| `aws-dev` | Tailscale mesh on AWS dev account |
| `gcp-prod` | Tailscale mesh on GCP production |
| `k8s-staging` | Kubernetes internal DNS |

Set `BASTION_CONFIG_BASE` and `BASTION_CONFIG_OVERLAY` environment variables
to merge a base config with an environment-specific overlay.

## Example Workflow

1. Check connectivity: call `bastion_check_connectivity` to verify backend access
2. Query data: use `bastion_db_query` for read-only analytics
3. Call APIs: use `bastion_api_request` for CRUD operations on internal services

## Security Model

- TLS termination at Caddy/nginx (never bypassed)
- JWT/API key auth on every request
- Tailscale ACLs enforce least-privilege network access
- Per-tool authorization via JWT `tools` claim
- Rate limiting (60 req/min per principal)
- Full audit trail with sensitive field redaction
