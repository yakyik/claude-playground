/**
 * Session lifecycle MCP tools.
 *
 * These tools let Claude manage bastion sessions — creating them to
 * establish context and ending them when work is complete.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startAudit } from '../services/audit.js';
import { createSession, endSession, listSessions } from '../services/session.js';

/**
 * Register session management tools on the MCP server.
 */
export function registerSessionTools(server: McpServer): void {
  registerSessionStartTool(server);
  registerSessionEndTool(server);
  registerSessionListTool(server);
}

function registerSessionStartTool(server: McpServer): void {
  server.registerTool(
    'session_start',
    {
      title: 'Start Session',
      description: `Create a new bastion session.

Sessions track user activity and provide context for artifact storage.
They expire after 30 minutes of inactivity.

Args:
  - metadata (object, optional): Arbitrary metadata to attach to the session

Returns:
  The new session ID and details.`,
      inputSchema: {
        metadata: z.record(z.unknown()).optional()
          .describe('Optional metadata to attach to the session'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ metadata }, extra) => {
      const claims = extra._meta?.authClaims as { sub?: string } | undefined;
      const userId = claims?.sub ?? 'anonymous';
      const audit = startAudit('session_start', { userId });

      const session = createSession(userId, metadata ?? {});

      audit.success('bastion', 201);
      return {
        content: [{
          type: 'text',
          text: [
            `Session created.`,
            `  ID: ${session.id}`,
            `  User: ${session.userId}`,
            `  Started: ${session.startedAt.toISOString()}`,
          ].join('\n'),
        }],
      };
    }
  );
}

function registerSessionEndTool(server: McpServer): void {
  server.registerTool(
    'session_end',
    {
      title: 'End Session',
      description: `End a bastion session by ID.

Args:
  - session_id (string): The session ID to end

Returns:
  Confirmation of session termination.`,
      inputSchema: {
        session_id: z.string().uuid().describe('Session ID to end'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id }) => {
      const audit = startAudit('session_end', { session_id });

      const existed = endSession(session_id);

      if (existed) {
        audit.success('bastion', 200);
        return {
          content: [{ type: 'text', text: `Session ${session_id} ended.` }],
        };
      }

      audit.failure('bastion', 404, 'Session not found');
      return {
        isError: true,
        content: [{ type: 'text', text: `Session not found: ${session_id}` }],
      };
    }
  );
}

function registerSessionListTool(server: McpServer): void {
  server.registerTool(
    'session_list',
    {
      title: 'List Sessions',
      description: `List all active bastion sessions.

Returns:
  A table of active sessions with IDs, users, and timestamps.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const sessions = listSessions();

      if (sessions.length === 0) {
        return {
          content: [{ type: 'text', text: 'No active sessions.' }],
        };
      }

      const rows = sessions.map((s) =>
        `| ${s.id} | ${s.userId} | ${s.startedAt.toISOString()} | ${s.lastActivityAt.toISOString()} |`
      );

      const table = [
        '| Session ID | User | Started | Last Activity |',
        '|------------|------|---------|---------------|',
        ...rows,
      ].join('\n');

      return { content: [{ type: 'text', text: table }] };
    }
  );
}
