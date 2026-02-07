import { describe, it, expect } from 'vitest';
import { strategicMerge } from '../merge.js';

describe('strategicMerge', () => {
  it('scalar override — overlay replaces base', () => {
    expect(strategicMerge('a', 'b')).toBe('b');
    expect(strategicMerge(1, 2)).toBe(2);
    expect(strategicMerge(true, false)).toBe(false);
  });

  it('deep object merge', () => {
    const base = { a: 1, b: { c: 2, d: 3 } };
    const overlay = { b: { c: 99 }, e: 4 };
    const result = strategicMerge(base, overlay);

    expect(result).toEqual({ a: 1, b: { c: 99, d: 3 }, e: 4 });
  });

  it('array-of-objects merge by name key', () => {
    const base = [
      { name: 'svc-a', url: 'http://a:8080', timeoutMs: 5000 },
      { name: 'svc-b', url: 'http://b:8080' },
    ];
    const overlay = [
      { name: 'svc-a', url: 'http://a-override:9090' },
      { name: 'svc-c', url: 'http://c:8080' },
    ];
    const result = strategicMerge(base, overlay) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: 'svc-a', url: 'http://a-override:9090', timeoutMs: 5000 });
    expect(result[1]).toEqual({ name: 'svc-b', url: 'http://b:8080' });
    expect(result[2]).toEqual({ name: 'svc-c', url: 'http://c:8080' });
  });

  it('scalar array replace — overlay replaces entirely', () => {
    const base = [1, 2, 3];
    const overlay = [4, 5];
    expect(strategicMerge(base, overlay)).toEqual([4, 5]);
  });

  it('null overlay → base preserved', () => {
    expect(strategicMerge({ a: 1 }, null)).toEqual({ a: 1 });
    expect(strategicMerge('hello', undefined)).toBe('hello');
  });

  it('null base → overlay returned', () => {
    expect(strategicMerge(null, { a: 1 })).toEqual({ a: 1 });
    expect(strategicMerge(undefined, 'hello')).toBe('hello');
  });

  it('null values in overlay objects are ignored (base preserved)', () => {
    const base = { a: 1, b: 2 };
    const overlay = { a: null, c: 3 };
    expect(strategicMerge(base, overlay)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('deeply nested merge', () => {
    const base = {
      server: { port: 3001, tls: { enabled: false, cert: '/old' } },
    };
    const overlay = {
      server: { tls: { enabled: true } },
    };
    expect(strategicMerge(base, overlay)).toEqual({
      server: { port: 3001, tls: { enabled: true, cert: '/old' } },
    });
  });
});
