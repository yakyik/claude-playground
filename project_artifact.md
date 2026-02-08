# Claude-Playground: architecture for persistent remote compute

**Claude's sandbox resets on every session, has limited or no network egress, and cannot run heavy toolchains — but a well-designed skill can bridge it to a user-owned VM or cloud instance that persists across sessions.** This architecture defines "claude-playground," an open-source, forkable system that connects Claude's ephemeral environment to a user's persistent remote compute through an MCP-based bridge daemon, with a three-tier privilege model governing what Claude can do. The design draws on Claude Code's open-sourced sandbox runtime, Teleport-style certificate auth, Kustomize-style configuration overlays, and the devcontainer.json standard — battle-tested patterns adapted for the specific constraints of AI agent remote execution.

---

## How Claude skills work and what constrains them

Every Claude skill is a directory containing a **`SKILL.md`** file with YAML frontmatter (name, description, optional fields like `allowed-tools` and `context`) and a markdown body of instructions. Claude discovers skills through a **three-level progressive loading** system: Level 1 loads only the ~100-token metadata into the system prompt; Level 2 loads the full SKILL.md body when Claude determines relevance through semantic matching; Level 3 loads bundled scripts and assets on demand. This means hundreds of skills can coexist with minimal context cost.

Skills can bundle **scripts** (`scripts/` directory — Python, Bash, any executable), **reference documentation** (`references/`), and **static assets** (`assets/` — templates, fonts, icons, config files). Scripts execute via bash without loading source into context — only their output enters the conversation. Pre-installed Python packages in the API sandbox include pyarrow, openpyxl, pillow, python-pptx, pypdf, pandas, numpy, and matplotlib, plus Node.js. The Claude Code environment can install packages from PyPI and npm at runtime; the API cannot.

The sandbox constraints create the core problem claude-playground solves. **API code execution has zero network access** — skills cannot make external API calls or reach the internet. Claude.ai's sandbox is configurable by admins across four tiers (no egress → package managers only → specific domains → all domains), but the default for Teams is package-managers-only. The filesystem resets between conversations in Claude.ai (though API containers can be reused by providing a `container_id`). Claude Code operates directly on the user's filesystem with full network access, but its web variant runs in an isolated Anthropic-managed VM with restricted network. This means any skill that needs to compile Go binaries, run `cargo build`, execute test suites, or access private repos must delegate that work to a persistent external environment.

Skills are shared through different channels depending on the surface. Claude Code uses filesystem-based discovery (project skills in `.claude/skills/`, personal skills in `~/.claude/skills/`), making Git the natural distribution mechanism. The **Agent Skills open standard** at agentskills.io enables cross-platform portability — the same SKILL.md works in Claude Code, OpenAI Codex CLI, and other conforming tools. Anthropic's official skills repo at `github.com/anthropics/skills` provides reference implementations under Apache 2.0. A community marketplace at skillsmp.com aggregates **160,000+** agent skills from GitHub.

---

## The three-tier privilege model

The security architecture centers on a **tiered privilege system** that governs what Claude can execute on the remote environment. Each tier adds capabilities while maintaining audit coverage.

**Level 0 — Read-only / Sync-only.** Claude can read files, list directories, query environment state (`go version`, `uname -a`, `df -h`), and sync project state bidirectionally. No mutations. Implemented via SSH `ForceCommand` pointing to a read-only gateway script, AppArmor profiles denying write access outside `/tmp`, and `authorized_keys` restrictions (`command="/usr/local/bin/readonly-gateway",restrict`). This tier is safe enough to run without human approval prompts.

**Level 1 — Scoped execution.** Claude can run a pre-approved set of commands defined in the configuration file: `go build`, `go test`, `make`, `cargo build`, `npm test`, and user-defined scripts. The bridge daemon validates every command against an **allowlist with argument patterns** before execution. Implementation uses a combination of restricted shell (`rbash`) with a curated `$PATH` containing only symlinks to approved binaries, plus a wrapper daemon that parses and validates commands against regex patterns in the config. Example allowlist entry: `go (build|test|vet|fmt).*` permits Go toolchain commands but blocks `go run` (arbitrary execution). Sudo rules provide an additional enforcement layer: `agent_user ALL=(ALL) NOPASSWD: /usr/local/bin/go build *, /usr/local/bin/go test *`.

