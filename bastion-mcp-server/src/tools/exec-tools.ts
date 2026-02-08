/**
 * Command execution tools for the bastion MCP server.
 *
 * These tools let Claude execute shell commands on the bastion host
 * with privilege-tier validation and sandboxed execution.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { createBackendClient } from '../services/backend.js';
import { startAudit } from '../services/audit.js';
import { validateCommand, getCommandAllowlist, type PrivilegeConfig } from '../services/privilege.js';
import { executeCommand, executeScript } from '../services/sandbox.js';
import { startJob, getJob } from '../services/job-manager.js';
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from '../constants.js';

type BackendClient = ReturnType<typeof createBackendClient>;

// Default privilege config — can be overridden via bastion config in the future
const defaultPrivilegeConfig: PrivilegeConfig = {
  allowPatterns: [],
  denyPatterns: [],
};

/**
 * Derive privilege level from auth claims scope.
 * The privilege level is server-controlled, never caller-supplied.
 *   - 'admin' or 'privilege:2' → Level 2 (permissive)
 *   - 'operator' or 'privilege:1' → Level 1 (configured allowlist)
 *   - everything else → Level 0 (read-only)
 */
export function resolvePrivilegeLevel(scope?: string): number {
  if (!scope) return 0;
  if (scope === 'admin' || scope === 'privilege:2') return 2;
  if (scope === 'operator' || scope === 'privilege:1') return 1;
  return 0;
}

/**
 * Register command execution tools on the MCP server.
 */
export function registerExecTools(
  server: McpServer,
  _backend: BackendClient
): void {
  registerExecCommandTool(server);
  registerExecScriptTool(server);
  registerGetAllowlistTool(server);
  registerCheckJobTool(server);
}

// ─── exec_command ────────────────────────────────────────────────────────────

