/**
 * Integration tests for CLI error handling
 * 
 * Tests the 22 LLM error cases from the implementation plan
 * by invoking the actual CLI with wrong/confusing arguments.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';

describe('CLI Error Handling Tests', () => {
  const cliPath = join(import.meta.dir, '..', 'src', 'index.ts');

  async function runCli(
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      // Disable daemon for tests for deterministic behavior
      const result = await $`MCP_NO_DAEMON=1 bun run ${cliPath} ${args}`.nothrow();
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: result.exitCode,
      };
    } catch (error: any) {
      return {
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || '',
        exitCode: error.exitCode || 1,
      };
    }
  }

  describe('Ambiguous command errors', () => {
    // Case 1: mcp-cli server tool (without subcommand)
    test('errors on "mcp-cli server tool" pattern', async () => {
      const result = await runCli(['someserver', 'sometool']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('AMBIGUOUS_COMMAND');
      expect(result.stderr).toContain('call');
      expect(result.stderr).toContain('info');
    });

    // Case 2: mcp-cli server tool '{}' (without subcommand)
    test('errors on "mcp-cli server tool json" pattern', async () => {
      const result = await runCli(['someserver', 'sometool', '{}']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('AMBIGUOUS_COMMAND');
    });
  });

  describe('Unknown subcommand errors', () => {
    // Case 3: mcp-cli run server tool
    test('suggests "call" for "run"', async () => {
      const result = await runCli(['run', 'server', 'tool']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('UNKNOWN_SUBCOMMAND');
      expect(result.stderr).toContain('call');
    });

    // Case 4: mcp-cli execute server/tool
    test('suggests "call" for "execute"', async () => {
      const result = await runCli(['execute', 'server/tool']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('call');
    });

    // Case 5: mcp-cli get server
    test('suggests "info" for "get"', async () => {
      const result = await runCli(['get', 'server']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('info');
    });

    // Case 6: mcp-cli list
    test('suggests "info" for "list"', async () => {
      const result = await runCli(['list']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('info');
    });

    // Case 7: mcp-cli search "*file*"
    test('suggests "grep" for "search"', async () => {
      const result = await runCli(['search', '*file*']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('grep');
    });

    // Case 8: mcp-cli find "*file*"
    test('suggests "grep" for "find"', async () => {
      const result = await runCli(['find', '*file*']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('grep');
    });
  });

  describe('Missing argument errors', () => {
    // Case 9: mcp-cli call (missing server and tool)
    test('errors on "call" with no args', async () => {
      const result = await runCli(['call']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MISSING_ARGUMENT');
      expect(result.stderr).toContain('server');
    });

    // Case 10: mcp-cli call server (missing tool)
    test('errors on "call server" without tool', async () => {
      const result = await runCli(['call', 'server']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MISSING_ARGUMENT');
      expect(result.stderr).toContain('tool');
    });

    // Case 11: mcp-cli grep (missing pattern)
    test('errors on "grep" without pattern', async () => {
      const result = await runCli(['grep']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MISSING_ARGUMENT');
      expect(result.stderr).toContain('pattern');
    });
  });

  describe('Unknown option errors', () => {
    // Case 12: mcp-cli info --server fs
    test('errors on unknown "--server" option', async () => {
      const result = await runCli(['info', '--server', 'fs']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('UNKNOWN_OPTION');
    });

    // Case 13: mcp-cli call server tool --args '{}'
    test('errors on unknown "--args" option', async () => {
      const result = await runCli(['call', 'server', 'tool', '--args', '{}']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('UNKNOWN_OPTION');
    });

    // Case 19: mcp-cli --call server tool
    test('errors on "--call" as option', async () => {
      const result = await runCli(['--call', 'server', 'tool']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('UNKNOWN_OPTION');
    });

    // Case 20: mcp-cli -c (missing config path)
    test('errors on "-c" without path', async () => {
      const result = await runCli(['-c']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MISSING_ARGUMENT');
    });
  });

  describe('Valid commands still work', () => {
    test('info command works', async () => {
      const result = await runCli(['info']);
      // May fail on server connection, but should not error on parsing
      expect(result.stderr).not.toContain('AMBIGUOUS_COMMAND');
      expect(result.stderr).not.toContain('UNKNOWN_SUBCOMMAND');
    });

    test('grep command works', async () => {
      const result = await runCli(['grep', '*']);
      expect(result.stderr).not.toContain('UNKNOWN_SUBCOMMAND');
    });

    test('call with slash format works', async () => {
      const result = await runCli(['call', 'server/tool', '{}']);
      // Will fail on server, but should not error on parsing
      expect(result.stderr).not.toContain('AMBIGUOUS_COMMAND');
    });

    test('slash format without subcommand errors (backward compat removed)', async () => {
      const result = await runCli(['server/tool', '{}']);
      // Backward compat removed - now errors as AMBIGUOUS
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('AMBIGUOUS_COMMAND');
    });
  });

  describe('Help and version', () => {
    test('--help shows new command structure', async () => {
      const result = await runCli(['--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('info');
      expect(result.stdout).toContain('grep');
      expect(result.stdout).toContain('call');
    });

    test('-h works', async () => {
      const result = await runCli(['-h']);
      expect(result.exitCode).toBe(0);
    });

    test('--version works', async () => {
      const result = await runCli(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/mcp-cli v\d+\.\d+\.\d+/);
    });
  });

  describe('Invalid JSON arguments (LLM mistakes)', () => {
    // Case 14: Unquoted keys
    test('errors on unquoted JSON keys: {path:x}', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', '{path:"test"}']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });

    // Case 15: Key=value format
    test('errors on key=value format', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', 'path=./README.md']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });

    // LLMs often forget quotes around strings
    test('errors on unquoted string values', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', '{"path": test}']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });

    // Trailing commas
    test('errors on trailing comma in JSON', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', '{"path": "test",}']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });

    // Single quotes instead of double
    test('errors on single-quoted JSON', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', "{'path': 'test'}"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });

    // Just the value without braces - JSON.parse accepts bare strings
    test('bare value parses as string', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', '"./README.md"']);
      // JSON.parse("\"./README.md\"") = "./README.md" which is a string, not an object
      // Tool will fail validation but CLI parses it
      expect(result.stderr).not.toContain('AMBIGUOUS_COMMAND');
    });

    // Completely wrong format
    test('errors on plain text argument', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', 'just plain text']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });
  });

  describe('Malformed target paths (LLM mistakes)', () => {
    // Case 21: Too many slashes
    test('handles triple slash path', async () => {
      const result = await runCli(['call', 'server/tool/extra']);
      expect(result.exitCode).toBe(1);
      // Should error on server not found (server is "server")
    });

    // Empty tool name
    test('errors on trailing slash with no tool', async () => {
      const result = await runCli(['call', 'filesystem/']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MISSING_ARGUMENT');
    });

    // Double slash - first part is empty, second is tool name
    test('handles double slash as tool with empty server', async () => {
      const result = await runCli(['call', 'filesystem//read_file']);
      // server="filesystem", tool="" initially, then /read_file as extra
      expect(result.stderr).not.toContain('AMBIGUOUS_COMMAND');
    });

    // Spaces in server name - treated as ambiguous because it looks like "call server tool"
    test('errors on spaced server name', async () => {
      const result = await runCli(['call', 'file', 'system', 'read_file']);
      expect(result.exitCode).toBe(1);
      // Will error on server not found or too many args
    });
  });

  describe('Half-complete arguments (LLM mistakes)', () => {
    // Forgot the JSON
    test('call without JSON still works (stdin mode)', async () => {
      const result = await runCli(['call', 'filesystem/read_file']);
      // Should try to read stdin or error on missing args
      expect(result.stderr).not.toContain('AMBIGUOUS_COMMAND');
    });

    // Just "call" alone
    test('call alone errors properly', async () => {
      const result = await runCli(['call']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('MISSING_ARGUMENT');
    });

    // Info with partial target
    test('info with just slash searches for empty server', async () => {
      const result = await runCli(['info', '/']);
      // "/" parses as server="", tool=""
      expect(result.stderr).not.toContain('AMBIGUOUS_COMMAND');
    });
  });

  describe('Common LLM command variations', () => {
    // LLMs might add "mcp" prefix
    test('errors on mcp as first arg', async () => {
      const result = await runCli(['mcp', 'filesystem', 'read_file']);
      expect(result.exitCode).toBe(1);
      // Should error - mcp is not a known subcommand
    });

    // LLMs might try kubectl-style
    test('errors on kubectl-style "describe"', async () => {
      const result = await runCli(['describe', 'filesystem']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('info');
    });

    // LLMs might try docker-style "exec"
    test('errors on docker-style "exec"', async () => {
      const result = await runCli(['exec', 'filesystem', 'read_file']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('call');
    });

    // LLMs might try "invoke"
    test('errors on "invoke"', async () => {
      const result = await runCli(['invoke', 'filesystem', 'read_file']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('call');
    });

    // LLMs might try "show"
    test('errors on "show"', async () => {
      const result = await runCli(['show', 'filesystem']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('info');
    });

    // LLMs might use "ls"
    test('errors on "ls"', async () => {
      const result = await runCli(['ls']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('info');
    });

    // LLMs might use "query"
    test('errors on "query"', async () => {
      const result = await runCli(['query', '*file*']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('grep');
    });
  });

  describe('Edge case argument combinations', () => {
    // Multiple JSON-like arguments
    test('handles multiple JSON arguments', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', '{}', '{}']);
      // Should use the combined args or first one
      expect(result.stderr).not.toContain('AMBIGUOUS_COMMAND');
    });

    // Empty string argument
    test('handles empty JSON object', async () => {
      const result = await runCli(['call', 'filesystem', 'read_file', '{}']);
      // Will fail on tool execution but not on parsing
      expect(result.stderr).not.toContain('AMBIGUOUS_COMMAND');
    });

    // Very long server name
    test('handles very long server name', async () => {
      const longName = 'a'.repeat(100);
      const result = await runCli(['info', longName]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });
});

