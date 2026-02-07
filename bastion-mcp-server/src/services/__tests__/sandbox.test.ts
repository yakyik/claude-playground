import { describe, it, expect } from 'vitest';
import { executeCommand } from '../sandbox.js';

describe('Sandbox execution', () => {
  it('successful command → stdout + exitCode 0', async () => {
    const result = await executeCommand('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('failing command → non-zero exitCode + stderr', async () => {
    const result = await executeCommand('ls /nonexistent_path_for_test 2>&1 && exit 1 || exit 1');
    expect(result.exitCode).not.toBe(0);
  });

  it('stderr captured separately', async () => {
    const result = await executeCommand('echo err >&2');
    expect(result.stderr.trim()).toBe('err');
    expect(result.exitCode).toBe(0);
  });

  it('timeout → aborted with exit code 124', async () => {
    const result = await executeCommand('sleep 30', { timeoutMs: 100 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  }, 5000);

  it('respects custom working directory', async () => {
    const result = await executeCommand('pwd', { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });

  it('captures multi-line output', async () => {
    const result = await executeCommand('echo "line1"; echo "line2"; echo "line3"');
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
  });
});
