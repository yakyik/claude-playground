import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArtifactStore } from '../artifacts.js';

describe('LocalArtifactStore', () => {
  const tmpDir = join(tmpdir(), 'bastion-artifacts-test-' + Date.now());
  let store: LocalArtifactStore;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    store = new LocalArtifactStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upload creates an artifact and returns metadata', () => {
    const data = Buffer.from('hello world');
    const meta = store.upload('session-1', 'test.txt', data, 'text/plain');

    expect(meta.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.sessionId).toBe('session-1');
    expect(meta.name).toBe('test.txt');
    expect(meta.contentType).toBe('text/plain');
    expect(meta.size).toBe(11);
  });

  it('download retrieves an uploaded artifact', () => {
    const data = Buffer.from('binary content');
    const meta = store.upload('session-2', 'data.bin', data, 'application/octet-stream');

    const downloaded = store.download(meta.artifactId);
    expect(downloaded).toBeDefined();
    expect(downloaded!.data.toString()).toBe('binary content');
    expect(downloaded!.contentType).toBe('application/octet-stream');
    expect(downloaded!.name).toBe('data.bin');
  });

  it('download returns undefined for nonexistent artifact', () => {
    expect(store.download('nonexistent-id')).toBeUndefined();
  });

  it('list returns all artifacts for a session', () => {
    store.upload('session-3', 'a.txt', Buffer.from('a'), 'text/plain');
    store.upload('session-3', 'b.txt', Buffer.from('bb'), 'text/plain');
    store.upload('other-session', 'c.txt', Buffer.from('ccc'), 'text/plain');

    const session3Artifacts = store.list('session-3');
    expect(session3Artifacts).toHaveLength(2);

    const otherArtifacts = store.list('other-session');
    expect(otherArtifacts).toHaveLength(1);
  });

  it('list returns empty for unknown session', () => {
    expect(store.list('unknown')).toEqual([]);
  });

  it('rejects path traversal in session ID', () => {
    expect(() => store.upload('../etc', 'test.txt', Buffer.from('x'), 'text/plain'))
      .toThrow('Invalid session ID');
  });

  it('rejects path traversal in artifact name', () => {
    expect(() => store.upload('session', '../etc/passwd', Buffer.from('x'), 'text/plain'))
      .toThrow('Invalid artifact name');
  });

  it('download rejects path traversal in artifact ID', () => {
    expect(store.download('../../../etc/passwd')).toBeUndefined();
  });
});
