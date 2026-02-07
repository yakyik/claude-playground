/**
 * Session lifecycle management.
 *
 * In-memory session store with TTL-based expiry. Sessions track
 * authenticated user activity and provide context for artifact storage.
 */

import { v4 as uuidv4 } from 'uuid';

export interface Session {
  id: string;
  userId: string;
  startedAt: Date;
  lastActivityAt: Date;
  metadata: Record<string, unknown>;
}

/** Default session TTL: 30 minutes of inactivity */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const sessions = new Map<string, Session>();

// Periodic cleanup of expired sessions
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivityAt.getTime() > DEFAULT_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 60_000);
cleanupInterval.unref();

/**
 * Create a new session for a user.
 */
export function createSession(
  userId: string,
  metadata: Record<string, unknown> = {}
): Session {
  const session: Session = {
    id: uuidv4(),
    userId,
    startedAt: new Date(),
    lastActivityAt: new Date(),
    metadata,
  };
  sessions.set(session.id, session);
  return session;
}

/**
 * Get a session by ID. Returns undefined if not found or expired.
 */
export function getSession(id: string): Session | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;

  // Check TTL
  if (Date.now() - session.lastActivityAt.getTime() > DEFAULT_TTL_MS) {
    sessions.delete(id);
    return undefined;
  }

  return session;
}

/**
 * Update the last activity timestamp for a session.
 */
export function touchSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.lastActivityAt = new Date();
  return true;
}

/**
 * End a session, removing it from the store.
 */
export function endSession(id: string): boolean {
  return sessions.delete(id);
}

/**
 * List all active (non-expired) sessions.
 */
export function listSessions(): Session[] {
  const now = Date.now();
  const active: Session[] = [];
  for (const [id, session] of sessions) {
    if (now - session.lastActivityAt.getTime() > DEFAULT_TTL_MS) {
      sessions.delete(id);
    } else {
      active.push(session);
    }
  }
  return active;
}

/**
 * Clear all sessions. Primarily for testing.
 */
export function clearSessions(): void {
  sessions.clear();
}
