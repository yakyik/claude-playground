import { describe, it, expect, vi } from 'vitest';
import { startAudit } from '../audit.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Audit service', () => {
  it('startAudit returns requestId in UUID v4 format', () => {
    const audit = startAudit('test_tool', { key: 'value' });
    expect(audit.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('.success() returns entry with durationMs >= 0 and no error field', () => {
    const audit = startAudit('test_tool', { query: 'SELECT 1' });
    const entry = audit.success('backend-host', 200);

    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.tool).toBe('test_tool');
    expect(entry.responseCode).toBe(200);
    expect(entry.backendHost).toBe('backend-host');
    expect(entry).not.toHaveProperty('error');
  });

  it('.failure() returns entry with error field set', () => {
    const audit = startAudit('test_tool', { query: 'bad query' });
    const entry = audit.failure('backend-host', 500, 'Something went wrong');

    expect(entry.error).toBe('Something went wrong');
    expect(entry.responseCode).toBe(500);
  });

  it('redacts sensitive keys (password, secret, token, api_key, auth, credential, private_key)', () => {
    const sensitiveInputs = {
      password: 'hunter2',
      secret: 'my-secret',
      token: 'jwt-token',
      api_key: 'key-123',
      auth: 'bearer xyz',
      credential: 'cred-456',
      private_key: 'rsa-private',
      query: 'SELECT 1', // not sensitive
    };

    const audit = startAudit('test_tool', sensitiveInputs);
    const entry = audit.success('host', 200);

    expect(entry.inputs.password).toBe('[REDACTED]');
    expect(entry.inputs.secret).toBe('[REDACTED]');
    expect(entry.inputs.token).toBe('[REDACTED]');
    expect(entry.inputs.api_key).toBe('[REDACTED]');
    expect(entry.inputs.auth).toBe('[REDACTED]');
    expect(entry.inputs.credential).toBe('[REDACTED]');
    expect(entry.inputs.private_key).toBe('[REDACTED]');
    expect(entry.inputs.query).toBe('SELECT 1');
  });

  it('missing claims → userId "anonymous", source "unknown"', () => {
    const audit = startAudit('test_tool', {});
    const entry = audit.success('host', 200);

    expect(entry.userId).toBe('anonymous');
    expect(entry.source).toBe('unknown');
  });

  it('provided claims → uses sub and source from claims', () => {
    const audit = startAudit('test_tool', {}, {
      sub: 'test-user',
      source: 'claude-code',
      tools: [],
      exp: new Date().toISOString(),
    });
    const entry = audit.success('host', 200);

    expect(entry.userId).toBe('test-user');
    expect(entry.source).toBe('claude-code');
  });
});
