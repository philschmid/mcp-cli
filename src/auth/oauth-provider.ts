/**
 * OAuth Client Provider - Implements OAuthClientProvider for MCP CLI
 *
 * This provider handles the full OAuth flow:
 * 1. Checks for existing tokens
 * 2. Redirects user to authorization if needed
 * 3. Handles the callback and exchanges code for tokens
 * 4. Persists tokens to disk for future use
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { debug } from '../config.js';
import { oauthCallbackServer } from './callback-server.js';
import {
  clearOAuthData,
  getStoredOAuthData,
  saveOAuthData,
} from './token-storage.js';

/**
 * Options for the CLI OAuth provider
 */
export interface CliOAuthProviderOptions {
  /** The server URL (used for token storage key) */
  serverUrl: string;
  /** Client name to display during registration */
  clientName?: string;
  /** Callback when user needs to authorize in browser */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

/**
 * Generate a random state parameter for CSRF protection
 */
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * Open a URL in the user's default browser
 */
async function openBrowser(url: string): Promise<boolean> {
  try {
    const { exec } = await import('node:child_process');
    const platform = process.platform;

    let command: string;
    if (platform === 'darwin') {
      command = `open "${url}"`;
    } else if (platform === 'win32') {
      command = `start "" "${url}"`;
    } else {
      // Linux and others
      command = `xdg-open "${url}"`;
    }

    exec(command, (error) => {
      if (error) {
        debug(`Failed to open browser: ${error.message}`);
      }
    });

    return true;
  } catch (error) {
    debug(`Failed to open browser: ${(error as Error).message}`);
    return false;
  }
}

/**
 * CLI OAuth Client Provider
 *
 * Implements the full OAuth authorization code flow with PKCE for CLI applications.
 * Tokens are persisted to disk for reuse across sessions.
 */
export class CliOAuthProvider implements OAuthClientProvider {
  private readonly serverUrl: string;
  private readonly _clientMetadata: OAuthClientMetadata;
  private _clientInfo?: OAuthClientInformationMixed;
  private _tokens?: OAuthTokens;
  private _codeVerifier?: string;
  private _state?: string;
  private onAuthorizationUrl?: (url: URL) => void | Promise<void>;

  constructor(options: CliOAuthProviderOptions) {
    this.serverUrl = options.serverUrl;
    this.onAuthorizationUrl = options.onAuthorizationUrl;

    // Load stored data
    const stored = getStoredOAuthData(this.serverUrl);
    if (stored) {
      this._tokens = stored.tokens;
      if (stored.clientId) {
        this._clientInfo = {
          client_id: stored.clientId,
          client_secret: stored.clientSecret,
        };
      }
      this._codeVerifier = stored.codeVerifier;
    }

    // Define client metadata for dynamic registration
    // Note: Some MCP servers (like Datadog's) use a pre-registered shared client
    // and will return fixed redirect_uris regardless of what we send
    // The redirect_uris will be updated dynamically when clientMetadata getter is called
    this._clientMetadata = {
      client_name: options.clientName || 'MCP CLI',
      redirect_uris: ['http://localhost/callback'], // Will be overridden dynamically
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client
    };
  }

  /**
   * Get the redirect URL for OAuth
   * Uses the actual port from the callback server
   */
  get redirectUrl(): string | URL {
    // Get the actual redirect URL from the running callback server
    // This ensures we use the port that's actually listening
    return oauthCallbackServer.getRedirectUrl();
  }

  /**
   * Get client metadata for dynamic registration
   * Returns metadata with dynamically resolved redirect_uris from the callback server
   */
  get clientMetadata(): OAuthClientMetadata {
    // Try to get the actual redirect URL from the callback server
    try {
      const redirectUrl = oauthCallbackServer.getRedirectUrl();
      return {
        ...this._clientMetadata,
        redirect_uris: [redirectUrl],
      };
    } catch {
      // Server not running yet, return default metadata
      return this._clientMetadata;
    }
  }

  /**
   * Generate OAuth state parameter
   */
  state(): string {
    this._state = generateState();
    return this._state;
  }

  /**
   * Get the last generated state parameter
   * Used to match against callback
   */
  getLastState(): string | undefined {
    return this._state;
  }

  /**
   * Get stored client information
   */
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._clientInfo;
  }

  /**
   * Save client information after dynamic registration
   */
  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this._clientInfo = clientInformation;
    saveOAuthData(this.serverUrl, {
      clientId: clientInformation.client_id,
      clientSecret: clientInformation.client_secret,
    });
    debug(`Saved client information for ${this.serverUrl}`);
  }

  /**
   * Get stored tokens
   */
  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  /**
   * Save tokens after successful authorization
   */
  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
    saveOAuthData(this.serverUrl, { tokens });
    debug(`Saved tokens for ${this.serverUrl}`);
  }

  /**
   * Redirect user to authorization URL
   * Opens browser and waits for callback
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Notify caller about the authorization URL
    if (this.onAuthorizationUrl) {
      await this.onAuthorizationUrl(authorizationUrl);
    }

    // Open browser for user authorization
    console.error('\nOpening browser for authorization...');
    console.error(
      `If browser doesn't open, visit: ${authorizationUrl.toString()}\n`,
    );

    const opened = await openBrowser(authorizationUrl.toString());
    if (!opened) {
      console.error(
        `Please open this URL manually: ${authorizationUrl.toString()}`,
      );
    }
  }

  /**
   * Save PKCE code verifier
   */
  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
    saveOAuthData(this.serverUrl, { codeVerifier });
  }

  /**
   * Get PKCE code verifier
   */
  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error('No code verifier saved');
    }
    return this._codeVerifier;
  }

  /**
   * Invalidate credentials when server indicates they're invalid
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    switch (scope) {
      case 'all':
        clearOAuthData(this.serverUrl);
        this._clientInfo = undefined;
        this._tokens = undefined;
        this._codeVerifier = undefined;
        break;
      case 'client':
        this._clientInfo = undefined;
        saveOAuthData(this.serverUrl, {
          clientId: undefined,
          clientSecret: undefined,
        });
        break;
      case 'tokens':
        this._tokens = undefined;
        saveOAuthData(this.serverUrl, { tokens: undefined });
        break;
      case 'verifier':
        this._codeVerifier = undefined;
        saveOAuthData(this.serverUrl, { codeVerifier: undefined });
        break;
    }
    debug(`Invalidated ${scope} credentials for ${this.serverUrl}`);
  }
}

/**
 * Create an OAuth provider for a server URL
 */
export function createOAuthProvider(
  serverUrl: string,
  options?: Partial<CliOAuthProviderOptions>,
): CliOAuthProvider {
  return new CliOAuthProvider({
    serverUrl,
    ...options,
  });
}

/**
 * Start the OAuth callback server if not already running
 */
export async function ensureCallbackServerRunning(): Promise<void> {
  await oauthCallbackServer.ensureRunning();
}

/**
 * Stop the OAuth callback server
 */
export function stopCallbackServer(): void {
  oauthCallbackServer.stop();
}

/**
 * Get the callback server port
 */
export function getCallbackServerPort(): number {
  return oauthCallbackServer.getPort();
}
