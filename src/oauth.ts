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

// Default port fallback order: 80 (standard), common alternatives, then random
const DEFAULT_PORT_FALLBACK_ORDER = [80, 8080, 3000, 8095, 0]; // 0 = random port

/**
 * Pretty HTML template for successful OAuth callback
 */
const SUCCESS_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>Authorization Successful</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      }
      .container {
        background: white;
        padding: 3rem;
        border-radius: 1rem;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        text-align: center;
        max-width: 400px;
      }
      .icon {
        width: 80px;
        height: 80px;
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0 auto 1.5rem;
      }
      .icon svg { width: 40px; height: 40px; color: white; }
      h1 { color: #1f2937; font-size: 1.5rem; margin-bottom: 0.5rem; }
      p { color: #6b7280; line-height: 1.6; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="icon">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
        </svg>
      </div>
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to the terminal.</p>
    </div>
    <script>setTimeout(() => window.close(), 2000);</script>
  </body>
</html>`;

/**
 * Pretty HTML template for OAuth error
 */
function errorHtml(message: string): string {
  const escapedMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html>
  <head>
    <title>Authorization Failed</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      }
      .container {
        background: white;
        padding: 3rem;
        border-radius: 1rem;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        text-align: center;
        max-width: 400px;
      }
      .icon {
        width: 80px;
        height: 80px;
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 0 auto 1.5rem;
      }
      .icon svg { width: 40px; height: 40px; color: white; }
      h1 { color: #1f2937; font-size: 1.5rem; margin-bottom: 0.5rem; }
      p { color: #6b7280; line-height: 1.6; }
      .error { color: #dc2626; font-family: monospace; margin-top: 1rem; padding: 0.5rem; background: #fef2f2; border-radius: 0.25rem; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="icon">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </div>
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${escapedMessage}</div>
    </div>
  </body>
</html>`;
}

/**
 * OAuth configuration from server config
 */
export interface OAuthConfig {
  grantType?: 'authorization_code' | 'client_credentials';
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  callbackPort?: number;
  /** Optional: explicit list of ports to try in order (overrides default fallback) */
  callbackPorts?: number[];
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
        res.end(SUCCESS_HTML);

        cleanup();
        callbackResolve({ code });
      } else if (error) {
        const message = errorDescription || error;
        debug(`OAuth error: ${message}`);

        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(errorHtml(message));

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
 * Start an OAuth callback server with port fallback
 * Tries ports in order until one succeeds
 * @returns The server state and the actual port used
 */
async function startCallbackServerWithFallback(
  portsToTry: number[],
  timeoutMs = 300000,
): Promise<{ state: CallbackServerState; actualPort: number }> {
  const errors: string[] = [];

  for (const port of portsToTry) {
    try {
      debug(`Trying to start callback server on port ${port === 0 ? 'random' : port}`);
      const state = await startCallbackServer(port, timeoutMs);
      // Get the actual port (important when port was 0 for random)
      const address = state.server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      debug(`Callback server started on port ${actualPort}`);
      return { state, actualPort };
    } catch (error) {
      const message = (error as Error).message;
      debug(`Port ${port} failed: ${message}`);
      errors.push(`Port ${port}: ${message}`);
      // Continue to next port
    }
  }

  // All ports failed
  throw new Error(
    `Failed to start OAuth callback server. Tried ports: ${portsToTry.join(', ')}.\n${errors.join('\n')}`,
  );
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

  // Actual port used by callback server (may differ from configured port due to fallback)
  private actualCallbackPort: number | null = null;

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
   * Uses actualCallbackPort if pre-started, otherwise configured/default port
   * Omits port from URL when using port 80 (standard HTTP port)
   */
  get redirectUrl(): string | URL | undefined {
    if (this.oauthConfig.grantType === 'client_credentials') {
      return undefined;
    }
    // Use actual port if server was pre-started, otherwise fall back to configured/default
    const port = this.actualCallbackPort ?? this.oauthConfig.callbackPort ?? DEFAULT_CALLBACK_PORT;
    // Omit port from URL when using standard HTTP port 80
    if (port === 80) {
      return 'http://localhost/callback';
    }
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
   * Starts the callback server FIRST (with port fallback), then opens the browser
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

    const portsToTry = this.getPortsToTry();

    // Start the callback server BEFORE opening the browser
    // This is critical to avoid race conditions
    // Store the promise so waitForCallback can properly await it
    this.callbackServerStarting = startCallbackServerWithFallback(portsToTry)
      .then(({ state, actualPort }) => {
        this.callbackServerState = state;
        this.actualCallbackPort = actualPort;
        this.callbackServerStarting = null;
        debug(`Callback server ready for ${this.serverName} on port ${actualPort}`);

        // Update authorization URL with actual redirect_uri
        const actualRedirectUri = this.redirectUrl;
        if (actualRedirectUri) {
          authorizationUrl.searchParams.set('redirect_uri', String(actualRedirectUri));
        }

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
      // Fallback: start server now if not already started (with port fallback)
      const portsToTry = this.getPortsToTry();
      const { state, actualPort } = await startCallbackServerWithFallback(portsToTry);
      this.callbackServerState = state;
      this.actualCallbackPort = actualPort;
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
    return this.actualCallbackPort ?? this.oauthConfig.callbackPort ?? DEFAULT_CALLBACK_PORT;
  }

  /**
   * Get the list of ports to try for the callback server
   * If a specific port is configured, it comes first
   * Then falls back to the default port order
   */
  getPortsToTry(): number[] {
    const ports: number[] = [];

    // If explicit callbackPorts array is configured, use it
    if (this.oauthConfig.callbackPorts && this.oauthConfig.callbackPorts.length > 0) {
      return [...this.oauthConfig.callbackPorts];
    }

    // If a single callbackPort is configured, try it first
    if (this.oauthConfig.callbackPort) {
      ports.push(this.oauthConfig.callbackPort);
    }

    // Add default fallback ports (excluding any already added)
    for (const port of DEFAULT_PORT_FALLBACK_ORDER) {
      if (!ports.includes(port)) {
        ports.push(port);
      }
    }

    return ports;
  }

  /**
   * Pre-start the callback server to determine the actual port
   * Call this before accessing redirectUrl to ensure correct port in authorization URL
   * Returns the actual port used
   */
  async preStartCallbackServer(): Promise<number> {
    // Skip for client_credentials flow
    if (this.oauthConfig.grantType === 'client_credentials') {
      return 0;
    }

    // Already started or starting
    if (this.actualCallbackPort !== null) {
      return this.actualCallbackPort;
    }
    if (this.callbackServerStarting) {
      await this.callbackServerStarting;
      return this.actualCallbackPort!;
    }

    const portsToTry = this.getPortsToTry();
    debug(`Pre-starting callback server for ${this.serverName}, trying ports: ${portsToTry.join(', ')}`);

    const { state, actualPort } = await startCallbackServerWithFallback(portsToTry);
    this.callbackServerState = state;
    this.actualCallbackPort = actualPort;

    debug(`Callback server pre-started on port ${actualPort} for ${this.serverName}`);
    return actualPort;
  }
}
