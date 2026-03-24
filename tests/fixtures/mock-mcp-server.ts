#!/usr/bin/env bun
/**
 * Mock MCP server over stdio that returns a large number of tools.
 * Used by daemon socket integration tests to ensure large IPC
 * messages are transmitted correctly.
 *
 * Uses the official MCP SDK server/stdio transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const TOOL_COUNT = 50;

const server = new McpServer({
  name: 'mock-large-server',
  version: '1.0.0',
});

// Register many tools to create a large listTools response (>8KB)
for (let i = 0; i < TOOL_COUNT; i++) {
  server.tool(
    `mock_tool_${i}`,
    `Mock tool number ${i}. This is a description that is intentionally long to inflate the payload size beyond the kernel socket buffer limit of 8192 bytes.`,
    {
      arg1: z.string().describe(`String argument for mock_tool_${i}`),
      arg2: z.number().describe(`Number argument for mock_tool_${i}`),
      arg3: z.boolean().describe(`Boolean argument for mock_tool_${i}`),
    },
    async () => ({ content: [{ type: 'text' as const, text: `result from mock_tool_${i}` }] }),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
