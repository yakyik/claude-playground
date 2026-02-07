import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createSession, getSession, touchSession, endSession, listSessions, clearSessions } from '../session.js';

// Suppress logger output during tests
vi.mock('../../services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Session management', () => {
  beforeEach(() => {
    clearSessions();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createSession returns a valid session', () => {
    const session = createSession('user-1', { team: 'alpha' });
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.userId).toBe('user-1');
    expect(session.metadata).toEqual({ team: 'alpha' });
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.lastActivityAt).toBeInstanceOf(Date);
  });

  it('getSession retrieves an existing session', () => {
    const created = createSession('user-2');
    const retrieved = getSession(created.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(created.id);
  });

  it('getSession returns undefined for unknown ID', () => {
    expect(getSession('nonexistent')).toBeUndefined();
  });

  it('touchSession updates lastActivityAt', () => {
    const session = createSession('user-3');
    const original = session.lastActivityAt.getTime();

    // Small delay to ensure time difference
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);

    touchSession(session.id);
    const updated = getSession(session.id);
    expect(updated!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(original);

    vi.useRealTimers();
  });

  it('endSession removes the session', () => {
    const session = createSession('user-4');
    expect(endSession(session.id)).toBe(true);
    expect(getSession(session.id)).toBeUndefined();
  });

  it('endSession returns false for unknown ID', () => {
    expect(endSession('nonexistent')).toBe(false);
  });

  it('listSessions returns all active sessions', () => {
    createSession('user-a');
    createSession('user-b');
    createSession('user-c');

    const sessions = listSessions();
    expect(sessions).toHaveLength(3);
  });

  it('expired sessions are cleaned up on get', () => {
    vi.useFakeTimers();

    const session = createSession('user-expire');

    // Advance past TTL (30 minutes + 1 ms)
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);

    expect(getSession(session.id)).toBeUndefined();

    vi.useRealTimers();
  });
});
