/**
 * Job manager for long-running command execution.
 *
 * Commands expected to run longer than the default timeout can be
 * submitted as jobs. The caller gets a job ID back immediately and
 * can poll for status/results.
 */

import { v4 as uuidv4 } from 'uuid';
import { executeCommand, type ExecutionResult } from './sandbox.js';
import { MAX_COMMAND_TIMEOUT_MS, JOB_CLEANUP_INTERVAL_MS } from '../constants.js';

export interface Job {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  result?: ExecutionResult;
  startedAt: Date;
  completedAt?: Date;
}

const jobs = new Map<string, Job>();

// Periodic cleanup of old completed jobs (runs every JOB_CLEANUP_INTERVAL_MS)
const cleanupInterval = setInterval(() => {
  const cutoff = Date.now() - MAX_COMMAND_TIMEOUT_MS * 2;
  for (const [id, job] of jobs) {
    if (job.completedAt && job.completedAt.getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}, JOB_CLEANUP_INTERVAL_MS);
cleanupInterval.unref();

/**
 * Start a long-running command as a background job.
 */
export function startJob(
  command: string,
  timeoutMs: number = MAX_COMMAND_TIMEOUT_MS
): string {
  const id = uuidv4();
  const job: Job = {
    id,
    command,
    status: 'running',
    startedAt: new Date(),
  };

  jobs.set(id, job);

  // Run in background — don't await
  executeCommand(command, { timeoutMs })
    .then((result) => {
      job.result = result;
      job.status = result.exitCode === 0 ? 'completed' : 'failed';
      job.completedAt = new Date();
    })
    .catch(() => {
      job.status = 'failed';
      job.completedAt = new Date();
    });

  return id;
}

/**
 * Get the current state of a job by ID.
 */
export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}
