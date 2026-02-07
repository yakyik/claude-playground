import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../loader.js';

// Suppress logger output during tests
vi.mock('../../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Config loader', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env vars to a clean state
    delete process.env.BASTION_JWT_SECRET;
    delete process.env.BASTION_API_KEY;
    delete process.env.BASTION_JWT_ISSUER;
    delete process.env.BASTION_CONFIG_PATH;
    delete process.env.BASTION_SERVICES;
    delete process.env.PORT;
    delete process.env.SERVER_NAME;
    delete process.env.LOG_LEVEL;
    delete process.env.HEALTH_CHECK_ENABLED;
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('neither auth var set → throws "Authentication not configured"', () => {
    expect(() => loadConfig()).toThrow('Authentication not configured');
  });

  it('BASTION_API_KEY set → api-key strategy', () => {
    process.env.BASTION_API_KEY = 'test-key';
    const config = loadConfig();

    expect(config.auth.strategy).toBe('api-key');
    expect(config.auth.apiKey).toBe('test-key');
  });

  it('BASTION_JWT_SECRET set → jwt strategy (takes precedence)', () => {
    process.env.BASTION_JWT_SECRET = 'jwt-secret';
    process.env.BASTION_API_KEY = 'api-key'; // Both set, JWT wins
    const config = loadConfig();

    expect(config.auth.strategy).toBe('jwt');
    expect(config.auth.jwtSecret).toBe('jwt-secret');
  });

  it('PORT env → overrides default 3001', () => {
    process.env.BASTION_API_KEY = 'test-key';
    process.env.PORT = '9999';
    const config = loadConfig();

    expect(config.port).toBe(9999);
  });

  it('no config path or services env → empty services array', () => {
    process.env.BASTION_API_KEY = 'test-key';
    const config = loadConfig();

    expect(config.services).toEqual([]);
  });

  it('BASTION_SERVICES env → parses inline JSON services', () => {
    process.env.BASTION_API_KEY = 'test-key';
    process.env.BASTION_SERVICES = JSON.stringify([
      { name: 'svc-a', url: 'http://a.local:8080' },
    ]);
    const config = loadConfig();

    expect(config.services).toHaveLength(1);
    expect(config.services[0].name).toBe('svc-a');
    expect(config.services[0].url).toBe('http://a.local:8080');
  });

  it('default port is 3001 when PORT not set', () => {
    process.env.BASTION_API_KEY = 'test-key';
    const config = loadConfig();

    expect(config.port).toBe(3001);
  });
});
