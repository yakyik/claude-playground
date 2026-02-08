# claude-playground

A secure bastion MCP server that bridges Claude to internal services over a Tailscale mesh network.

<!-- [![CI](https://github.com/jo824/claude-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/jo824/claude-playground/actions/workflows/ci.yml) -->

## What & Why

Claude (claude.ai, Claude Code, and the API) cannot reach services behind your firewall — databases, REST APIs, monitoring dashboards, or anything on a private network. **claude-playground** solves this by deploying a bastion MCP server that sits on your [Tailscale](https://tailscale.com) mesh, exposing internal resources as MCP tools that Claude can call safely.

The result: Claude can query your analytics database, hit internal APIs, and run scoped shell commands — all through authenticated, audited, privilege-controlled tool calls.

See [bastion-architecture.md](bastion-architecture.md) for the full design.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Surface (claude.ai / Code / API)                     │
│  ──────────────────────────────────────────────────────────── │
│  Calls MCP tools via Streamable HTTP or stdio                │
└────────────────────┬─────────────────────────────────────────┘
                     │ HTTPS (TLS terminated by Caddy)
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  Bastion Host                                                │
│  ┌──────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │  Caddy   │→ │  MCP Server (TS) │→ │ Tailscale Sidecar │  │
│  │  :443    │  │  :3001           │  │  (userspace)      │  │
│  └──────────┘  └──────────────────┘  └─────────┬─────────┘  │
└────────────────────────────────────────────────┬─────────────┘
                                                 │ WireGuard (Tailnet)
          ┌──────────────────────────────────────┼──────────┐
          ▼                  ▼                   ▼          │
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐    │
   │ analytics-db │   │  users-api  │   │ inventory   │    │
   │ :5432        │   │  :8080      │   │  :3000      │    │
   └─────────────┘   └─────────────┘   └─────────────┘    │
          Private Network / Tailnet                         │
```

| Component | Role |
|---|---|
| **bastion-mcp-server** | TypeScript MCP server — registers tools, authenticates requests, proxies to backends |
| **playground-ctl** | Go CLI — provisions and manages bastion infrastructure across providers |
| **Caddy** | TLS termination, reverse proxy, security headers |
| **Tailscale sidecar** | Joins the tailnet so the MCP server can reach internal services via MagicDNS |
| **Terraform (AWS/GCP)** | Infrastructure-as-code for cloud deployments |
| **K8s manifests** | Kubernetes deployment, service, and configmap |
| **GitHub Actions CI** | Lint, typecheck, test, Docker build, Go build |

## Repository Structure

```
claude-playground/
├── bastion-mcp-server/          # TypeScript MCP server (ESM, Node 22+)
│   ├── src/
│   │   ├── config/              # Config loader, strategic merge
│   │   ├── middleware/          # Auth (JWT/API key/mTLS), rate limiting, tool scoping
│   │   ├── services/           # Audit, backend client, privilege tiers, sessions, sandbox
│   │   ├── tools/              # MCP tool implementations (10 tools)
│   │   ├── constants.ts        # Shared constants
│   │   ├── types.ts            # TypeScript type definitions
│   │   └── index.ts            # Entry point
│   ├── config/                  # Config profiles and examples
│   │   ├── base/               # Base configuration templates
│   │   └── profiles/           # Environment overlays (mac-local, aws-dev, gcp-prod, k8s-staging)
│   ├── docker/                  # Dockerfile, Caddyfile, mock fixtures
│   ├── scripts/                 # Token generation utility
│   ├── docker-compose.yml       # Production stack (Caddy + MCP + Tailscale)
│   └── docker-compose.dev.yml   # Dev stack with mock backends
├── cmd/playground-ctl/          # Go CLI entry point
├── internal/                    # Go packages
│   ├── cmd/                    # Cobra CLI commands (up, down, status, connect)
│   ├── config/                 # Go config loading & strategic merge
│   └── provider/               # Infrastructure providers (lima, docker, aws, gcp, k8s)
├── providers/                   # Terraform & K8s manifests
│   ├── aws/                    # EC2 + Tailscale (main.tf, variables.tf, outputs.tf)
│   ├── gcp/                    # Compute Engine + Tailscale
│   └── k8s/                    # Kubernetes deployment manifests
├── bastion-architecture.md      # Architecture deep dive
├── SKILL.md                     # Claude skill definition
├── SECURITY-REVIEW.md           # Security review (Phase 1-4)
├── SECURITY-REVIEW-v2.md        # Security review (Phase 5-6)
├── project-status.md            # Implementation status tracker
├── TESTING-PLAN.md              # Human-led testing plan
├── Makefile                     # Build orchestration
├── go.mod / go.sum              # Go module
└── .github/workflows/ci.yml    # CI pipeline
```

## Quick Start

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 22+ | MCP server runtime |
| Go | 1.22+ | playground-ctl CLI |
| Docker | 24+ | Container builds |
| Tailscale | Latest | Mesh networking |

### Path 1: Local Development

```bash
# Install dependencies
make install

# Build everything
make build

# Run tests
make test

# Start the dev server (auto-reload)
make dev

# In another terminal, check health
curl http://localhost:3001/health
```

### Path 2: Docker Compose (dev with mock backends)

```bash
cd bastion-mcp-server

# Start MCP server + 3 mock backend services
docker compose -f docker-compose.dev.yml up -d

# Test with API key auth
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-api-key-12345" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Tear down
docker compose -f docker-compose.dev.yml down
```

### Path 3: Cloud Provisioning

```bash
# Build the Go CLI
make build-go

# Configure
cp bastion-mcp-server/config/playground.yaml.example playground.yaml
# Edit playground.yaml with your provider settings

# Provision on AWS
make provision-aws

# Or GCP
make provision-gcp

# Or Kubernetes
make provision-k8s

# Check status
make status
```

## MCP Tools Reference

| Tool | Category | Description | Read-only |
|---|---|---|---|
| `bastion_db_query` | Database | Run read-only SQL queries against internal databases | Yes |
| `bastion_api_request` | API | Make HTTP requests to internal services (GET/POST/PUT/DELETE) | No |
| `bastion_check_connectivity` | Diagnostics | Ping all registered backends and report health | Yes |
| `exec_command` | Execution | Execute shell commands with privilege-tier validation | No |
| `exec_script` | Execution | Execute multi-line scripts with sandbox isolation | No |
| `get_command_allowlist` | Execution | Returns allowed commands/patterns for a privilege level | Yes |
| `check_job_status` | Execution | Check status and results of background jobs | Yes |
| `session_start` | Session | Create a new bastion session (30-min TTL) | No |
| `session_end` | Session | End a bastion session by ID | No |
| `session_list` | Session | List all active bastion sessions | Yes |

## Configuration Reference

### Environment Variables

All environment variables are loaded in [`bastion-mcp-server/src/config/loader.ts`](bastion-mcp-server/src/config/loader.ts).

#### Authentication

| Variable | Description | Default |
|---|---|---|
| `BASTION_JWT_SECRET` | HMAC secret for JWT validation. Selects `jwt` auth strategy when set. | _(none — required for JWT)_ |
| `BASTION_JWT_ISSUER` | Expected `iss` claim in JWT tokens | `bastion-mcp-server` |
| `BASTION_API_KEY` | Shared secret for API key auth. Fallback when `BASTION_JWT_SECRET` is not set. | _(none — required for API key)_ |

#### Server

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port | `3001` |
| `SERVER_NAME` | Server name in MCP handshake | `bastion-mcp-server` |
| `LOG_LEVEL` | Logging level (`debug`, `info`, `warn`, `error`) | `info` |
| `HEALTH_CHECK_ENABLED` | Enable `/health` endpoint | `true` |
| `TRANSPORT` | Transport mode (`http` or `stdio`) | `http` |
| `ALLOW_STDIO_NO_AUTH` | Allow stdio transport without auth credentials (dev only) | `false` |

#### Service Registry

| Variable | Description | Default |
|---|---|---|
| `BASTION_CONFIG_PATH` | Path to a single config file (JSON or YAML) | _(none)_ |
| `BASTION_CONFIG_BASE` | Path to base config file (for strategic merge) | _(none)_ |
| `BASTION_CONFIG_OVERLAY` | Path to overlay config file (merged on top of base) | _(none)_ |
| `BASTION_SERVICES` | Inline JSON array of backend services | `[]` |

#### Docker / Tailscale

| Variable | Description | Default |
|---|---|---|
| `TS_AUTHKEY` | Tailscale auth key for the sidecar container | _(required)_ |
| `BASTION_DOMAIN` | Domain for Caddy TLS certificate provisioning | `bastion.localhost` |

### Constants

Defined in [`bastion-mcp-server/src/constants.ts`](bastion-mcp-server/src/constants.ts):

| Constant | Value | Description |
|---|---|---|
| `CHARACTER_LIMIT` | 50,000 | Max characters before truncation |
| `DEFAULT_TIMEOUT_MS` | 10,000 | Backend request timeout |
| `DEFAULT_PAGE_SIZE` | 20 | Default pagination size |
| `MAX_PAGE_SIZE` | 100 | Maximum pagination size |
| `RATE_LIMIT_RPM` | 60 | Max requests/minute per principal |
| `DEFAULT_COMMAND_TIMEOUT_MS` | 30,000 | Default command execution timeout |
| `MAX_COMMAND_TIMEOUT_MS` | 300,000 | Maximum command execution timeout |

### YAML Config (playground-ctl)

The Go CLI uses a YAML config file (default: `playground.yaml`):

```yaml
provider: docker          # lima | docker | aws | gcp | k8s

bastion:
  image: bastion-mcp-server:latest
  port: 3001
  auth: jwt               # jwt | api-key

services:
  - name: analytics-db
    url: http://analytics-db.tail1234.ts.net:5432
    healthCheckPath: /health
    timeoutMs: 5000
  - name: users-api
    url: http://users-api.tail1234.ts.net:8080
    timeoutMs: 10000
    headers:
      X-Internal: "true"
```

### Strategic Merge

The MCP server supports layered configuration via base + overlay files. The overlay is strategically merged on top of the base:

- **Scalars** (strings, numbers, booleans): overlay wins
- **Arrays**: overlay replaces the entire array
- **Objects**: deep-merged recursively

```bash
# Base: common settings shared across environments
export BASTION_CONFIG_BASE=config/base/common.yaml

# Overlay: environment-specific overrides
export BASTION_CONFIG_OVERLAY=config/profiles/aws-dev.yaml
```

### Configuration Profiles

| Profile | File | Use Case |
|---|---|---|
| `mac-local` | `config/profiles/mac-local.yaml` | Local Docker Compose backends on localhost |
| `aws-dev` | `config/profiles/aws-dev.yaml` | Tailscale mesh on AWS dev account |
| `gcp-prod` | `config/profiles/gcp-prod.yaml` | Tailscale mesh on GCP production |
| `k8s-staging` | `config/profiles/k8s-staging.yaml` | Kubernetes internal DNS |

### Terraform Variables

#### AWS (`providers/aws/variables.tf`)

| Variable | Description | Default |
|---|---|---|
| `region` | AWS region | `us-east-1` |
| `instance_type` | EC2 instance type | `t3.micro` |
| `tailscale_auth_key` | Tailscale auth key (sensitive) | _(required)_ |
| `bastion_api_key` | API key for MCP server (sensitive) | _(required)_ |
| `bastion_image` | Docker image for bastion | `bastion-mcp-server:latest` |

#### GCP (`providers/gcp/variables.tf`)

| Variable | Description | Default |
|---|---|---|
| `project` | GCP project ID | _(required)_ |
| `region` | GCP region | `us-central1` |
| `zone` | GCP zone | `us-central1-a` |
| `machine_type` | GCE machine type | `e2-micro` |
| `tailscale_auth_key` | Tailscale auth key (sensitive) | _(required)_ |
| `bastion_api_key` | API key for MCP server (sensitive) | _(required)_ |
| `bastion_image` | Docker image for bastion | `bastion-mcp-server:latest` |

### Kubernetes Secrets

The K8s deployment expects these secrets in the `bastion` namespace:

```bash
kubectl create secret generic bastion-auth \
  --from-literal=jwt-secret="$(openssl rand -hex 32)" \
  --namespace bastion

kubectl create secret generic tailscale-auth \
  --from-literal=auth-key="tskey-auth-..." \
  --namespace bastion
```

## Security Model

The bastion enforces security through four complementary layers:

| Layer | Mechanism | What It Protects |
|---|---|---|
| **1. Transport** | TLS via Caddy (auto Let's Encrypt) | Data in transit |
| **2. Authentication** | JWT / API key / mTLS | Identity verification |
| **3. Network** | Tailscale ACLs + `tag:bastion` | Lateral movement prevention |
| **4. Authorization** | 3-tier privilege system + tool scoping | Blast radius containment |

### Privilege Tiers

| Level | Name | Behavior |
|---|---|---|
| 0 | Read-only | Hardcoded allowlist only (`ls`, `cat`, `grep`, `git status`, etc.) |
| 1 | Configured | Config-provided regex allowlist + denylist |
| 2 | Permissive | All commands except hardcoded denylist |

**Hardcoded denylist** (enforced at all levels): `rm -rf /`, `mkfs`, `dd` to devices, fork bombs, `shutdown`/`reboot`, `chmod 777 /`, pipe-to-shell patterns (`curl | sh`), and shell expansion at levels 0-1.

See [SECURITY-REVIEW.md](SECURITY-REVIEW.md) and [SECURITY-REVIEW-v2.md](SECURITY-REVIEW-v2.md) for full audits.

## CLI Reference

### playground-ctl

```
playground-ctl [command] [flags]
```

#### Commands

| Command | Description |
|---|---|
| `up` | Create and start bastion infrastructure |
| `down` | Stop and remove bastion infrastructure |
| `status` | Show infrastructure status (provider, running, address, uptime) |
| `connect` | SSH into the running bastion instance |

#### Global Flags

| Flag | Description | Default |
|---|---|---|
| `--config` | Config file path | `playground.yaml` |
| `--provider` | Infrastructure provider (`lima`, `docker`, `aws`, `gcp`, `k8s`) | from config |

#### Providers

| Provider | Backend | Notes |
|---|---|---|
| `lima` | Lima VM | macOS local development |
| `docker` | Docker Compose | Lightweight local/CI |
| `aws` | EC2 + Terraform | Production cloud |
| `gcp` | Compute Engine + Terraform | Production cloud |
| `k8s` | Kubernetes | Cluster deployment |

## Test Suite

125 tests across 12 files, all passing.

```bash
# Run all tests
make test

# Watch mode
make test-watch

# TypeScript only
cd bastion-mcp-server && npm test

# With coverage
cd bastion-mcp-server && npx vitest run --coverage
```

Key test suites: privilege (16), loader (11), merge (8), session (8), artifacts (8).

CI runs on every push and PR to `main`: lint, typecheck, test, Docker build, Go build.

## Roadmap

Suggested next features (not prioritized):

- **OAuth 2.1** — Replace HMAC JWT with proper OAuth flow and PKCE
- **Distributed rate limiting** — Redis-backed rate limiter for multi-instance deployments
- **Container sandboxing** — Run exec_command/exec_script in ephemeral containers
- **Asymmetric JWT** — RS256/ES256 with public key distribution
- **OpenTelemetry** — Distributed tracing across bastion and backends
- **Multi-region federation** — Federated bastion instances with shared session state
- **Cloudflare Tunnel** — Alternative to Tailscale for teams already on Cloudflare
- **Session ownership** — Bind sessions to authenticated principals
- **YAML schema validation** — JSON Schema for config files with editor autocompletion
- **Test coverage gaps** — Integration tests, E2E with real Tailscale, load tests

## Related Documents

- [bastion-architecture.md](bastion-architecture.md) — Full architecture design
- [SKILL.md](SKILL.md) — Claude skill definition
- [SECURITY-REVIEW.md](SECURITY-REVIEW.md) — Security audit (Phases 1-4)
- [SECURITY-REVIEW-v2.md](SECURITY-REVIEW-v2.md) — Security audit (Phases 5-6)
- [project-status.md](project-status.md) — Implementation status
- [TESTING-PLAN.md](TESTING-PLAN.md) — Human-led testing plan
- [bastion-mcp-server/README.md](bastion-mcp-server/README.md) — MCP server package docs
