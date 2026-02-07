# Security Review: Bastion MCP Server

**Review Date:** 2026-02-07
**Reviewer:** Automated Security Analysis (Claude Opus 4.6)
**Scope:** `bastion-mcp-server/src/` -- all middleware, services, tools, and configuration
**Codebase State:** Phases 2-6 implementation (auth, privilege tiers, sandbox execution, artifacts, sessions)

---

## 1. Executive Summary

The bastion MCP server implements a security-sensitive gateway that executes shell commands and proxies requests to internal services on behalf of Claude AI surfaces. The architecture demonstrates strong security fundamentals: mandatory authentication at startup, timing-safe API key comparison, tiered privilege validation, command denylisting, and structured audit logging.

However, several findings require attention before production deployment. The most critical issue is a **shell injection vulnerability in `exec_script`** that bypasses the privilege validation system entirely. Additional concerns include incomplete denylist coverage in the command validator, missing authorization context in execution tools, ReDoS potential in user-supplied regex patterns, and YAML deserialization without schema validation.

**Overall Risk Assessment:** MEDIUM-HIGH. The shell injection in `exec_script` is exploitable and high-severity. The remaining findings are medium or low severity but collectively widen the attack surface.

---

## 2. Risk Matrix

| ID | Severity | Category | File:Line | Finding | Recommendation |
|----|----------|----------|-----------|---------|----------------|
| SEC-01 | **CRITICAL** | Injection | `src/tools/exec-tools.ts:170-171` | `exec_script` bypasses privilege validation entirely. The script body is passed directly to `executeCommand` via `interpreter -c '...'` with only single-quote escaping. No `validateCommand()` call is made, so denylist/allowlist checks are skipped. An attacker with any auth token can execute arbitrary commands regardless of privilege level. | Apply `validateCommand()` to the composed command string before execution, or validate individual lines of the script body. Consider requiring privilege level 2 for `exec_script`, or remove the tool until a proper sandboxing strategy is in place. |
| SEC-02 | **HIGH** | Injection | `src/tools/exec-tools.ts:170` | The single-quote escaping (`script.replace(/'/g, "'\\''")`) is the sole defense against shell injection in `exec_script`. This pattern is fragile: if the interpreter is `bash`, constructs like `$()` or backticks inside the script can still be interpreted by the outer `/bin/sh -c` invocation in `sandbox.ts:43`. The command composition is `sh -c "bash -c '...'"`, creating a double-interpretation chain. | Write the script to a temporary file with restricted permissions (mode 0600) and execute the file directly (`spawn(interpreter, [tmpFile])`) instead of passing it via `-c`. Delete the temp file in a `finally` block. |
| SEC-03 | **HIGH** | Command Injection | `src/services/privilege.ts:41-55` | Hardcoded denylist patterns are bypassable. For example: (a) `rm -rf /` is blocked but `rm -rf /home` or `rm -rf /var` are not. (b) `curl ... \| sh` is blocked but `curl ... -o /tmp/x && sh /tmp/x` is not. (c) Semicolons, `&&`, `$()`, backticks allow chaining denied commands after allowed ones: `ls; rm -rf /`. (d) Base64 encoding (`echo ... \| base64 -d \| sh`) bypasses all pattern matching. | Denylist-only approaches are fundamentally incomplete for shell commands. For Level 0/1, validate the full pipeline (split on `;`, `&&`, `\|\|`, `\|`) and check each segment. Consider using a proper shell parser or running commands in a restricted container/namespace. Add explicit pipeline/chaining checks at all levels. |
| SEC-04 | **HIGH** | Authorization | `src/tools/exec-tools.ts:79-83` | The `exec_command` tool accepts `privilege_level` as a caller-supplied parameter. Any authenticated user can set `privilege_level: 2` to bypass all allowlist restrictions. The privilege level should be derived from the authenticated identity (JWT claims or role mapping), not from the request body. | Remove `privilege_level` from the tool input schema. Derive it from `authClaims.scope` or a new `role`/`privilege` claim in the JWT. Map API key users to a configured default privilege level. |
| SEC-05 | **MEDIUM** | ReDoS | `src/services/privilege.ts:80-84` | User-controlled regex patterns from config `denyPatterns` are compiled with `new RegExp(pattern)` on every command validation call. Malicious or poorly-written patterns (e.g., `(a+)+$`) can cause catastrophic backtracking, blocking the event loop. The same issue exists for `allowPatterns` at line 146. | Pre-compile all regex patterns at startup using `new RegExp()` and cache them. Validate patterns at config load time. Consider using the `re2` library (linear-time regex) for user-supplied patterns. Set a timeout on regex evaluation or use `safe-regex` to reject vulnerable patterns. |
| SEC-06 | **MEDIUM** | Deserialization | `src/config/loader.ts:147` | YAML parsing via the `yaml` package without schema restrictions allows potentially dangerous YAML constructs. While the `yaml` npm package (v2+) is safe by default (no `!!js/function` or `!!python/object`), the parsed output is cast to arbitrary types without validation. A malicious config file could inject unexpected structure that downstream code does not handle. | Add Zod or JSON Schema validation of the parsed config object immediately after loading. Define an explicit schema for the config file and reject unknown fields. |
| SEC-07 | **MEDIUM** | Path Traversal | `src/services/artifacts.ts:43-48` | Path traversal checks only look for `..` and `/` in `sessionId` and `name`. This misses: (a) backslash path separators on Windows (`..\\`), (b) URL-encoded variants (`%2e%2e`), (c) null bytes that can truncate path strings in some environments. The `download` method at line 73 checks `artifactId` but searches all session directories, meaning any authenticated user can download any artifact by ID (no session ownership check). | Use `path.resolve()` and verify the resulting path starts with `this.baseDir`. Add session ownership verification in `download()` and `list()` by checking that `sessionId` matches the authenticated user's session. Consider using `path.relative()` to detect traversal. |
| SEC-08 | **MEDIUM** | Information Disclosure | `src/middleware/mtls.ts:57-63` | The mTLS middleware returns `socket.authorizationError` directly to the client in the response body. This can leak internal CA configuration details, certificate chain information, or file system paths to unauthenticated callers. | Return a generic error message to the client. Log the detailed authorization error server-side only. |
| SEC-09 | **MEDIUM** | Missing AuthZ | `src/services/session.ts:88-98` | `listSessions()` returns all active sessions across all users. Any authenticated user can enumerate all other active sessions, including user IDs and timestamps. Similarly, `endSession()` has no ownership check -- any user can terminate another user's session. | Add `userId` filtering to `listSessions()`. Add ownership verification to `endSession()` and `getSession()`. Pass the authenticated `sub` claim through the call chain and enforce it. |
| SEC-10 | **MEDIUM** | Missing AuthZ | `src/services/job-manager.ts:70-72` | `getJob()` returns any job by ID with no ownership check. The job result includes full stdout/stderr output. An attacker who guesses or enumerates UUIDs could read the output of another user's command execution. | Add a `userId` field to the `Job` interface. Set it when `startJob()` is called and verify it matches the requesting user in `getJob()`. |
| SEC-11 | **LOW** | JWT Validation | `src/middleware/auth.ts:100-109` | When JWT `sub` claim is missing or not a string, it silently defaults to `'unknown'` rather than rejecting the token. When `exp` is missing, a synthetic 1-hour expiry is created. A JWT without `sub` or `exp` should be rejected as malformed, since these are essential security claims. | Reject JWTs missing the `sub` or `exp` claims with a 403 response. Remove the fallback defaults for security-critical claims. |
| SEC-12 | **LOW** | DoS | `src/services/session.ts:21` / `src/services/job-manager.ts:22` | Both sessions and jobs are stored in an unbounded in-memory `Map`. A sustained attack creating sessions or submitting jobs could exhaust server memory. The 60-second cleanup intervals help but do not prevent burst attacks. | Add a maximum capacity to both maps. Reject new sessions/jobs when at capacity. Consider per-user limits. |
| SEC-13 | **LOW** | Configuration | `src/config/loader.ts:60-64` | The JWT secret is read from `BASTION_JWT_SECRET` environment variable. There is no minimum length enforcement. A short or weak secret (e.g., `"secret"`) would make JWT forgery trivial via brute force. | Enforce a minimum secret length (e.g., 32 bytes) at startup. Log a warning if the secret has low entropy. Consider supporting asymmetric keys (RS256/ES256) where the signing key never leaves the issuer. |
| SEC-14 | **LOW** | Logging | `src/services/audit.ts:99-119` | The `sanitizeInputs` function only checks top-level keys against sensitive patterns. Nested objects (e.g., `{ config: { password: "..." } }`) are not inspected. The `command` field in `exec_command` audit entries could contain embedded secrets (e.g., `curl -H 'Authorization: Bearer ...'`). | Recursively sanitize nested objects. Add pattern matching on command string values to redact inline tokens and credentials. |
| SEC-15 | **LOW** | Transport | `src/index.ts:159-163` | stdio transport mode skips all authentication (`runStdio` does not apply auth middleware). While documented as "local development only," there is no runtime guard preventing `TRANSPORT=stdio` from being set in production. | Add a guard: if `NODE_ENV=production` and `TRANSPORT=stdio`, refuse to start or log a prominent warning. Consider requiring an explicit `--allow-unauthenticated` flag. |

