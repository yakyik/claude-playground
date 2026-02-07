import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBackendClient, buildRegistry, BackendError } from '../backend.js';
import type { BackendService } from '../../types.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeService(overrides: Partial<BackendService> & { name: string; url: string }): BackendService {
  return {
    timeoutMs: 5000,
    healthCheckPath: '/health',
    headers: {},
    ...overrides,
  };
}

describe('buildRegistry', () => {
  it('creates Map from array', () => {
    const services = [
      makeService({ name: 'svc-a', url: 'http://a.local' }),
      makeService({ name: 'svc-b', url: 'http://b.local' }),
    ];
    const registry = buildRegistry(services);

    expect(registry.size).toBe(2);
    expect(registry.get('svc-a')?.url).toBe('http://a.local');
    expect(registry.get('svc-b')?.url).toBe('http://b.local');
  });

  it('last wins on duplicates', () => {
    const services = [
      makeService({ name: 'svc-a', url: 'http://first.local' }),
      makeService({ name: 'svc-a', url: 'http://second.local' }),
    ];
    const registry = buildRegistry(services);

    expect(registry.size).toBe(1);
    expect(registry.get('svc-a')?.url).toBe('http://second.local');
  });
});

describe('createBackendClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('successful request → { data, status, host }', async () => {
    const registry = buildRegistry([
      makeService({ name: 'test-svc', url: 'http://test.local:8080' }),
    ]);
    const client = createBackendClient(registry);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: 'ok' }),
    });

    const result = await client.request('test-svc', '/api/data');

    expect(result.data).toEqual({ result: 'ok' });
    expect(result.status).toBe(200);
    expect(result.host).toBe('test.local:8080');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local:8080/api/data',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  it('unknown service → BackendError with statusCode 404', async () => {
    const registry = buildRegistry([]);
    const client = createBackendClient(registry);

    await expect(client.request('nonexistent', '/path')).rejects.toThrow(BackendError);
    try {
      await client.request('nonexistent', '/path');
    } catch (err) {
      expect(err).toBeInstanceOf(BackendError);
      expect((err as BackendError).statusCode).toBe(404);
    }
  });

  it('non-ok HTTP response → propagates status code', async () => {
    const registry = buildRegistry([
      makeService({ name: 'test-svc', url: 'http://test.local:8080' }),
    ]);
    const client = createBackendClient(registry);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    try {
      await client.request('test-svc', '/api/data');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BackendError);
      expect((err as BackendError).statusCode).toBe(503);
    }
  });

  it('getRegistry() returns the registry Map', () => {
    const services = [
      makeService({ name: 'svc-a', url: 'http://a.local' }),
    ];
    const registry = buildRegistry(services);
    const client = createBackendClient(registry);

    const returned = client.getRegistry();
    expect(returned).toBe(registry);
    expect(returned.get('svc-a')?.url).toBe('http://a.local');
  });
});
