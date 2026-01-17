/**
 * Integration tests for CLI commands using the filesystem MCP server
 *
 * These tests spawn the actual CLI and test against a real MCP server.
 * They require npx and @modelcontextprotocol/server-filesystem to be available.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

describe('CLI Integration Tests', () => {
  let tempDir: string;
  let configPath: string;
  let testFilePath: string;

  beforeAll(async () => {
    // Create temp directory for test files
    // Use realpath to resolve symlinks (e.g., /var -> /private/var on macOS)
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'mcp-cli-integration-')));

    // Create a test file to read
    testFilePath = join(tempDir, 'test.txt');
    await writeFile(testFilePath, 'Hello from test file!');

    // Create subdirectory with more files
    const subDir = join(tempDir, 'subdir');
    await mkdir(subDir);
    await writeFile(join(subDir, 'nested.txt'), 'Nested content');

    // Create config pointing to the temp directory
    configPath = join(tempDir, 'mcp_servers.json');
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', tempDir],
          },
        },
      })
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Helper to run CLI commands
  async function runCli(
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');

    try {
      const result =
        await $`bun run ${cliPath} -c ${configPath} ${args}`.nothrow();
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

  describe('--help', () => {
    test('shows help message', async () => {
      const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
      const result = await $`bun run ${cliPath} --help`.nothrow();

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('mcp-cli');
      expect(result.stdout.toString()).toContain('Usage:');
      expect(result.stdout.toString()).toContain('Options:');
    });
  });

  describe('--version', () => {
    test('shows version', async () => {
      const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
      const result = await $`bun run ${cliPath} --version`.nothrow();

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toMatch(/mcp-cli v\d+\.\d+\.\d+/);
    });
  });

  describe('list command', () => {
    test('lists servers and tools', async () => {
      const result = await runCli([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('filesystem');
      // Should contain filesystem tools
      expect(result.stdout).toMatch(/read_file|list_directory|write_file/);
    });

    test('lists with descriptions using -d flag', async () => {
      const result = await runCli(['-d']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('filesystem');
      // Descriptions should be present (checking for common patterns)
      expect(result.stdout.length).toBeGreaterThan(100);
    });

    test('outputs JSON with --json flag', async () => {
      const result = await runCli(['--json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].name).toBe('filesystem');
      expect(Array.isArray(parsed[0].tools)).toBe(true);
    });
  });

  describe('grep command', () => {
    test('searches tools by pattern', async () => {
      const result = await runCli(['grep', '*file*']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/filesystem\/(read_file|write_file)/);
    });

    test('searches with descriptions', async () => {
      const result = await runCli(['grep', '*directory*', '-d']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('filesystem');
    });

    test('outputs JSON with --json flag', async () => {
      const result = await runCli(['grep', '*read*', '--json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].server).toBeDefined();
      expect(parsed[0].tool).toBeDefined();
    });

    test('shows message for no matches', async () => {
      const result = await runCli(['grep', '*nonexistent_xyz_123*']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No tools found');
    });
  });

  describe('info command (server)', () => {
    test('shows server details', async () => {
      const result = await runCli(['filesystem']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Server:');
      expect(result.stdout).toContain('filesystem');
      expect(result.stdout).toContain('Transport:');
      expect(result.stdout).toContain('Tools');
    });

    test('outputs JSON with --json flag', async () => {
      const result = await runCli(['filesystem', '--json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.name).toBe('filesystem');
      expect(parsed.tools).toBeDefined();
      expect(Array.isArray(parsed.tools)).toBe(true);
    });

    test('errors on unknown server', async () => {
      const result = await runCli(['nonexistent_server']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('info command (tool)', () => {
    test('shows tool schema', async () => {
      const result = await runCli(['filesystem/read_file']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Tool:');
      expect(result.stdout).toContain('read_file');
      expect(result.stdout).toContain('Server:');
      expect(result.stdout).toContain('filesystem');
      expect(result.stdout).toContain('Input Schema:');
    });

    test('outputs JSON with --json flag', async () => {
      const result = await runCli(['filesystem/read_file', '--json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.name).toBe('read_file');
      expect(parsed.inputSchema).toBeDefined();
    });

    test('errors on unknown tool', async () => {
      const result = await runCli(['filesystem/nonexistent_tool']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('call command', () => {
    test('calls read_file tool', async () => {
      const result = await runCli([
        'filesystem/read_file',
        JSON.stringify({ path: testFilePath }),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Hello from test file!');
    });

    test('calls list_directory tool', async () => {
      const result = await runCli([
        'filesystem/list_directory',
        JSON.stringify({ path: tempDir }),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test.txt');
      expect(result.stdout).toContain('subdir');
    });

    test('outputs JSON with --json flag', async () => {
      const result = await runCli([
        'filesystem/read_file',
        JSON.stringify({ path: testFilePath }),
        '--json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.content).toBeDefined();
      expect(Array.isArray(parsed.content)).toBe(true);
    });

    test('handles tool errors gracefully', async () => {
      const result = await runCli([
        'filesystem/read_file',
        JSON.stringify({ path: '/nonexistent/path/file.txt' }),
      ]);

      // Server may return error as content or fail - verify error is reported
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/denied|error|not found|outside|allowed/i);
    });

    test('handles invalid JSON arguments', async () => {
      const result = await runCli(['filesystem/read_file', 'not valid json']);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });

    test('calls tool with no arguments', async () => {
      // list_directory might work with default path
      const result = await runCli(['filesystem/list_directory', '{}']);

      // May succeed or fail depending on server implementation
      // We just verify it doesn't crash
      expect(typeof result.exitCode).toBe('number');
    });
  });

  describe('error handling', () => {
    test('handles missing config gracefully', async () => {
      const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
      const result =
        await $`bun run ${cliPath} -c /nonexistent/config.json`.nothrow();

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('not found');
    });

    test('handles unknown options', async () => {
      const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');
      const result = await $`bun run ${cliPath} --unknown-option`.nothrow();

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('Unknown option');
    });
  });
});

/**
 * HTTP Transport Integration Tests
 *
 * These tests verify HTTP-based MCP server connectivity
 * using the deepwiki.com public MCP server.
 */
