/**
 * Unit tests for output formatting
 */

import { describe, test, expect } from 'bun:test';
import {
  formatServerList,
  formatSearchResults,
  formatServerDetails,
  formatToolSchema,
  formatToolResult,
  formatJson,
  formatError,
} from '../src/output';

// Disable colors for testing
process.env.NO_COLOR = '1';

describe('output', () => {
  describe('formatServerList', () => {
    test('formats servers with tools', () => {
      const servers = [
        {
          name: 'github',
          tools: [
            { name: 'search', description: 'Search repos', inputSchema: {} },
            { name: 'clone', description: 'Clone repo', inputSchema: {} },
          ],
        },
        {
          name: 'filesystem',
          tools: [
            { name: 'read_file', description: 'Read file', inputSchema: {} },
          ],
        },
      ];

      const output = formatServerList(servers, false);
      expect(output).toContain('github');
      expect(output).toContain('search');
      expect(output).toContain('clone');
      expect(output).toContain('filesystem');
      expect(output).toContain('read_file');
    });

    test('includes descriptions when requested', () => {
      const servers = [
        {
          name: 'test',
          tools: [
            { name: 'tool1', description: 'A test tool', inputSchema: {} },
          ],
        },
      ];

      const withDesc = formatServerList(servers, true);
      expect(withDesc).toContain('A test tool');

      const withoutDesc = formatServerList(servers, false);
      expect(withoutDesc).not.toContain('A test tool');
    });
  });

  describe('formatSearchResults', () => {
    test('formats search results', () => {
      const results = [
        {
          server: 'github',
          tool: { name: 'search', description: 'Search', inputSchema: {} },
        },
        {
          server: 'fs',
          tool: { name: 'find', description: 'Find files', inputSchema: {} },
        },
      ];

      const output = formatSearchResults(results, false);
      expect(output).toContain('github');
      expect(output).toContain('search');
      expect(output).toContain('fs');
      expect(output).toContain('find');
    });

    test('always includes descriptions when available', () => {
      const results = [
        {
          server: 'test',
          tool: {
            name: 'tool',
            description: 'Tool description',
            inputSchema: {},
          },
        },
      ];

      // Descriptions are always shown in grep output (regardless of -d flag)
      const withDesc = formatSearchResults(results, true);
      expect(withDesc).toContain('Tool description');

      const withoutDesc = formatSearchResults(results, false);
      expect(withoutDesc).toContain('Tool description');
    });
  });


  describe('formatServerDetails', () => {
    test('hides stdio args to avoid leaking secrets', () => {
      const output = formatServerDetails(
        'secrets',
        {
          command: '/usr/local/bin/node',
          args: ['server.js', '--api-key', 'super-secret-value'],
        },
        [],
      );

      expect(output).toContain('Command: node (3 args hidden)');
      expect(output).not.toContain('super-secret-value');
      expect(output).not.toContain('--api-key');
      expect(output).not.toContain('/usr/local/bin/node');
    });

    test('redacts credentials and secret query params in http urls', () => {
      const output = formatServerDetails(
        'remote',
        {
          url: 'https://alice:super-secret@example.com/mcp?api_key=top-secret&token=abc123&safe=yes',
        },
        [],
      );

      expect(output).toContain('URL: https://***:***@example.com/mcp?api_key=***&token=***&safe=yes');
      expect(output).not.toContain('alice');
      expect(output).not.toContain('super-secret');
      expect(output).not.toContain('top-secret');
      expect(output).not.toContain('abc123');
    });

    test('shows stdio command basename when there are no args', () => {
      const output = formatServerDetails(
        'simple',
        { command: '/opt/mcp/server' },
        [],
      );

      expect(output).toContain('Command: server');
    });
  });

  describe('formatToolSchema', () => {
    test('formats tool with schema', () => {
      const tool = {
        name: 'search_repos',
        description: 'Search GitHub repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      };

      const output = formatToolSchema('github', tool);
      expect(output).toContain('search_repos');
      expect(output).toContain('github');
      expect(output).toContain('Search GitHub');
      expect(output).toContain('query');
    });
  });

  describe('formatToolResult', () => {
    test('extracts text content from MCP result', () => {
      const result = {
        content: [{ type: 'text', text: 'Hello, world!' }],
      };

      const output = formatToolResult(result);
      expect(output).toBe('Hello, world!');
    });

    test('handles multiple text parts', () => {
      const result = {
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      };

      const output = formatToolResult(result);
      expect(output).toContain('Part 1');
      expect(output).toContain('Part 2');
    });

    test('falls back to JSON for non-text content', () => {
      const result = { data: [1, 2, 3] };
      const output = formatToolResult(result);
      expect(output).toContain('"data"');
      expect(output).toContain('1');
      expect(output).toContain('2');
      expect(output).toContain('3');
    });
  });

  describe('formatJson', () => {
    test('outputs valid JSON', () => {
      const data = { name: 'test', values: [1, 2, 3] };
      const output = formatJson(data);
      expect(JSON.parse(output)).toEqual(data);
    });
  });

  describe('formatError', () => {
    test('formats error message', () => {
      const output = formatError('Something went wrong');
      expect(output).toContain('Something went wrong');
    });
  });
});
