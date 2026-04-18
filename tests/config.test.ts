/**
 * Unit tests for config module
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getServerConfig,
  isHttpServer,
  isStdioServer,
  listServerNames,
  loadConfig,
} from '../src/config';

describe('config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-cli-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('loadConfig', () => {
    test('loads valid config from explicit path', async () => {
      const configPath = join(tempDir, 'mcp_servers.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: { command: 'echo', args: ['hello'] },
          },
        }),
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test).toBeDefined();
      expect(
        isStdioServer(config.mcpServers.test) && config.mcpServers.test.command,
      ).toBe('echo');
    });

    test('throws on missing config file', async () => {
      const configPath = join(tempDir, 'nonexistent.json');
      await expect(loadConfig(configPath)).rejects.toThrow('not found');
    });

    test('throws on invalid JSON', async () => {
      const configPath = join(tempDir, 'invalid.json');
      await writeFile(configPath, 'not valid json');

      await expect(loadConfig(configPath)).rejects.toThrow('Invalid JSON');
    });

    test('throws on missing mcpServers key', async () => {
      const configPath = join(tempDir, 'bad_structure.json');
      await writeFile(configPath, JSON.stringify({ servers: {} }));

      await expect(loadConfig(configPath)).rejects.toThrow('mcpServers');
    });

    test('substitutes environment variables', async () => {
      process.env.TEST_MCP_TOKEN = 'secret123';

      const configPath = join(tempDir, 'env_config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              headers: { Authorization: 'Bearer ${TEST_MCP_TOKEN}' },
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test;
      expect(isHttpServer(server) && server.headers?.Authorization).toBe(
        'Bearer secret123',
      );

      process.env.TEST_MCP_TOKEN = undefined;
    });

    test('handles missing env vars gracefully with MCP_STRICT_ENV=false', async () => {
      // Set non-strict mode to allow missing env vars with warning
      process.env.MCP_STRICT_ENV = 'false';

      const configPath = join(tempDir, 'missing_env.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              command: 'echo',
              env: { TOKEN: '${NONEXISTENT_VAR}' },
            },
          },
        }),
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test;
      expect(isStdioServer(server) && server.env?.TOKEN).toBe('');

      process.env.MCP_STRICT_ENV = undefined;
    });

    test('throws error on missing env vars in strict mode (default)', async () => {
      // Ensure strict mode is enabled (default)
      process.env.MCP_STRICT_ENV = undefined;

      const configPath = join(tempDir, 'missing_env_strict.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              command: 'echo',
              env: { TOKEN: '${ANOTHER_NONEXISTENT_VAR}' },
            },
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow('MISSING_ENV_VAR');
    });

    test('only substitutes env vars for the requested server scope', async () => {
      process.env.MCP_STRICT_ENV = 'false';
      const stderrSpy = spyOn(console, 'error').mockImplementation(() => {});

      const configPath = join(tempDir, 'scoped_missing_env.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            chrome: { command: 'echo', args: ['ok'] },
            email: {
              command: 'echo',
              env: { TOKEN: '${EMAIL_TOKEN}' },
            },
          },
        }),
      );

      const config = await loadConfig(configPath, ['chrome']);
      expect(
        isStdioServer(config.mcpServers.chrome) &&
          config.mcpServers.chrome.command,
      ).toBe('echo');
      expect(stderrSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('${EMAIL_TOKEN}'),
      );

      stderrSpy.mockRestore();
      process.env.MCP_STRICT_ENV = undefined;
    });

    test('throws error on empty server config', async () => {
      const configPath = join(tempDir, 'empty_server.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            badserver: {},
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow(
        'missing required field',
      );
    });

    test('throws error on server with both command and url', async () => {
      const configPath = join(tempDir, 'both_types.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            mixed: {
              command: 'echo',
              url: 'https://example.com',
            },
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow(
        'both "command" and "url"',
      );
    });

    test('throws error on null server config', async () => {
      const configPath = join(tempDir, 'null_server.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            nullserver: null,
          },
        }),
      );

      await expect(loadConfig(configPath)).rejects.toThrow(
        'Invalid server configuration',
      );
    });
  });

  describe('getServerConfig', () => {
    test('returns server config by name', async () => {
      const configPath = join(tempDir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            server1: { command: 'cmd1' },
            server2: { command: 'cmd2' },
          },
        }),
      );

      const config = await loadConfig(configPath);
      const server = getServerConfig(config, 'server1');
      expect(isStdioServer(server) && server.command).toBe('cmd1');
    });

    test('throws on unknown server', async () => {
      const configPath = join(tempDir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: { known: { command: 'cmd' } },
        }),
      );

      const config = await loadConfig(configPath);
      expect(() => getServerConfig(config, 'unknown')).toThrow('not found');
    });
  });

  describe('listServerNames', () => {
    test('returns all server names', async () => {
      const configPath = join(tempDir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            alpha: { command: 'a' },
            beta: { command: 'b' },
            gamma: { url: 'https://example.com' },
          },
        }),
      );

      const config = await loadConfig(configPath);
      const names = listServerNames(config);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toContain('gamma');
      expect(names.length).toBe(3);
    });
  });

  describe('type guards', () => {
    test('isHttpServer identifies HTTP config', () => {
      expect(isHttpServer({ url: 'https://example.com' })).toBe(true);
      expect(isHttpServer({ command: 'echo' })).toBe(false);
    });

    test('isStdioServer identifies stdio config', () => {
      expect(isStdioServer({ command: 'echo' })).toBe(true);
      expect(isStdioServer({ url: 'https://example.com' })).toBe(false);
    });
  });
});