---

## 3. Phase-Specific Guidance

### Phase 2: Authentication Middleware (`auth.ts`, `mtls.ts`)

**What was done well:**
- Timing-safe comparison for API keys using SHA-256 + `timingSafeEqual` (auth.ts:129-132)
- Mandatory auth at startup -- no fallback to unauthenticated mode (loader.ts:76-79)
- JWT verification with issuer check (auth.ts:95-96)
- mTLS checks `socket.authorized` to verify CA chain (mtls.ts:56)

**What needs attention:**
- SEC-11: Harden JWT claim validation. Require `sub` and `exp`.
- SEC-08: Do not expose mTLS authorization error details to clients.
- The JWT `algorithms` option is not set in `jwt.verify()` (auth.ts:95). This means the library will accept any algorithm the secret can verify, including `none` in some older `jsonwebtoken` versions. Explicitly set `algorithms: ['HS256']` (or whichever algorithm you intend to support).
- Consider adding `audience` validation to JWT verification for multi-tenant deployments.

### Phase 3: Privilege Tiers & Command Validation (`privilege.ts`)

**What was done well:**
- Three-tier model with escalating permissions is a sound design
- Denylist is checked at ALL levels, including Level 2 (privilege.ts:71-76)
- Level 0 has a curated read-only allowlist with git subcommand validation
- `extractBaseCommand` handles env var prefix assignments

