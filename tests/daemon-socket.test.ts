/**
 * Integration tests for daemon IPC socket communication.
 *
 * Bun's socket.write() may only write up to the kernel buffer size
 * (typically 8192 bytes). These tests verify that the daemon correctly
 * transmits large responses (like listTools with many tools) by
 * exercising the real daemon process and CLI client code paths.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { $ } from 'bun';

describe('Daemon large message handling', () => {
  let tempDir: string;
  let configPath: string;
  const mockServerPath = join(import.meta.dir, 'fixtures', 'mock-mcp-server.ts');

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-cli-daemon-test-'));
    configPath = join(tempDir, 'mcp_servers.json');
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          'mock-large': {
            command: 'bun',
            args: ['run', mockServerPath],
          },
        },
      }),
    );
  });

  afterAll(async () => {
    // Kill any daemon processes we spawned
    try {
      await $`pkill -f 'daemon.*mock-large'`.nothrow();
    } catch {}
    await rm(tempDir, { recursive: true, force: true });
  });

  test('lists all 50 tools via direct connection (baseline)', async () => {
    const result =
      await $`MCP_NO_DAEMON=1 MCP_TIMEOUT=15000 bun run ${join(import.meta.dir, '..', 'src', 'index.ts')} -c ${configPath}`
        .quiet()
        .nothrow()
        .then((r) => ({
          stdout: r.stdout.toString(),
          stderr: r.stderr.toString(),
          exitCode: r.exitCode,
        }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('mock_tool_0');
    expect(result.stdout).toContain('mock_tool_49');

    // Count tool lines (each starts with "  • ")
    const toolLines = result.stdout.split('\n').filter((l: string) => l.trim().startsWith('•'));
    expect(toolLines.length).toBe(50);
  }, 20000);

  test('lists all 50 tools via daemon (exercises large IPC message)', async () => {
    // This is the key test: the daemon's listTools response for 50 tools
    // exceeds the 8KB kernel socket buffer, requiring drain-based writes.
    // Without the fix, only the first ~8KB is sent and the client times out.
    const result =
      await $`MCP_TIMEOUT=15000 bun run ${join(import.meta.dir, '..', 'src', 'index.ts')} -c ${configPath}`
        .quiet()
        .nothrow()
        .then((r) => ({
          stdout: r.stdout.toString(),
          stderr: r.stderr.toString(),
          exitCode: r.exitCode,
        }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('mock_tool_0');
    expect(result.stdout).toContain('mock_tool_49');

    const toolLines = result.stdout.split('\n').filter((l: string) => l.trim().startsWith('•'));
    expect(toolLines.length).toBe(50);
  }, 20000);

  test('daemon serves tool descriptions correctly for large payloads', async () => {
    // With -d flag, descriptions are included — making the response even larger
    const result =
      await $`MCP_TIMEOUT=15000 bun run ${join(import.meta.dir, '..', 'src', 'index.ts')} -c ${configPath} -d`
        .quiet()
        .nothrow()
        .then((r) => ({
          stdout: r.stdout.toString(),
          stderr: r.stderr.toString(),
          exitCode: r.exitCode,
        }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('mock_tool_0');
    expect(result.stdout).toContain('mock_tool_49');
    // Descriptions should be present
    expect(result.stdout).toContain('intentionally long');
  }, 20000);
});
