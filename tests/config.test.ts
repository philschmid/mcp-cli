/**
 * Unit tests for config module
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  getServerConfig,
  listServerNames,
  isHttpServer,
  isStdioServer,
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
        })
      );

      const config = await loadConfig(configPath);
      expect(config.mcpServers.test).toBeDefined();
      expect((config.mcpServers.test as any).command).toBe('echo');
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
        })
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test as any;
      expect(server.headers.Authorization).toBe('Bearer secret123');

      delete process.env.TEST_MCP_TOKEN;
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
        })
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test as any;
      expect(server.env.TOKEN).toBe('');

      delete process.env.MCP_STRICT_ENV;
    });

    test('throws error on missing env vars in strict mode (default)', async () => {
      // Ensure strict mode is enabled (default)
      delete process.env.MCP_STRICT_ENV;

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
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('MISSING_ENV_VAR');
    });

    test('throws error on empty server config', async () => {
      const configPath = join(tempDir, 'empty_server.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            badserver: {},
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('missing required field');
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
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('both "command" and "url"');
    });

    test('throws error on null server config', async () => {
      const configPath = join(tempDir, 'null_server.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            nullserver: null,
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('Invalid server configuration');
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
        })
      );

      const config = await loadConfig(configPath);
      const server = getServerConfig(config, 'server1');
      expect((server as any).command).toBe('cmd1');
    });

    test('throws on unknown server', async () => {
      const configPath = join(tempDir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: { known: { command: 'cmd' } },
        })
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
        })
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

  describe('OAuth config validation', () => {
    test('accepts valid OAuth config with authorization_code', async () => {
      const configPath = join(tempDir, 'oauth_auth_code.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              oauth: {
                grantType: 'authorization_code',
                scope: 'read write',
              },
            },
          },
        })
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test as any;
      expect(server.oauth.grantType).toBe('authorization_code');
      expect(server.oauth.scope).toBe('read write');
    });

    test('accepts valid OAuth config with client_credentials', async () => {
      process.env.TEST_CLIENT_ID = 'test-id';
      process.env.TEST_CLIENT_SECRET = 'test-secret';

      const configPath = join(tempDir, 'oauth_client_creds.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              oauth: {
                grantType: 'client_credentials',
                clientId: '${TEST_CLIENT_ID}',
                clientSecret: '${TEST_CLIENT_SECRET}',
              },
            },
          },
        })
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test as any;
      expect(server.oauth.grantType).toBe('client_credentials');
      expect(server.oauth.clientId).toBe('test-id');
      expect(server.oauth.clientSecret).toBe('test-secret');

      delete process.env.TEST_CLIENT_ID;
      delete process.env.TEST_CLIENT_SECRET;
    });

    test('throws on invalid grantType', async () => {
      const configPath = join(tempDir, 'oauth_bad_grant.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              oauth: {
                grantType: 'invalid_grant',
              },
            },
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('Invalid OAuth grantType');
    });

    test('throws on client_credentials without clientId', async () => {
      const configPath = join(tempDir, 'oauth_no_client_id.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              oauth: {
                grantType: 'client_credentials',
                clientSecret: 'secret',
              },
            },
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('requires clientId');
    });

    test('throws on client_credentials without clientSecret', async () => {
      const configPath = join(tempDir, 'oauth_no_client_secret.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              oauth: {
                grantType: 'client_credentials',
                clientId: 'client-id',
              },
            },
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('requires clientSecret');
    });

    test('throws on invalid callbackPort', async () => {
      const configPath = join(tempDir, 'oauth_bad_port.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              oauth: {
                callbackPort: 99999,
              },
            },
          },
        })
      );

      await expect(loadConfig(configPath)).rejects.toThrow('Invalid callbackPort');
    });

    test('accepts valid callbackPort', async () => {
      const configPath = join(tempDir, 'oauth_valid_port.json');
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            test: {
              url: 'https://example.com',
              oauth: {
                callbackPort: 9000,
              },
            },
          },
        })
      );

      const config = await loadConfig(configPath);
      const server = config.mcpServers.test as any;
      expect(server.oauth.callbackPort).toBe(9000);
    });
  });
});