**What needs attention:**
- SEC-03: The denylist approach has fundamental bypass vectors via shell metacharacters.
- SEC-04: Privilege level must not be caller-controlled.
- SEC-05: Pre-compile and validate user-supplied regex patterns.
- Level 0 allows `env` (line 28) which can be used to inspect all environment variables, including `BASTION_JWT_SECRET` and `BASTION_API_KEY`. Remove `env` from the Level 0 allowlist or filter its output.
- Level 0 allows `echo` which combined with shell features (`echo $(cat /etc/shadow)`) could be abused, though the base command check may mitigate this partially.

### Phase 4: Sandboxed Execution (`sandbox.ts`, `job-manager.ts`)

**What was done well:**
- Timeout enforcement via `AbortController` (sandbox.ts:40-41)
- Output truncation at `CHARACTER_LIMIT` prevents memory exhaustion (sandbox.ts:54-61)
- Job cleanup prevents unbounded memory growth (job-manager.ts:24-33)
- `.unref()` on cleanup intervals prevents keeping the process alive

**What needs attention:**
- SEC-01/SEC-02: The sandbox itself just runs `/bin/sh -c <command>` -- all safety depends on upstream validation, which `exec_script` bypasses.
- SEC-10: Jobs lack ownership tracking.
- The sandbox does not set `uid`/`gid`, does not use `cgroups`, does not use `chroot`/`namespaces`, and does not restrict filesystem access. The name "sandbox" is aspirational. For production, consider running commands in a container, a nsjail sandbox, or at minimum with a dedicated unprivileged user.
- When `options.env` is not provided, `undefined` is passed to spawn, which inherits the full `process.env` (sandbox.ts:46). This exposes all server environment variables (including secrets) to executed commands.

