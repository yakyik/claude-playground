/**
 * Artifact storage for session-scoped file uploads/downloads.
 *
 * Provides a pluggable interface with a local filesystem implementation
 * and a placeholder for S3. Artifacts are scoped to sessions.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

export interface ArtifactMetadata {
  artifactId: string;
  sessionId: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface ArtifactStore {
  upload(sessionId: string, name: string, data: Buffer, contentType: string): ArtifactMetadata;
  download(artifactId: string): { data: Buffer; contentType: string; name: string } | undefined;
  list(sessionId: string): ArtifactMetadata[];
}

// ─── Local Filesystem Implementation ─────────────────────────────────────────

/**
 * Stores artifacts under `{baseDir}/{sessionId}/{artifactId}`.
 * Metadata is stored alongside as `{artifactId}.meta.json`.
 */
export class LocalArtifactStore implements ArtifactStore {
  private readonly baseDir: string;

  constructor(baseDir: string = './artifacts') {
    this.baseDir = resolve(baseDir);
    mkdirSync(this.baseDir, { recursive: true });
  }

  upload(sessionId: string, name: string, data: Buffer, contentType: string): ArtifactMetadata {
    // Validate sessionId and name to prevent path traversal
    if (sessionId.includes('..') || sessionId.includes('/')) {
      throw new Error('Invalid session ID');
    }
    if (name.includes('..') || name.includes('/')) {
      throw new Error('Invalid artifact name');
    }

    const artifactId = uuidv4();
    const sessionDir = join(this.baseDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    const filePath = join(sessionDir, artifactId);
    const metaPath = join(sessionDir, `${artifactId}.meta.json`);

    const metadata: ArtifactMetadata = {
      artifactId,
      sessionId,
      name,
      contentType,
      size: data.length,
      createdAt: new Date().toISOString(),
    };

    writeFileSync(filePath, data);
    writeFileSync(metaPath, JSON.stringify(metadata));

    return metadata;
  }

  download(artifactId: string): { data: Buffer; contentType: string; name: string } | undefined {
    if (artifactId.includes('..') || artifactId.includes('/')) {
      return undefined;
    }

    // Search all session directories for the artifact
    if (!existsSync(this.baseDir)) return undefined;

    for (const sessionDir of readdirSync(this.baseDir)) {
      const metaPath = join(this.baseDir, sessionDir, `${artifactId}.meta.json`);
      const filePath = join(this.baseDir, sessionDir, artifactId);

      if (existsSync(metaPath) && existsSync(filePath)) {
        const metadata = JSON.parse(readFileSync(metaPath, 'utf-8')) as ArtifactMetadata;
        const data = readFileSync(filePath);
        return { data, contentType: metadata.contentType, name: metadata.name };
      }
    }

    return undefined;
  }

  list(sessionId: string): ArtifactMetadata[] {
    if (sessionId.includes('..') || sessionId.includes('/')) {
      return [];
    }

    const sessionDir = join(this.baseDir, sessionId);
    if (!existsSync(sessionDir)) return [];

    const entries = readdirSync(sessionDir);
    const metaFiles = entries.filter((f) => f.endsWith('.meta.json'));

    return metaFiles.map((f) => {
      const raw = readFileSync(join(sessionDir, f), 'utf-8');
      return JSON.parse(raw) as ArtifactMetadata;
    });
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export interface ArtifactStoreConfig {
  type: 'local' | 's3';
  basePath?: string;
}

export function createArtifactStore(config: ArtifactStoreConfig = { type: 'local' }): ArtifactStore {
  if (config.type === 's3') {
    // TODO: Implement S3ArtifactStore when aws-sdk is added
    throw new Error('S3 artifact store not yet implemented');
  }
  return new LocalArtifactStore(config.basePath);
}