**Level 2 — Full autonomy.** Claude can run arbitrary commands within the VM or container. This tier should only be used inside **ephemeral, disposable environments** (Firecracker microVMs, Docker containers with `--rm`, or dedicated VMs that can be snapshotted and rolled back). Even at Level 2, the system enforces: no write access to `/etc/cron.*` or `/var/spool/cron/` (prevents persistent background tasks), no modification of `.bashrc`, `.ssh/`, or systemd unit files (prevents persistence mechanisms), network egress limited to allowlisted destinations, and automatic session termination after a configurable TTL.

**Every command at every tier is audit-logged.** The bridge daemon writes structured JSON logs containing the command, arguments, user identity, session ID, timestamp, exit code, truncated stdout/stderr, and execution duration. Logs are written to append-only storage that the agent cannot modify. For Level 2 environments, kernel-level logging via **eBPF** (the Teleport enhanced session recording pattern) captures all process execution, filesystem changes, and network activity — even commands hidden through encoding or script execution.

---

## MCP as the bridge protocol

The **Model Context Protocol** is the natural bridge between Claude's sandbox and the remote environment. An MCP server running on (or accessible from) the user's machine exposes tools for command execution, file operations, and environment management. Claude connects to this server as an MCP client.

The bridge daemon (called `playground-bridge`) is a lightweight Go or TypeScript binary that runs on the remote environment and exposes three MCP tool categories:

**Execution tools** implement the privilege tiers. `exec_command` accepts a command string, validates it against the configured privilege level, executes it in a sandboxed subprocess, and returns stdout/stderr with exit code. `exec_script` runs a named script from the project's `scripts/` directory. `get_command_allowlist` returns the current allowlist so Claude can understand what it's permitted to do.

**File tools** handle bidirectional sync. `read_file` and `write_file` operate on individual files. `sync_project` performs rsync-style delta synchronization between Claude's sandbox and the remote workspace. `list_artifacts` returns available build outputs, compiled binaries, and test results.

**Environment tools** manage session lifecycle. `health_check` verifies the remote environment is reachable and healthy. `get_env_info` returns installed toolchain versions, disk space, and system state. `session_start` authenticates and initializes the workspace. `session_end` syncs artifacts back and closes connections.

For transport, the daemon supports **Streamable HTTP** (for remote access over the internet) and **STDIO** (for local access when running on the same machine). When Claude's sandbox connects over the internet, the daemon listens behind a **Cloudflare Tunnel** or **Tailscale Funnel** — both provide encrypted transport without opening inbound firewall ports. The daemon authenticates incoming connections via **mTLS**: Claude's sandbox presents a client certificate signed by the project's private CA, and the daemon presents its server certificate. Short-lived certificates with **1-hour TTLs** are issued by a lightweight CA (step-ca or HashiCorp Vault PKI engine) and auto-renewed by a sidecar process.

Several community MCP servers already implement pieces of this pattern. **classfang/ssh-mcp-server** (officially listed in the MCP community repository) supports command whitelist/blacklist and multiple SSH connections. **weidwonder/terminal-mcp-server** provides session persistence with 20-minute reuse windows. The claude-playground bridge daemon builds on these patterns with the addition of structured privilege tiers, audit logging, and the configuration-driven approach described below.

---

## Lima as the default local environment

For ML engineers working on macOS, **Lima** is the recommended default backend — it's free (Apache 2.0), CNCF-backed, CLI-native, and generates SSH configs automatically. On Apple Silicon with the VZ (Virtualization.framework) backend, Lima runs Linux VMs at **near-native speed** with VirtioFS file sharing.

The recommended setup creates a persistent Ubuntu VM with pre-installed toolchains:

```yaml
# ~/.lima/claude-playground.yaml
vmType: vz
arch: aarch64
cpus: 4
memory: 8GiB
disk: 50GiB
images:
  - location: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-arm64.img"
mounts:
  - location: "~/claude-playground-shared"
    mountPoint: "/home/user.linux/shared"
    writable: true
portForwards:
  - guestPortRange: [8000, 9000]
    hostPortRange: [8000, 9000]
provision:
  - mode: system
    script: |
      apt-get update && apt-get install -y build-essential git curl jq tmux
  - mode: user
    script: |
      curl https://mise.run | sh
      ~/.local/bin/mise use --global go@latest node@latest python@latest rust@latest
      # Install the playground-bridge daemon
      go install github.com/claude-playground/bridge@latest
```

