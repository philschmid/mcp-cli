/**
 * OAuth Provider Implementation for mcp-cli
 *
 * Implements OAuthClientProvider interface with file-based token storage
 * for persistent authentication across CLI invocations.
 */

import { exec } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { type Server, createServer } from 'node:http';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { debug } from './config.js';

/**
 * Get the MCP CLI storage directory
 * Can be overridden via MCP_CLI_HOME env var for testing
 */
function getMcpCliDir(): string {
  const baseDir = process.env.MCP_CLI_HOME || homedir();
  return join(baseDir, '.mcp-cli');
}

// Storage directories (lazily resolved)
function getStoragePaths() {
  const mcpCliDir = getMcpCliDir();
  return {
    tokens: join(mcpCliDir, 'tokens'),
    clients: join(mcpCliDir, 'clients'),
    verifiers: join(mcpCliDir, 'verifiers'),
  };
}

// Default callback port for OAuth redirect
const DEFAULT_CALLBACK_PORT = 8095;

/**
 * OAuth configuration from server config
 */
export interface OAuthConfig {
  grantType?: 'authorization_code' | 'client_credentials';
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  callbackPort?: number;
}

/**
 * Ensure a directory exists
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read JSON file safely
 */
function readJsonFile<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) {
      return undefined;
    }
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    debug(`Failed to read ${path}: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Write JSON file safely
 */
function writeJsonFile(path: string, data: unknown): void {
  ensureDir(join(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Read text file safely
 */
function readTextFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) {
      return undefined;
    }
    return readFileSync(path, 'utf-8').trim();
  } catch (error) {
    debug(`Failed to read ${path}: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Write text file safely
 */
function writeTextFile(path: string, content: string): void {
  ensureDir(join(path, '..'));
  writeFileSync(path, content, { mode: 0o600 });
}

/**
 * Delete file safely
 */
function deleteFile(path: string): void {
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch (error) {
    debug(`Failed to delete ${path}: ${(error as Error).message}`);
  }
}

/**
 * Sanitize server name for use as filename
 */
function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Get file paths for a server
 */
function getServerPaths(serverName: string): {
  tokens: string;
  client: string;
  verifier: string;
} {
  const safeName = sanitizeServerName(serverName);
  const dirs = getStoragePaths();
  return {
    tokens: join(dirs.tokens, `${safeName}.json`),
    client: join(dirs.clients, `${safeName}.json`),
    verifier: join(dirs.verifiers, `${safeName}.txt`),
  };
}

/**
 * Open URL in default browser (cross-platform)
 */
export function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();
    let command: string;

    switch (os) {
      case 'darwin':
        command = `open "${url}"`;
        break;
      case 'win32':
        command = `start "" "${url}"`;
        break;
      default:
        // Linux and others
        command = `xdg-open "${url}"`;
    }

    debug(`Opening browser: ${command}`);

    exec(command, (error) => {
      if (error) {
        console.error(`Failed to open browser: ${error.message}`);
        console.error(`Please manually open: ${url}`);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Result from OAuth callback
 */
export interface OAuthCallbackResult {
  code: string;
}

/**
 * Callback server state for managing the OAuth callback listener
 */
interface CallbackServerState {
  server: Server;
  promise: Promise<OAuthCallbackResult>;
  cleanup: () => void;
}

/**
 * Start an OAuth callback server that listens for the authorization code
 * Returns immediately with a promise that resolves when the callback is received
 */
function startCallbackServer(
  port: number,
  timeoutMs = 300000,
): Promise<CallbackServerState> {
  return new Promise((resolveStart, rejectStart) => {
    let callbackResolve: (result: OAuthCallbackResult) => void;
    let callbackReject: (error: Error) => void;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let server: Server | undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (server) {
        server.close();
        server = undefined;
      }
    };

    const callbackPromise = new Promise<OAuthCallbackResult>(
      (resolve, reject) => {
        callbackResolve = resolve;
        callbackReject = reject;
      },
    );

    timeoutId = setTimeout(() => {
      cleanup();
      callbackReject(
        new Error('OAuth callback timeout - no authorization code received'),
      );
    }, timeoutMs);

    server = createServer((req, res) => {
      // Ignore favicon requests
      if (req.url === '/favicon.ico') {
        res.writeHead(404);
        res.end();
        return;
      }

      debug(`Received OAuth callback: ${req.url}`);

      const parsedUrl = new URL(req.url || '', `http://localhost:${port}`);
      const code = parsedUrl.searchParams.get('code');
      const error = parsedUrl.searchParams.get('error');
      const errorDescription = parsedUrl.searchParams.get('error_description');

      if (code) {
        debug(`Authorization code received: ${code.substring(0, 10)}...`);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Authorization Successful</title></head>
            <body style="font-family: system-ui, sans-serif; text-align: center; padding: 50px;">
              <h1>Authorization Successful</h1>
              <p>You can close this window and return to the terminal.</p>
              <script>setTimeout(() => window.close(), 2000);</script>
            </body>
          </html>
        `);

        cleanup();
        callbackResolve({ code });
      } else if (error) {
        const message = errorDescription || error;
        debug(`OAuth error: ${message}`);

        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Authorization Failed</title></head>
            <body style="font-family: system-ui, sans-serif; text-align: center; padding: 50px;">
              <h1>Authorization Failed</h1>
              <p>Error: ${message}</p>
            </body>
          </html>
        `);

        cleanup();
        callbackReject(new Error(`OAuth authorization failed: ${message}`));
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request: missing authorization code');
      }
    });

    server.on('error', (error) => {
      cleanup();
      rejectStart(
        new Error(`Failed to start OAuth callback server: ${error.message}`),
      );
    });

    server.listen(port, () => {
      debug(
        `OAuth callback server listening on http://localhost:${port}/callback`,
      );
      resolveStart({
        server: server!,
        promise: callbackPromise,
        cleanup,
      });
    });
  });
}

/**
 * Wait for OAuth callback on local server
 * Returns the authorization code from the callback
 * @deprecated Use McpCliOAuthProvider.waitForCallback() instead
 */
export async function waitForOAuthCallback(
  port: number = DEFAULT_CALLBACK_PORT,
  timeoutMs = 300000,
): Promise<OAuthCallbackResult> {
  const state = await startCallbackServer(port, timeoutMs);
  return state.promise;
}

/**
 * MCP CLI OAuth Provider
 *
 * Implements the OAuthClientProvider interface with file-based persistence
 * for tokens, client information, and PKCE verifiers.
 */
export class McpCliOAuthProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly oauthConfig: OAuthConfig;
  private readonly serverUrl: string;
  private readonly paths: { tokens: string; client: string; verifier: string };

  // Callback server state - started before browser opens
  private callbackServerState: CallbackServerState | null = null;
  private callbackServerStarting: Promise<void> | null = null;

  // Whether interactive auth (browser + callback) is allowed
  private _allowInteractiveAuth = true;

  constructor(serverName: string, serverUrl: string, oauthConfig: OAuthConfig) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.oauthConfig = oauthConfig;
    this.paths = getServerPaths(serverName);

    // Ensure storage directories exist
    const dirs = getStoragePaths();
    ensureDir(dirs.tokens);
    ensureDir(dirs.clients);
    ensureDir(dirs.verifiers);
  }

  /**
   * Redirect URL for OAuth callback
   * Returns undefined for client_credentials flow (non-interactive)
   */
  get redirectUrl(): string | URL | undefined {
    if (this.oauthConfig.grantType === 'client_credentials') {
      return undefined;
    }
    const port = this.oauthConfig.callbackPort || DEFAULT_CALLBACK_PORT;
    return `http://localhost:${port}/callback`;
  }

  /**
   * OAuth client metadata
   */
  get clientMetadata(): OAuthClientMetadata {
    const redirectUrl = this.redirectUrl;
    const grantTypes =
      this.oauthConfig.grantType === 'client_credentials'
        ? ['client_credentials']
        : ['authorization_code', 'refresh_token'];

    // Convert URL to string if needed
    const redirectUriStr = redirectUrl ? String(redirectUrl) : undefined;

    return {
      client_name: `mcp-cli (${this.serverName})`,
      // Zod validates these as URLs at runtime; TypeScript type expects string[]
      redirect_uris: redirectUriStr ? [redirectUriStr] : [],
      grant_types: grantTypes,
      response_types:
        this.oauthConfig.grantType === 'client_credentials' ? [] : ['code'],
      token_endpoint_auth_method: this.oauthConfig.clientSecret
        ? 'client_secret_post'
        : 'none',
      scope: this.oauthConfig.scope,
    };
  }

  /**
   * Load client information from config or file
   */
  clientInformation(): OAuthClientInformationMixed | undefined {
    // First check if client ID is configured statically
    if (this.oauthConfig.clientId) {
      const info: OAuthClientInformationMixed = {
        client_id: this.oauthConfig.clientId,
      };
      if (this.oauthConfig.clientSecret) {
        info.client_secret = this.oauthConfig.clientSecret;
      }
      return info;
    }

    // Otherwise, try to load from dynamic registration
    return readJsonFile<OAuthClientInformationMixed>(this.paths.client);
  }

  /**
   * Save dynamically registered client information
   */
  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    debug(`Saving client information for ${this.serverName}`);
    writeJsonFile(this.paths.client, clientInformation);
  }

  /**
   * Load OAuth tokens
   */
  tokens(): OAuthTokens | undefined {
    return readJsonFile<OAuthTokens>(this.paths.tokens);
  }

  /**
   * Save OAuth tokens
   */
  saveTokens(tokens: OAuthTokens): void {
    debug(`Saving tokens for ${this.serverName}`);
    writeJsonFile(this.paths.tokens, tokens);
  }

  /**
   * Set whether interactive auth is allowed
   * When disabled, redirectToAuthorization will not open browser or start server
   */
  setAllowInteractiveAuth(allow: boolean): void {
    this._allowInteractiveAuth = allow;
  }

  /**
   * Check if interactive auth was blocked
   */
  get interactiveAuthBlocked(): boolean {
    return !this._allowInteractiveAuth;
  }

  /**
   * Redirect to authorization URL
   * Starts the callback server FIRST, then opens the browser
   * This prevents the race condition where the browser redirects before the server is ready
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    // If interactive auth is disabled, don't start server or open browser
    if (!this._allowInteractiveAuth) {
      debug(
        `Interactive auth disabled for ${this.serverName}, skipping browser redirect`,
      );
      return;
    }

    const port = this.getCallbackPort();

    // Start the callback server BEFORE opening the browser
    // This is critical to avoid race conditions
    // Store the promise so waitForCallback can properly await it
    this.callbackServerStarting = startCallbackServer(port)
      .then((state) => {
        this.callbackServerState = state;
        this.callbackServerStarting = null;
        debug(`Callback server ready for ${this.serverName}`);

        // Now open the browser
        console.error(`\nAuthorizing ${this.serverName}...`);
        console.error(
          `If the browser doesn't open, visit: ${authorizationUrl.toString()}`,
        );
        openBrowser(authorizationUrl.toString()).catch(() => {
          // Error already logged in openBrowser
        });
      })
      .catch((error) => {
        this.callbackServerStarting = null;
        console.error(`Failed to start callback server: ${error.message}`);
        console.error(
          `Please manually visit: ${authorizationUrl.toString()}`,
        );
        throw error;
      });
  }

  /**
   * Wait for the OAuth callback to complete
   * Returns the authorization code
   */
  async waitForCallback(): Promise<OAuthCallbackResult> {
    // Wait for server to finish starting if in progress
    if (this.callbackServerStarting) {
      await this.callbackServerStarting;
    }

    if (!this.callbackServerState) {
      // Fallback: start server now if not already started
      const port = this.getCallbackPort();
      this.callbackServerState = await startCallbackServer(port);
    }
    return this.callbackServerState.promise;
  }

  /**
   * Check if this provider has a pending callback server
   */
  hasPendingCallback(): boolean {
    return this.callbackServerState !== null;
  }

  /**
   * Clean up the callback server if running
   */
  cleanupCallbackServer(): void {
    if (this.callbackServerState) {
      this.callbackServerState.cleanup();
      this.callbackServerState = null;
    }
  }

  /**
   * Save PKCE code verifier
   */
  saveCodeVerifier(codeVerifier: string): void {
    debug(`Saving code verifier for ${this.serverName}`);
    writeTextFile(this.paths.verifier, codeVerifier);
  }

  /**
   * Load PKCE code verifier
   */
  codeVerifier(): string {
    const verifier = readTextFile(this.paths.verifier);
    if (!verifier) {
      throw new Error(
        'No code verifier found - OAuth flow may have been interrupted',
      );
    }
    return verifier;
  }

  /**
   * Invalidate stored credentials
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    debug(`Invalidating credentials for ${this.serverName}: ${scope}`);

    switch (scope) {
      case 'all':
        deleteFile(this.paths.tokens);
        deleteFile(this.paths.client);
        deleteFile(this.paths.verifier);
        break;
      case 'client':
        deleteFile(this.paths.client);
        break;
      case 'tokens':
        deleteFile(this.paths.tokens);
        break;
      case 'verifier':
        deleteFile(this.paths.verifier);
        break;
    }
  }

  /**
   * Prepare token request for client_credentials flow
   */
  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (this.oauthConfig.grantType !== 'client_credentials') {
      return undefined;
    }

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
    });

    const requestScope = scope || this.oauthConfig.scope;
    if (requestScope) {
      params.set('scope', requestScope);
    }

    return params;
  }

  /**
   * Get the callback port for this provider
   */
  getCallbackPort(): number {
    return this.oauthConfig.callbackPort || DEFAULT_CALLBACK_PORT;
  }
}
