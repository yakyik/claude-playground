/**
 * Structured logger for the bastion MCP server.
 *
 * Uses Winston to produce JSON-formatted logs that are easy to ship
 * to Datadog, Loki, CloudWatch, or any other log aggregation system.
 * In development, we add a human-readable console transport.
 *
 * All MCP servers using stdio transport must log to stderr (not stdout),
 * because stdout is reserved for the MCP protocol. Even though the bastion
 * primarily uses HTTP transport, we default to stderr for safety.
 */

import winston from 'winston';

const logLevel = process.env.LOG_LEVEL ?? 'info';

export const logger = winston.createLogger({
  level: logLevel,
  // JSON format is the primary output — parseable by log aggregation tools
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: 'bastion-mcp-server',
  },
  transports: [
    // Write to stderr (safe for both stdio and HTTP transports)
    new winston.transports.Console({
      stderrLevels: ['error', 'warn', 'info', 'debug'],
      // In development, add colorized human-readable output
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        : undefined,
    }),
  ],
});
