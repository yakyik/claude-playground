#!/usr/bin/env node

/**
 * Generate a JWT token for authenticating with the bastion MCP server.
 *
 * This script is a convenience tool for creating scoped auth tokens.
 * In production, you'd integrate token generation into your team's
 * identity provider or secrets management system.
 *
 * Usage:
 *   node scripts/generate-token.mjs \
 *     --secret "your-jwt-secret" \
 *     --sub "alice@yourcompany.com" \
 *     --source "claude-ai" \
 *     --tools "bastion_db_query,bastion_api_request" \
 *     --ttl "24h"
 *
 * The generated token can be used in:
 *   - Claude.ai project settings (as an MCP server auth header)
 *   - Claude Code CLI: claude mcp add bastion --header "Authorization: Bearer <token>"
 *   - CI/CD: stored as a GitHub secret and passed to claude-code-action
 */

import { sign } from 'jsonwebtoken';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    secret: { type: 'string', short: 's' },
    sub:    { type: 'string', default: 'claude-user' },
    source: { type: 'string', default: 'unknown' },
    tools:  { type: 'string', default: '' },
    scope:  { type: 'string', default: '' },
    ttl:    { type: 'string', default: '24h' },
    issuer: { type: 'string', default: 'bastion-mcp-server' },
  },
});

if (!values.secret) {
  console.error('Error: --secret is required');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}

// Parse the TTL string into seconds
function parseTtl(ttl) {
  const match = ttl.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    console.error(`Invalid TTL format: "${ttl}". Use format like: 30s, 15m, 24h, 7d`);
    process.exit(1);
  }
  const [, num, unit] = match;
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(num) * multipliers[unit];
}

const expiresInSeconds = parseTtl(values.ttl);

// Build the JWT payload
const payload = {
  sub: values.sub,
  source: values.source,
  tools: values.tools ? values.tools.split(',').map((t) => t.trim()) : [],
  ...(values.scope ? { scope: values.scope } : {}),
};

const token = sign(payload, values.secret, {
  expiresIn: expiresInSeconds,
  issuer: values.issuer,
});

// Output the token and its decoded payload for verification
console.log('─── Generated Token ───');
console.log(token);
console.log('');
console.log('─── Decoded Payload ───');
console.log(JSON.stringify(payload, null, 2));
console.log('');
console.log(`Expires in: ${values.ttl} (${expiresInSeconds} seconds)`);
console.log('');
console.log('─── Usage Examples ───');
console.log(`curl -H "Authorization: Bearer ${token}" https://bastion.yourcompany.com/health`);
console.log('');
console.log(`claude mcp add bastion --type streamable-http \\`);
console.log(`  --url https://bastion.yourcompany.com/mcp \\`);
console.log(`  --header "Authorization: Bearer ${token}"`);
