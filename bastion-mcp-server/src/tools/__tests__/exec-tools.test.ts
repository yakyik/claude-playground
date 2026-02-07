import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerExecTools } from '../exec-tools.js';

// Mock logger
vi.mock('../../services/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Exec tools registration', () => {
  it('registers all four exec tools on the MCP server', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const registerSpy = vi.spyOn(server, 'registerTool');

    const mockBackend = {
      request: vi.fn(),
      healthCheckAll: vi.fn(),
      getRegistry: vi.fn(() => new Map()),
    };

    registerExecTools(server, mockBackend as never);

    const toolNames = registerSpy.mock.calls.map((call) => call[0]);
    expect(toolNames).toContain('exec_command');
    expect(toolNames).toContain('exec_script');
    expect(toolNames).toContain('get_command_allowlist');
    expect(toolNames).toContain('check_job_status');
    expect(registerSpy).toHaveBeenCalledTimes(4);
  });
});
