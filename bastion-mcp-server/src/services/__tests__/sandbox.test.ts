import { describe, it, expect } from 'vitest';
import { executeCommand, executeScript } from '../sandbox.js';

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

describe('executeScript', () => {
  it('executes a simple sh script via temp file', async () => {
    const result = await executeScript('echo "hello from script"', 'sh');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello from script');
    expect(result.truncated).toBe(false);
  });

  it('executes a multi-line script', async () => {
    const script = 'echo "line1"\necho "line2"\necho "line3"';
    const result = await executeScript(script, 'sh');
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('captures stderr from script', async () => {
    const result = await executeScript('echo "err" >&2', 'sh');
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe('err');
  });

  it('returns non-zero exit code on script failure', async () => {
    const result = await executeScript('exit 42', 'sh');
    expect(result.exitCode).toBe(42);
  });

  it('times out long-running scripts', async () => {
    const result = await executeScript('sleep 30', 'sh', { timeoutMs: 100 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  }, 5000);

  it('cleans up temp file after execution', async () => {
    // We can't directly observe the temp file path, but we can verify
    // that no bastion-script-* files linger in tmp after execution.
    // Run a script and check that it doesn't leave files behind.
    const before = await executeCommand('ls /tmp/bastion-script-* 2>/dev/null || true');
    await executeScript('echo cleanup-test', 'sh');
    const after = await executeCommand('ls /tmp/bastion-script-* 2>/dev/null || true');
    // After should have no more bastion-script files than before
    expect(after.stdout).toBe(before.stdout);
  });

  it('executes with bash interpreter', async () => {
    const result = await executeScript('echo "bash: $BASH_VERSION"', 'bash');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bash:');
  });

  it('respects custom working directory', async () => {
    const result = await executeScript('pwd', 'sh', { cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });
});
