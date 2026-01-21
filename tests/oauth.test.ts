/**
 * Unit tests for OAuth module
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpCliOAuthProvider, type OAuthConfig } from '../src/oauth';

describe('oauth', () => {
  // Use a unique temp directory for each test run to avoid conflicts
  let testDir: string;
  const originalMcpCliHome = process.env.MCP_CLI_HOME;

  beforeEach(() => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `mcp-cli-oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    // Use MCP_CLI_HOME env var to override storage location
    process.env.MCP_CLI_HOME = testDir;
  });

  afterEach(() => {
    // Restore original MCP_CLI_HOME
    if (originalMcpCliHome === undefined) {
      delete process.env.MCP_CLI_HOME;
    } else {
      process.env.MCP_CLI_HOME = originalMcpCliHome;
    }

    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('McpCliOAuthProvider', () => {
    describe('constructor and paths', () => {
      test('creates storage directories', () => {
        const config: OAuthConfig = { scope: 'read' };
        new McpCliOAuthProvider('test-server', 'https://example.com', config);

        expect(existsSync(join(testDir, '.mcp-cli', 'tokens'))).toBe(true);
        expect(existsSync(join(testDir, '.mcp-cli', 'clients'))).toBe(true);
        expect(existsSync(join(testDir, '.mcp-cli', 'verifiers'))).toBe(true);
      });

      test('sanitizes server names for file paths', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider(
          'my/weird:server.name',
          'https://example.com',
          config
        );

        // Save some data to verify path sanitization
        provider.saveTokens({
          access_token: 'test',
          token_type: 'Bearer',
        });

        // Check that a sanitized filename was used
        const tokensDir = join(testDir, '.mcp-cli', 'tokens');
        const files = require('fs').readdirSync(tokensDir);
        expect(files.length).toBe(1);
        expect(files[0]).toBe('my_weird_server_name.json');
      });
    });

    describe('redirectUrl', () => {
      test('returns callback URL for authorization_code flow', () => {
        const config: OAuthConfig = { grantType: 'authorization_code' };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.redirectUrl).toBe('http://localhost:8095/callback');
      });

      test('returns callback URL when grantType is not specified (default)', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.redirectUrl).toBe('http://localhost:8095/callback');
      });

      test('returns undefined for client_credentials flow', () => {
        const config: OAuthConfig = {
          grantType: 'client_credentials',
          clientId: 'id',
          clientSecret: 'secret',
        };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.redirectUrl).toBeUndefined();
      });

      test('uses custom callback port', () => {
        const config: OAuthConfig = { callbackPort: 9999 };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.redirectUrl).toBe('http://localhost:9999/callback');
      });
    });

    describe('clientMetadata', () => {
      test('returns correct metadata for authorization_code flow', () => {
        const config: OAuthConfig = { scope: 'tools:read' };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const metadata = provider.clientMetadata;
        expect(metadata.client_name).toBe('mcp-cli (test)');
        expect(metadata.grant_types).toContain('authorization_code');
        expect(metadata.grant_types).toContain('refresh_token');
        expect(metadata.response_types).toContain('code');
        expect(metadata.scope).toBe('tools:read');
      });

      test('returns correct metadata for client_credentials flow', () => {
        const config: OAuthConfig = {
          grantType: 'client_credentials',
          clientId: 'id',
          clientSecret: 'secret',
        };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const metadata = provider.clientMetadata;
        expect(metadata.grant_types).toEqual(['client_credentials']);
        expect(metadata.response_types).toEqual([]);
        expect(metadata.redirect_uris).toEqual([]);
      });

      test('sets token_endpoint_auth_method based on clientSecret', () => {
        const withSecret: OAuthConfig = { clientId: 'id', clientSecret: 'secret' };
        const providerWithSecret = new McpCliOAuthProvider('test', 'https://example.com', withSecret);
        expect(providerWithSecret.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');

        const withoutSecret: OAuthConfig = { clientId: 'id' };
        const providerWithoutSecret = new McpCliOAuthProvider('test', 'https://example.com', withoutSecret);
        expect(providerWithoutSecret.clientMetadata.token_endpoint_auth_method).toBe('none');
      });
    });

    describe('clientInformation', () => {
      test('returns static client info from config', () => {
        const config: OAuthConfig = { clientId: 'my-client', clientSecret: 'my-secret' };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const info = provider.clientInformation();
        expect(info?.client_id).toBe('my-client');
        expect(info?.client_secret).toBe('my-secret');
      });

      test('returns undefined when no client info configured or saved', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.clientInformation()).toBeUndefined();
      });

      test('loads saved client info from file', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        // Save client info
        provider.saveClientInformation({
          client_id: 'dynamic-client',
          client_secret: 'dynamic-secret',
        });

        // Should load from file
        const info = provider.clientInformation();
        expect(info?.client_id).toBe('dynamic-client');
        expect(info?.client_secret).toBe('dynamic-secret');
      });

      test('prefers static config over saved file', () => {
        const config: OAuthConfig = { clientId: 'static-id' };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        // Save different client info
        provider.saveClientInformation({ client_id: 'saved-id' });

        // Should return static config
        const info = provider.clientInformation();
        expect(info?.client_id).toBe('static-id');
      });
    });

    describe('tokens', () => {
      test('returns undefined when no tokens saved', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.tokens()).toBeUndefined();
      });

      test('saves and loads tokens', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const tokens = {
          access_token: 'test-access-token',
          token_type: 'Bearer',
          refresh_token: 'test-refresh-token',
          expires_in: 3600,
        };

        provider.saveTokens(tokens);

        const loaded = provider.tokens();
        expect(loaded?.access_token).toBe('test-access-token');
        expect(loaded?.refresh_token).toBe('test-refresh-token');
      });

      test('tokens are persisted to file', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        provider.saveTokens({
          access_token: 'persisted-token',
          token_type: 'Bearer',
        });

        // Create new provider instance
        const provider2 = new McpCliOAuthProvider('test', 'https://example.com', config);
        const loaded = provider2.tokens();
        expect(loaded?.access_token).toBe('persisted-token');
      });
    });

    describe('codeVerifier', () => {
      test('throws when no verifier saved', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(() => provider.codeVerifier()).toThrow('No code verifier found');
      });

      test('saves and loads code verifier', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        provider.saveCodeVerifier('test-verifier-123');
        expect(provider.codeVerifier()).toBe('test-verifier-123');
      });
    });

    describe('invalidateCredentials', () => {
      test('invalidates all credentials', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        // Save various credentials
        provider.saveTokens({ access_token: 'token', token_type: 'Bearer' });
        provider.saveClientInformation({ client_id: 'client' });
        provider.saveCodeVerifier('verifier');

        // Verify they exist
        expect(provider.tokens()).toBeDefined();

        // Invalidate all
        provider.invalidateCredentials('all');

        // Verify they're gone
        expect(provider.tokens()).toBeUndefined();
        expect(() => provider.codeVerifier()).toThrow();
      });

      test('invalidates only tokens', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        provider.saveTokens({ access_token: 'token', token_type: 'Bearer' });
        provider.saveCodeVerifier('verifier');

        provider.invalidateCredentials('tokens');

        expect(provider.tokens()).toBeUndefined();
        expect(provider.codeVerifier()).toBe('verifier'); // Still exists
      });

      test('invalidates only verifier', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        provider.saveTokens({ access_token: 'token', token_type: 'Bearer' });
        provider.saveCodeVerifier('verifier');

        provider.invalidateCredentials('verifier');

        expect(provider.tokens()).toBeDefined(); // Still exists
        expect(() => provider.codeVerifier()).toThrow();
      });
    });

    describe('prepareTokenRequest', () => {
      test('returns undefined for authorization_code flow', () => {
        const config: OAuthConfig = { grantType: 'authorization_code' };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.prepareTokenRequest()).toBeUndefined();
      });

      test('returns params for client_credentials flow', () => {
        const config: OAuthConfig = {
          grantType: 'client_credentials',
          clientId: 'id',
          clientSecret: 'secret',
          scope: 'read write',
        };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const params = provider.prepareTokenRequest();
        expect(params?.get('grant_type')).toBe('client_credentials');
        expect(params?.get('scope')).toBe('read write');
      });

      test('allows scope override', () => {
        const config: OAuthConfig = {
          grantType: 'client_credentials',
          clientId: 'id',
          clientSecret: 'secret',
          scope: 'default-scope',
        };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const params = provider.prepareTokenRequest('override-scope');
        expect(params?.get('scope')).toBe('override-scope');
      });
    });

    describe('getCallbackPort', () => {
      test('returns default port', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.getCallbackPort()).toBe(8095);
      });

      test('returns custom port', () => {
        const config: OAuthConfig = { callbackPort: 12345 };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.getCallbackPort()).toBe(12345);
      });
    });

    describe('getPortsToTry', () => {
      test('returns default port fallback order when no config', () => {
        const config: OAuthConfig = {};
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const ports = provider.getPortsToTry();
        // Default order: 80, 8080, 3000, 8095, 0 (random)
        expect(ports).toEqual([80, 8080, 3000, 8095, 0]);
      });

      test('puts configured callbackPort first in fallback order', () => {
        const config: OAuthConfig = { callbackPort: 9000 };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const ports = provider.getPortsToTry();
        expect(ports[0]).toBe(9000);
        // Rest of default order follows (excluding duplicates)
        expect(ports).toContain(80);
        expect(ports).toContain(8080);
      });

      test('uses callbackPorts array when configured', () => {
        const config: OAuthConfig = { callbackPorts: [3000, 3001, 3002] };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const ports = provider.getPortsToTry();
        expect(ports).toEqual([3000, 3001, 3002]);
      });

      test('callbackPorts overrides callbackPort and defaults', () => {
        const config: OAuthConfig = { callbackPort: 9000, callbackPorts: [4000, 4001] };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const ports = provider.getPortsToTry();
        // callbackPorts takes precedence
        expect(ports).toEqual([4000, 4001]);
      });
    });

    describe('redirectUrl with port 80', () => {
      test('omits port from URL when port is 80', () => {
        const config: OAuthConfig = { callbackPort: 80 };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.redirectUrl).toBe('http://localhost/callback');
      });

      test('includes port in URL for non-80 ports', () => {
        const config: OAuthConfig = { callbackPort: 8080 };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        expect(provider.redirectUrl).toBe('http://localhost:8080/callback');
      });
    });

    describe('preStartCallbackServer', () => {
      test('returns 0 for client_credentials flow', async () => {
        const config: OAuthConfig = {
          grantType: 'client_credentials',
          clientId: 'id',
          clientSecret: 'secret',
        };
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        const port = await provider.preStartCallbackServer();
        expect(port).toBe(0);
      });

      test('starts server and returns actual port', async () => {
        const config: OAuthConfig = { callbackPorts: [0] }; // Use random port for test
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        try {
          const port = await provider.preStartCallbackServer();
          expect(port).toBeGreaterThan(0);
          expect(provider.getCallbackPort()).toBe(port);
        } finally {
          provider.cleanupCallbackServer();
        }
      });

      test('returns same port on subsequent calls', async () => {
        const config: OAuthConfig = { callbackPorts: [0] }; // Use random port for test
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        try {
          const port1 = await provider.preStartCallbackServer();
          const port2 = await provider.preStartCallbackServer();
          expect(port1).toBe(port2);
        } finally {
          provider.cleanupCallbackServer();
        }
      });

      test('redirectUrl uses actual port after pre-start', async () => {
        const config: OAuthConfig = { callbackPorts: [0] }; // Use random port
        const provider = new McpCliOAuthProvider('test', 'https://example.com', config);

        try {
          const port = await provider.preStartCallbackServer();
          expect(provider.redirectUrl).toBe(`http://localhost:${port}/callback`);
        } finally {
          provider.cleanupCallbackServer();
        }
      });
    });
  });
});