function registerExecCommandTool(server: McpServer): void {
  server.registerTool(
    'exec_command',
    {
      title: 'Execute Shell Command',
      description: `Execute a shell command on the bastion host with privilege-tier validation.

Privilege levels (derived from auth token scope, not caller-controlled):
  - 0 (read-only): Only safe read commands (ls, cat, grep, git status, etc.)
  - 1 (configured): Commands matching admin-configured regex patterns
  - 2 (permissive): All commands except the hardcoded denylist

A hardcoded denylist blocks dangerous commands (rm -rf /, mkfs, fork bombs, etc.)
at ALL privilege levels.

For commands expected to take >60s, set timeout_seconds > 60 and the command
will be submitted as a background job. Use check_job_status to poll for results.

Args:
  - command (string): Shell command to execute
  - timeout_seconds (number): Max execution time, 1-300 (default: 30)

Returns:
  Command output (stdout/stderr), exit code, and duration.`,
      inputSchema: {
        command: z.string().min(1).describe('Shell command to execute'),
        timeout_seconds: z.number().int().min(1).max(300).default(30)
          .describe('Maximum execution time in seconds'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ command, timeout_seconds }, extra) => {
      // Derive privilege level from auth claims — never caller-controlled
      const claims = extra._meta?.authClaims as { scope?: string } | undefined;
      const privilegeLevel = resolvePrivilegeLevel(claims?.scope);

      const audit = startAudit('exec_command', { command, privilegeLevel });

      // Validate command against privilege tier
      const validation = validateCommand(command, privilegeLevel, defaultPrivilegeConfig);
      if (!validation.allowed) {
        audit.failure('bastion', 403, validation.reason);
        return {
          isError: true,
          content: [{ type: 'text', text: `Command denied: ${validation.reason}` }],
        };
      }

      const timeoutMs = timeout_seconds * 1000;

      // Long-running commands → background job
      if (timeoutMs > DEFAULT_COMMAND_TIMEOUT_MS * 2) {
        const jobId = startJob(command, Math.min(timeoutMs, MAX_COMMAND_TIMEOUT_MS));
        audit.success('bastion', 202);
        return {
          content: [{
            type: 'text',
            text: `Command submitted as background job.\nJob ID: ${jobId}\nUse check_job_status to poll for results.`,
          }],
        };
      }

      // Execute inline
      const result = await executeCommand(command, { timeoutMs });

      const text = [
        `Exit code: ${result.exitCode}`,
        `Duration: ${result.durationMs}ms`,
        result.truncated ? '(output truncated)' : '',
        '',
        result.stdout ? `--- stdout ---\n${result.stdout}` : '',
        result.stderr ? `--- stderr ---\n${result.stderr}` : '',
      ].filter(Boolean).join('\n');

      if (result.exitCode === 0) {
        audit.success('bastion', 200);
      } else {
        audit.failure('bastion', 500, `Exit code ${result.exitCode}`);
      }

      return {
        isError: result.exitCode !== 0,
        content: [{ type: 'text', text }],
      };
    }
  );
}

// ─── exec_script ─────────────────────────────────────────────────────────────

function registerExecScriptTool(server: McpServer): void {
  server.registerTool(
    'exec_script',
    {
      title: 'Execute Script',
      description: `Execute a multi-line script on the bastion host.

The script is written to a temporary file, executed with the specified
interpreter, and the temp file is cleaned up afterward.

Args:
  - script (string): The script content
  - interpreter (string): 'sh', 'bash', or 'python3' (default: 'sh')
  - timeout_seconds (number): Max execution time (default: 30)

Returns:
  Script output (stdout/stderr), exit code, and duration.`,
      inputSchema: {
        script: z.string().min(1).describe('Script content to execute'),
        interpreter: z.enum(['sh', 'bash', 'python3']).default('sh')
          .describe('Script interpreter'),
        timeout_seconds: z.number().int().min(1).max(300).default(30)
          .describe('Maximum execution time in seconds'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ script, interpreter, timeout_seconds }, extra) => {
      const audit = startAudit('exec_script', { interpreter, scriptLength: script.length });

      // Derive privilege level from auth claims (same as exec_command)
      const claims = extra._meta?.authClaims as { scope?: string } | undefined;
      const privilegeLevel = resolvePrivilegeLevel(claims?.scope);

      // Validate each non-empty, non-comment line of the script against the
      // privilege tier denylist. This catches dangerous commands embedded in scripts.
      const lines = script.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

        const validation = validateCommand(trimmed, privilegeLevel, defaultPrivilegeConfig);
        if (!validation.allowed) {
          audit.failure('bastion', 403, validation.reason);
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Script denied at line: ${trimmed}\nReason: ${validation.reason}`,
            }],
          };
        }
      }

      // Execute via temp file — no shell escaping, no double-interpretation chain
      const result = await executeScript(script, interpreter, {
        timeoutMs: timeout_seconds * 1000,
      });

      const text = [
        `Interpreter: ${interpreter}`,
        `Exit code: ${result.exitCode}`,
        `Duration: ${result.durationMs}ms`,
        result.truncated ? '(output truncated)' : '',
        '',
        result.stdout ? `--- stdout ---\n${result.stdout}` : '',
        result.stderr ? `--- stderr ---\n${result.stderr}` : '',
      ].filter(Boolean).join('\n');

      if (result.exitCode === 0) {
        audit.success('bastion', 200);
      } else {
        audit.failure('bastion', 500, `Exit code ${result.exitCode}`);
      }

      return {
        isError: result.exitCode !== 0,
        content: [{ type: 'text', text }],
      };
    }
  );
}

// ─── get_command_allowlist ───────────────────────────────────────────────────

function registerGetAllowlistTool(server: McpServer): void {
  server.registerTool(
    'get_command_allowlist',
    {
      title: 'Get Command Allowlist',
      description: `Returns the list of allowed commands/patterns for a given privilege level.

Args:
  - privilege_level (number): 0, 1, or 2

Returns:
  The allowlist for the requested privilege level.`,
      inputSchema: {
        privilege_level: z.number().int().min(0).max(2)
          .describe('Privilege level to query'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ privilege_level }) => {
      const allowlist = getCommandAllowlist(privilege_level, defaultPrivilegeConfig);
      const text = [
        `## Command Allowlist — Level ${privilege_level}`,
        '',
        ...allowlist.map((cmd) => `- \`${cmd}\``),
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }
  );
}

// ─── check_job_status ────────────────────────────────────────────────────────

function registerCheckJobTool(server: McpServer): void {
  server.registerTool(
    'check_job_status',
    {
      title: 'Check Job Status',
      description: `Check the status and results of a background job.

Args:
  - job_id (string): The job ID returned by exec_command

Returns:
  Job status (running/completed/failed) and results if complete.`,
      inputSchema: {
        job_id: z.string().uuid().describe('Job ID to check'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      const job = getJob(job_id);

      if (!job) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Job not found: ${job_id}` }],
        };
      }

      if (job.status === 'running') {
        return {
          content: [{
            type: 'text',
            text: `Job ${job_id} is still running.\nStarted: ${job.startedAt.toISOString()}\nCommand: ${job.command}`,
          }],
        };
      }

      const result = job.result;
      const text = [
        `Job ${job_id}: ${job.status}`,
        `Command: ${job.command}`,
        `Started: ${job.startedAt.toISOString()}`,
        `Completed: ${job.completedAt?.toISOString() ?? 'N/A'}`,
        '',
        result ? `Exit code: ${result.exitCode}` : '',
        result ? `Duration: ${result.durationMs}ms` : '',
        result?.truncated ? '(output truncated)' : '',
        '',
        result?.stdout ? `--- stdout ---\n${result.stdout}` : '',
        result?.stderr ? `--- stderr ---\n${result.stderr}` : '',
      ].filter(Boolean).join('\n');

      return {
        isError: job.status === 'failed',
        content: [{ type: 'text', text }],
      };
    }
  );
}