Lima VMs persist in `~/.lima/<vm_name>/` and survive reboots. A macOS `launchd` plist ensures the VM starts automatically on login. SSH access is immediate via the auto-generated config at `~/.lima/claude-playground/ssh.config` — no manual key management required.

To expose the Lima VM to Claude's cloud sandbox, **Cloudflare Tunnel** is optimal: it's free with no bandwidth limits, provides DDoS protection and Zero Trust access policies, and requires zero inbound firewall rules. The `cloudflared` daemon runs inside the VM and creates an outbound-only connection to Cloudflare's edge network. For teams where both endpoints can install software, **Tailscale** provides even lower latency via peer-to-peer WireGuard encryption with fine-grained ACLs. For maximum control with no third-party dependency, a **reverse SSH tunnel** via `autossh` to a small VPS works but requires managing the VPS.

For file synchronization between Claude's sandbox and the remote VM, **Mutagen** is the strongest choice: bidirectional with conflict handling, works over SSH, auto-deploys its agent to the remote, and provides near-real-time sync via filesystem watching. For simpler one-way push scenarios, `rsync` triggered by `fswatch` is lightweight and dependency-free.

---

## Extending to cloud and Kubernetes backends

The architecture uses a **provider abstraction** — separate implementations for each backend behind a shared interface contract — rather than attempting a lowest-common-denominator universal module. The `providers/` directory contains:

- **`providers/local/`**: Lima VM on macOS (default). Vagrantfile for cross-platform local VMs.
- **`providers/aws/`**: Terraform module provisioning an EC2 instance in a private subnet with IAM instance profile, security group restricting SSH to the Cloudflare/Tailscale ingress, and EFS mount for persistent home directories. Uses EC2 Instance Connect Endpoint for keyless SSH.
- **`providers/gcp/`**: Terraform module for GCE instance with Workload Identity, OS Login for SSH, and Persistent Disk for workspace.
- **`providers/k8s/`**: Kubernetes manifests deploying the bridge daemon as a pod with a `devcontainer.json`-based init container for toolchain setup, PersistentVolumeClaim for workspace, and NetworkPolicy restricting egress.

A thin CLI (`playground-ctl`) selects the right provider based on the active profile in `config/playground.yaml`. It handles `playground-ctl up` (provision environment), `playground-ctl connect` (establish tunnel and start bridge), `playground-ctl status` (health check), and `playground-ctl down` (teardown). The CLI is provider-agnostic — it delegates to provider-specific scripts via a simple interface: `up()`, `down()`, `ssh_config()`, `health()`.

**Artifact storage** uses S3/GCS (or MinIO for local S3-compatible storage) with a standardized key format: `{project}/{environment}/{session-id}/{artifact-path}`. Build outputs, compiled binaries, and test results are synced to object storage at session end and pulled at session start. IAM policies restrict access per-project and per-environment using path-based authorization.

VPC security follows the principle of least privilege. EC2 security groups allow inbound SSH only from the Cloudflare/Tailscale network. All other inbound traffic is blocked. Outbound traffic is limited to package registries, the artifact storage bucket, and the Cloudflare/Tailscale control plane. For Kubernetes, NetworkPolicies enforce pod-level egress restrictions, and Pod Security Standards (Restricted profile) prevent privilege escalation.

---

## Configuration repository and composable profiles

The repository uses **YAML with base+overlays** (the Kustomize pattern), chosen over TOML (awkward for deep nesting) and HCL (tied to HashiCorp ecosystem). The configuration hierarchy:

```
claude-playground/
├── SKILL.md                           # The Claude skill definition
├── scripts/
│   └── playground-bridge              # Bridge daemon binary or install script
├── config/
│   ├── base/
│   │   └── playground.yaml            # Default settings, all environments
│   └── profiles/
│       ├── mac-local.yaml             # Lima VM on macOS
│       ├── aws-dev.yaml               # EC2 dev instance
│       ├── gcp-prod.yaml              # GCE production
│       └── k8s-staging.yaml           # Kubernetes staging
├── providers/
│   ├── local/                         # Lima/Vagrant configs
│   ├── aws/                           # Terraform modules
│   ├── gcp/                           # Terraform modules
│   └── k8s/                           # Kubernetes manifests + devcontainer.json
├── examples/
│   └── playground.yaml.example        # Annotated example config
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   └── SETUP.md
├── .gitignore                         # Secrets, state, credentials
├── .github/
│   └── workflows/
│       └── validate.yml               # CI: lint configs, test bridge daemon
└── LICENSE                            # Apache 2.0
```