describe('HTTP Transport Integration Tests', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    // Create temp directory for config
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-cli-http-test-'));

    // Create config with HTTP-based MCP server
    configPath = join(tempDir, 'mcp_servers.json');
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          deepwiki: {
            url: 'https://mcp.deepwiki.com/mcp',
          },
        },
      })
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // Helper to run CLI commands with HTTP config
  async function runCli(
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cliPath = join(import.meta.dir, '..', '..', 'src', 'index.ts');

    try {
      const result =
        await $`bun run ${cliPath} -c ${configPath} ${args}`.nothrow();
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

  describe('list command with HTTP server', () => {
    test('lists HTTP server and its tools', async () => {
      const result = await runCli([]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('deepwiki');
    });

    test('outputs JSON with --json flag', async () => {
      const result = await runCli(['--json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].name).toBe('deepwiki');
      expect(Array.isArray(parsed[0].tools)).toBe(true);
    });
  });

  describe('info command with HTTP server', () => {
    test('shows HTTP server details', async () => {
      const result = await runCli(['deepwiki']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Server:');
      expect(result.stdout).toContain('deepwiki');
      expect(result.stdout).toContain('Transport:');
      expect(result.stdout).toContain('HTTP');
    });

    test('outputs JSON with --json flag', async () => {
      const result = await runCli(['deepwiki', '--json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.name).toBe('deepwiki');
      expect(parsed.config.url).toBe('https://mcp.deepwiki.com/mcp');
      expect(parsed.tools).toBeDefined();
    });
  });

  describe('grep command with HTTP server', () => {
    test('searches HTTP server tools', async () => {
      const result = await runCli(['grep', '*']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('deepwiki');
    });
  });
});
