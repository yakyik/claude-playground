# Project Status: claude-playground

**Timestamp:** 1770501820 (2026-02-07)
**Reviewer:** ML engineer assessing Claude Code workflow improvements

---

## Repository Contents

| Artifact | Purpose | Status |
|---|---|---|
| `project_artifact.md` | Original architecture vision — persistent remote compute via MCP bridge with 3-tier privilege model, Lima VMs, multi-cloud providers, SKILL.md integration | Design doc only |
| `bastion-architecture.md` | Revised architecture — pivots to bastion pattern with Tailscale ACLs behind single HTTPS endpoint | Design doc only |
| `bastion-mcp-server/` | Actual implementation of the bastion MCP server | Scaffolded, ~70% of core server |

---

## Scope Pivot

The original `project_artifact.md` describes a 6+ month system (Lima integration, multi-cloud Terraform, command sandboxing via rbash, mTLS PKI, eBPF audit, session lifecycle, artifact storage). The project correctly pivoted to a narrower bastion MCP gateway — the ~20% of the vision that delivers ~80% of the value: giving Claude access to internal services behind a Tailscale mesh.

---

## Completion: Original Vision (`project_artifact.md`)

```
Overall: ~10-15%

Design/Architecture docs:  ████████████████████  100%
Bastion MCP server core:   ██████████████░░░░░░   70%
Privilege tiers (0/1/2):   ░░░░░░░░░░░░░░░░░░░░    0%
Command sandboxing:        ░░░░░░░░░░░░░░░░░░░░    0%
Provider abstraction:      ░░░░░░░░░░░░░░░░░░░░    0%
Config overlay system:     ░░░░░░░░░░░░░░░░░░░░    0%
CLI (playground-ctl):      ░░░░░░░░░░░░░░░░░░░░    0%
mTLS / certificate auth:   ░░░░░░░░░░░░░░░░░░░░    0%
Session lifecycle:         ░░░░░░░░░░░░░░░░░░░░    0%
File sync / artifacts:     ░░░░░░░░░░░░░░░░░░░░    0%
SKILL.md integration:      ░░░░░░░░░░░░░░░░░░░░    0%
Tests:                     ░░░░░░░░░░░░░░░░░░░░    0%
CI/CD:                     ░░░░░░░░░░░░░░░░░░░░    0%
```

---

## Completion: Bastion-Only Scope (`bastion-architecture.md`)

```
Overall: ~55-60%

MCP gateway server:        ██████████████████░░   90%
Auth (JWT + API key):      ████████████████████  100%
Audit logging:             ████████████████████  100%
Backend service client:    ████████████████████  100%
Docker/Compose deploy:     ████████████████████  100%
Caddy TLS termination:     ████████████████████  100%
Tailscale ACL template:    ████████████████████  100%
Token generation script:   ████████████████████  100%
Tool-scope enforcement:    ██░░░░░░░░░░░░░░░░░░   10%  (data extracted, not enforced)
Rate limiting:             ██░░░░░░░░░░░░░░░░░░   10%  (constants defined, not wired)
Real tools (not examples): ░░░░░░░░░░░░░░░░░░░░    0%
Tests:                     ░░░░░░░░░░░░░░░░░░░░    0%
E2E validation:            ░░░░░░░░░░░░░░░░░░░░    0%
```

---

## Built Components Detail

### `bastion-mcp-server/`

| Module | File | Status | Notes |
|---|---|---|---|
| Entry point / server wiring | `src/index.ts` | Done | Express + MCP SDK Streamable HTTP + stdio dual transport |
| Type definitions | `src/types.ts` | Done | AuthClaims, BackendService, AuditEntry, BastionConfig |
| Constants | `src/constants.ts` | Done | Character limits, timeouts, rate limit values |
| Config loader | `src/config/loader.ts` | Done | Loads from env vars + JSON file, validates auth present |
| Auth middleware | `src/middleware/auth.ts` | Done | JWT + API key, timing-safe comparison, claim extraction |
| Structured logging | `src/services/logger.ts` | Done | Winston, JSON format, stderr-safe |
| Audit service | `src/services/audit.ts` | Done | Per-invocation audit with secret redaction |
| Backend client | `src/services/backend.ts` | Done | Service registry, fetch + timeout, health checks |
| Example tools | `src/tools/example-tools.ts` | Partial | 3 tools; health check is a stub |
| Docker deployment | `docker/Dockerfile` | Done | Multi-stage, non-root, health check |
| Docker Compose | `docker-compose.yml` | Done | Caddy + MCP server + Tailscale sidecar |
| Caddy config | `docker/Caddyfile` | Done | TLS, reverse proxy, security headers |
| Service registry example | `config/services.example.json` | Done | 5 example services |
| JWT token generator | `scripts/generate-token.mjs` | Done | CLI with TTL, scoping |
| Tailscale ACL template | `docs/tailscale-acl-example.jsonc` | Done | Least-privilege with tag owners |

### Not Built

| Component | Notes |
|---|---|
| Tool-scope enforcement middleware | JWT `tools` claim extracted but never checked against invoked tool |
| Rate limiting middleware | Constants defined, no Express middleware |
| Tests | vitest configured in package.json, zero test files |
| ESLint config | devDependency installed, no config file |
| Health check tool (real) | Stub — doesn't iterate registry |
| Git repo | `git init` not run |
| npm install / build | No `node_modules/`, no `dist/`, no lock file |
| CI/CD | No GitHub Actions workflow |
| SKILL.md | No Claude skill definition |

---

## Blockers for Production Use

1. Project has never been compiled (`npm install && npm run build` not run)
2. Tool-scope enforcement missing — JWTs carry scopes but nothing enforces them
3. Rate limiting not wired — security boundary with no throttling
4. Zero tests on a security-critical component
5. Health check tool is a placeholder
6. No git history

---

## Assessment

The architectural thinking is strong. The scope pivot from the original mega-system to a focused bastion gateway was the right call. The code that exists is clean, well-commented, and follows MCP SDK patterns correctly. The Docker Compose stack with Tailscale sidecar networking is deployment-ready.

The gap between current state and usable MVP is primarily: compile verification, two missing middleware layers (tool-scope + rate-limit), tests, and E2E validation.