The base configuration file defines the core contract:

```yaml
# config/base/playground.yaml
version: "1"
environment:
  provider: local                      # local | aws | gcp | k8s
  connection:
    transport: cloudflare-tunnel       # cloudflare-tunnel | tailscale | reverse-ssh | direct
    tunnel_name: claude-playground
    mtls:
      ca_cert: "${PLAYGROUND_CA_CERT}" # Environment variable reference
      client_cert: "${PLAYGROUND_CLIENT_CERT}"
      client_key: "${PLAYGROUND_CLIENT_KEY}"
      cert_ttl: 3600                   # seconds

security:
  privilege_level: 1                   # 0 = read-only, 1 = scoped, 2 = full
  allowed_commands:                    # Only used when privilege_level = 1
    - "go (build|test|vet|fmt|mod).*"
    - "cargo (build|test|check|clippy).*"
    - "make.*"
    - "npm (test|run build|run lint).*"
    - "python -m pytest.*"
    - "git (status|diff|log|show).*"
  denied_commands:                     # Blocked at all privilege levels
    - "rm -rf /"
    - "sudo.*"
    - "curl.*|wget.*"                  # Prevent data exfiltration
    - "ssh.*"                          # Prevent lateral movement
  session:
    max_duration: 7200                 # seconds
    idle_timeout: 1800                 # seconds
    audit_log_path: /var/log/playground/audit.jsonl

toolchain:
  go: "1.23"
  python: "3.12"
  node: "22"
  rust: "stable"
  additional_packages:                 # apt packages to install
    - build-essential
    - jq
    - tmux

project:
  repos:                               # Repos to clone at session start
    - url: "https://github.com/org/project.git"
      path: "/workspace/project"
      branch: "main"
  env_vars:                            # Non-secret env vars
    GOPATH: "/home/user/go"
    CARGO_HOME: "/home/user/.cargo"

artifacts:
  storage: s3                          # s3 | gcs | minio | local
  bucket: "playground-artifacts"
  sync_on_start:                       # Pull these at session start
    - "project/latest/go.sum"
    - "project/latest/vendor/"
  sync_on_end:                         # Push these at session end
    - "bin/*"
    - "dist/*"
    - "coverage/**"
```

Profile overlays merge with the base using strategic merge semantics. A `mac-local.yaml` profile overrides only the provider-specific fields (`provider: local`, Lima VM settings) while inheriting everything else. An `aws-dev.yaml` profile sets `provider: aws`, adds EC2 instance type, security group IDs, and changes artifact storage to the team's S3 bucket. Secrets are **never stored in config files** — all credential references use `${ENV_VAR}` syntax, resolved at runtime from environment variables, a `.env` file (gitignored), or a secrets manager.

The `.gitignore` excludes `*.pem`, `*.key`, `.env`, `.env.*`, `*.tfstate`, `*.tfvars`, and `**/.terraform/` while keeping `.env.example` committed as documentation.

---

## Session lifecycle from start to finish

A Claude session interacting with the remote environment follows a deterministic lifecycle:

**Session start** (triggered by Claude invoking the skill): The bridge daemon authenticates the incoming connection via mTLS certificate verification. It then runs an idempotent initialization sequence: verify toolchain versions match config requirements (`go version` ≥ 1.23), clone or pull configured repos (skip if already at latest commit — safe to re-run), restore artifacts from object storage, set environment variables, and return a session ID plus environment health summary. The entire init sequence is **idempotent** — if a connection drops mid-initialization and Claude reconnects, re-running init produces the same result without side effects.

**During session**: Claude sends commands through the MCP tools. Each command flows through the privilege validator → audit logger → sandboxed executor → output formatter. Long-running operations (builds, test suites) stream output in chunks to avoid overwhelming Claude's context window. The bridge daemon automatically **truncates output exceeding 4,000 tokens** and provides a summary with the option to fetch specific sections. For operations lasting more than 60 seconds, the daemon returns a job ID that Claude can poll for status — this prevents context window bloat from blocking waits.

