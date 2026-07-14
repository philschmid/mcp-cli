/**
 * MCP CLI OAuth Provider
 *
 * Implements the OAuthClientProvider interface with file-based persistence
 * for tokens, client information, and PKCE verifiers.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { debug } from '../config.js';
import { openBrowser } from './browser.js';
import { startCallbackServerWithFallback } from './callback-server.js';
import {
  deleteFile,
  ensureDir,
  getServerPaths,
  getStoragePaths,
  readJsonFile,
  readTextFile,
  writeJsonFile,
  writeTextFile,
} from './storage.js';
import {
  type CallbackServerState,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_PORT_FALLBACK_ORDER,
  type OAuthCallbackResult,
  type OAuthConfig,
} from './types.js';

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

  // Captured authorization URL for non-interactive mode
  private _capturedAuthUrl: string | null = null;

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
    const port =
      this.actualCallbackPort ??
      this.oauthConfig.callbackPort ??
      DEFAULT_CALLBACK_PORT;
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
   * Validates that stored redirect_uris match current redirectUrl
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
    const stored = readJsonFile<
      OAuthClientInformationMixed & { redirect_uris?: string[] }
    >(this.paths.client);

    // Validate stored redirect_uris match current redirectUrl
    // If they don't match, the server will reject with "Invalid redirect_uri"
    if (stored?.redirect_uris && stored.redirect_uris.length > 0) {
      const currentRedirectUrl = this.redirectUrl
        ? String(this.redirectUrl)
        : undefined;
      const storedHasCurrentUrl =
        currentRedirectUrl && stored.redirect_uris.includes(currentRedirectUrl);

      if (!storedHasCurrentUrl) {
        debug(
          `Stored client redirect_uris [${stored.redirect_uris.join(', ')}] don't match current [${currentRedirectUrl}] - invalidating client registration`,
        );
        this.invalidateCredentials('client');
        return undefined;
      }
    }

    return stored;
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
   * Get the captured authorization URL (for non-interactive mode)
   */
  get capturedAuthUrl(): string | null {
    return this._capturedAuthUrl;
  }

  /**
   * Redirect to authorization URL
   * Captures auth URL for AI agents - never opens browser
   * Background callback server is already pre-started
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    debug(`Capturing auth URL for ${this.serverName} (non-interactive mode)`);

    // Update auth URL with actual redirect_uri (from pre-started server)
    const actualRedirectUri = this.redirectUrl;
    if (actualRedirectUri) {
      authorizationUrl.searchParams.set(
        'redirect_uri',
        String(actualRedirectUri),
      );
    }

    // Capture the auth URL for inclusion in error message
    this._capturedAuthUrl = authorizationUrl.toString();
    debug(`Captured auth URL: ${this._capturedAuthUrl}`);

    // Background server is already pre-started (from preStartCallbackServer)
    // It will continue running for the timeout period (default 5 min)
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
      const { state, actualPort } =
        await startCallbackServerWithFallback(portsToTry);
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
   * Clean up the callback server if running.
   *
   * Production code does NOT call this - the server self-cleans on:
   * - Success: when authorization code is received
   * - Error: when OAuth error is returned
   * - Timeout: after 5 minute timeout expires
   *
   * This method exists for tests that start servers without completing OAuth.
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
    return (
      this.actualCallbackPort ??
      this.oauthConfig.callbackPort ??
      DEFAULT_CALLBACK_PORT
    );
  }

  /**
   * Get the list of ports to try for the callback server
   * If a specific port is configured, it comes first
   * Then falls back to the default port order
   */
  getPortsToTry(): number[] {
    const ports: number[] = [];

    // If explicit callbackPorts array is configured, use it
    if (
      this.oauthConfig.callbackPorts &&
      this.oauthConfig.callbackPorts.length > 0
    ) {
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
      // After awaiting, actualCallbackPort is guaranteed to be set
      if (this.actualCallbackPort !== null) {
        return this.actualCallbackPort;
      }
    }

    const portsToTry = this.getPortsToTry();
    debug(
      `Pre-starting callback server for ${this.serverName}, trying ports: ${portsToTry.join(', ')}`,
    );

    const { state, actualPort } =
      await startCallbackServerWithFallback(portsToTry);
    this.callbackServerState = state;
    this.actualCallbackPort = actualPort;

    debug(
      `Callback server pre-started on port ${actualPort} for ${this.serverName}`,
    );
    return actualPort;
  }
}
