/**
 * Sandboxed command execution service.
 *
 * Executes shell commands with timeout enforcement, output capture,
 * and output truncation. Uses child_process.spawn with /bin/sh -c
 * for shell interpretation.
 */

import { spawn } from 'node:child_process';
import { CHARACTER_LIMIT, DEFAULT_COMMAND_TIMEOUT_MS } from '../constants.js';

export interface ExecutionOptions {
  /** Timeout in milliseconds (default: DEFAULT_COMMAND_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

/**
 * Execute a shell command with sandboxing constraints.
 */
export async function executeCommand(
  command: string,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const timeout = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const start = Date.now();

  return new Promise<ExecutionResult>((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const child = spawn('/bin/sh', ['-c', command], {
      signal: controller.signal,
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < CHARACTER_LIMIT) {
        stdout += chunk.toString();
        if (stdout.length > CHARACTER_LIMIT) {
          stdout = stdout.slice(0, CHARACTER_LIMIT);
          stdoutTruncated = true;
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < CHARACTER_LIMIT) {
        stderr += chunk.toString();
        if (stderr.length > CHARACTER_LIMIT) {
          stderr = stderr.slice(0, CHARACTER_LIMIT);
          stderrTruncated = true;
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
        truncated: stdoutTruncated || stderrTruncated,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const isAbort = err.name === 'AbortError';
      resolve({
        stdout,
        stderr: isAbort
          ? `Command timed out after ${timeout}ms`
          : err.message,
        exitCode: isAbort ? 124 : 1,
        durationMs: Date.now() - start,
        truncated: stdoutTruncated || stderrTruncated,
      });
    });
  });
}