**Session end** (triggered by Claude, by idle timeout, or by max duration): The daemon syncs configured artifacts to object storage, generates a session summary (commands executed, files changed, test results, duration), writes the final audit log entry, closes the mTLS connection, and if using Level 2 privilege, destroys the ephemeral container. No cleanup of the persistent workspace occurs — the next session picks up where this one left off.

**Handling context window limits**: When Claude approaches its context limit during a long session, the skill instructs Claude to write a session state summary to a markdown file in the shared workspace before context compaction occurs. On the next turn (or in a new conversation), Claude reads this file to restore context. This mirrors Claude Code's own context compressor pattern, which triggers at **~92% context utilization**.

---

## Lessons from existing tools shape key design decisions

Claude Code's architecture validates several choices in this design. Its **single-threaded main loop** (the "nO" pattern) with flat message history proves that simplicity beats multi-agent swarms for debuggability. Its open-sourced **sandbox-runtime** (`github.com/anthropic-experimental/sandbox-runtime`) provides reusable OS-level sandboxing primitives — bubblewrap on Linux, Seatbelt on macOS — that claude-playground can adopt directly for the bridge daemon's local execution environment. The permission system's `allow`/`deny` pattern with glob matching (`Bash(npm run test)`, `Bash(git diff:*)`) directly inspired the `allowed_commands` regex patterns in the config.

The **devcontainer.json** specification (containers.dev) is adopted as the environment definition format for Kubernetes and Docker-based backends. Its **Features** system — composable, self-contained units of installation code — solves the toolchain composition problem elegantly. A claude-playground devcontainer.json can specify `ghcr.io/devcontainers/features/go:1`, `ghcr.io/devcontainers/features/rust:1`, and `ghcr.io/devcontainers/features/python:1` to get reproducible toolchains without custom Dockerfiles.

The security failures of Cursor and Windsurf provide cautionary counterexamples. OWASP researchers documented a repeatable attack chain — **prompt injection → configuration overwrite → remote code execution** (CVE-2025-59944 and others) — showing that agentic IDEs without zero-trust design are fundamentally vulnerable. Claude-playground addresses this through defense-in-depth: OS-level sandboxing (Layer 1), privilege-tier command validation (Layer 2), network egress restrictions (Layer 3), and mandatory audit logging (Layer 4). The bridge daemon never trusts commands from Claude without validation, regardless of the prompt context.

**DevPod** (by Loft Labs) validates the provider-abstraction approach: it uses devcontainer.json as the universal spec and supports local Docker, remote VMs, and Kubernetes pods through swappable provider plugins — exactly the pattern claude-playground's `providers/` directory implements. **DevSpace** contributes the SSH server injection pattern for remote IDE access and bidirectional file sync — both directly applicable.

The **intelligentcode-ai/claude-code-vm** project on GitHub already implements a 4-tier deployment system for Claude Code on remote VMs, demonstrating community demand for this capability. Its Makefile-based approach with SSH key deployment provides a simpler but less secure baseline that claude-playground improves upon with mTLS, privilege tiers, and structured configuration.

---

## Conclusion

The claude-playground architecture solves a real gap: Claude's sandboxed environment cannot run production toolchains, and ML engineers need persistent development environments that survive across sessions. The system's core innovation is combining **MCP as the bridge protocol** with a **three-tier privilege model** enforced at the OS level, not just the application level.

Three design decisions deserve emphasis. First, using **mTLS with short-lived certificates** rather than static SSH keys eliminates the most common credential compromise vector — certificates auto-expire, require no manual revocation, and bind identity cryptographically. Second, the **base+overlay configuration** pattern means a team can fork the repo, set their privilege level and allowed commands in a profile overlay, and have a working system without modifying core code. Third, making the bridge daemon an **MCP server** rather than a custom protocol means it works not just with Claude's skill system but with any MCP-compatible client — Claude Desktop, Claude Code, VS Code with MCP extensions, or future tools conforming to the standard.

The most critical unsolved challenge is **transport from Claude's API sandbox**, which has zero network access. For API-surface skills, the bridge must be invoked indirectly — the skill generates a script that the user runs locally to establish the connection, or the skill operates in a "generate instructions" mode where Claude produces commands for the user to execute. For Claude.ai with domain-allowlisted network access and Claude Code (full network), direct MCP connections work. This transport gap will likely close as Anthropic expands sandbox networking capabilities, and the architecture is designed to take advantage of that the moment it happens.