### Phase 5: Artifact Storage (`artifacts.ts`)

**What was done well:**
- Path traversal checks for `..` and `/` in sessionId, name, and artifactId
- UUID-based artifact IDs prevent name collision attacks
- Metadata stored separately from data

**What needs attention:**
- SEC-07: Path traversal checks are incomplete; use `path.resolve` + prefix validation.
- No file size limits on uploads. A single large upload could fill the disk.
- No total storage quota per session or per user.
- The `download` method iterates all session directories (artifacts.ts:80), which is both a performance concern and an authorization bypass (any user can download any artifact if they know the UUID).
- Metadata files are parsed with `JSON.parse` without schema validation (artifacts.ts:85, 106). Corrupted or tampered metadata files could cause unexpected behavior.

### Phase 6: Session Management (`session.ts`, `session-tools.ts`)

**What was done well:**
- TTL-based expiry with automatic cleanup
- UUID session IDs prevent guessing
- Zod validation on tool input schemas (session-tools.ts:84)

**What needs attention:**
- SEC-09: No session ownership enforcement. Any user can list/end any session.
- SEC-12: No cap on total sessions in memory.
- The `session_start` tool attempts to read `authClaims` from `extra._meta` (session-tools.ts:49), but auth claims are set on `req.authClaims` by the Express middleware and may not propagate to the MCP tool handler via `_meta`. Verify that this path actually delivers claims; if not, sessions may all be created as `anonymous`.

---

## 4. Positive Security Patterns

The codebase demonstrates several security-conscious design decisions that should be preserved and extended:

1. **Timing-safe API key comparison** (`auth.ts:129-132`): Using `createHash('sha256')` + `timingSafeEqual` prevents timing side-channel attacks. This is the correct approach.

2. **Mandatory authentication enforcement** (`loader.ts:76-79`): The config loader throws at startup if no auth strategy is configured. This eliminates the risk of accidentally running without auth.

3. **Defense-in-depth denylist** (`privilege.ts:71-76`): The hardcoded denylist is always checked regardless of privilege level, providing a safety net even at Level 2.

4. **Structured audit logging** (`audit.ts`): Every tool invocation is audited with request ID, user identity, tool name, inputs, backend host, response code, and duration. This provides a solid compliance and forensic trail.

5. **Input sanitization in audit logs** (`audit.ts:99-119`): Sensitive-looking keys are redacted before logging, reducing the risk of credential leakage via log aggregation.

6. **Output truncation** (`sandbox.ts:54-61`): Prevents memory exhaustion from commands that produce unbounded output.

7. **JSON-RPC error format for auth failures** (`tool-scope.ts:45-52`): The tool scope middleware returns proper JSON-RPC errors with the request ID, maintaining protocol compliance.

8. **Non-blocking health checks** (`index.ts:54-58`): Backend health checks run asynchronously and do not block server startup, improving resilience.

9. **Typed Express request extension** (`types.ts:161-168`): Using TypeScript module augmentation for `req.authClaims` avoids unsafe type casts throughout the codebase.

10. **Environment variable precedence** (`loader.ts`): The layered config approach (defaults < file < env vars) follows 12-factor app principles and makes secrets manageable via env vars without config files.

---

## 5. Priority Remediation Order

1. **SEC-01 + SEC-02** (CRITICAL): Fix `exec_script` shell injection and add privilege validation. This is exploitable today.
2. **SEC-04** (HIGH): Remove caller-controlled `privilege_level`. This is the second most impactful fix.
3. **SEC-03** (HIGH): Strengthen command validation against shell metacharacter bypass. Add pipeline/chain splitting.
4. **SEC-07 + SEC-09 + SEC-10** (MEDIUM): Add ownership checks across artifacts, sessions, and jobs.
5. **SEC-05 + SEC-06** (MEDIUM): Validate config inputs (regex patterns, YAML schema).
6. **Sandbox hardening**: Restrict `process.env` exposure, consider container-based isolation, remove `env` from Level 0 allowlist.
7. **SEC-11 through SEC-15** (LOW): Address remaining items as part of production hardening.
