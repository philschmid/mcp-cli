/**
 * OAuth Callback Server - Local HTTP server for OAuth redirects
 */

import { debug } from '../config.js';

// Bun Server type - we use ReturnType to infer from Bun.serve
type BunServer = ReturnType<typeof Bun.serve>;

/**
 * OAuth callback data received from the authorization server
 */
export interface CallbackData {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

/**
 * Pending callback promise
 */
interface PendingCallback {
  resolve: (data: CallbackData) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * HTML response for successful OAuth callback
 */
function successHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Authorization Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    h1 { margin: 0 0 16px 0; font-size: 24px; }
    p { margin: 0; opacity: 0.9; }
    .checkmark {
      font-size: 48px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">✓</div>
    <h1>Authorization Successful!</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`;
}

/**
 * HTML response for OAuth error
 */
function errorHtml(error: string, description?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Authorization Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    h1 { margin: 0 0 16px 0; font-size: 24px; }
    p { margin: 0; opacity: 0.9; }
    .error-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    .error-details {
      margin-top: 16px;
      font-size: 14px;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">✗</div>
    <h1>Authorization Failed</h1>
    <p>${description || error}</p>
    <p class="error-details">Error: ${error}</p>
  </div>
</body>
</html>`;
}

/**
 * OAuth callback server singleton
 */
class OAuthCallbackServer {
  private server: BunServer | null = null;
  private pendingCallbacks: Map<string, PendingCallback> = new Map();
  private static instance: OAuthCallbackServer | null = null;

  static getInstance(): OAuthCallbackServer {
    if (!OAuthCallbackServer.instance) {
      OAuthCallbackServer.instance = new OAuthCallbackServer();
    }
    return OAuthCallbackServer.instance;
  }

  /**
   * Ensure the server is running
   * @param preferredPort Optional preferred port. Tries 80 first for OAuth compatibility, then falls back.
   */
  async ensureRunning(preferredPort?: number): Promise<void> {
    if (this.server) return;

    // Ports to try in order - port 80 for OAuth compatibility (http://localhost/callback)
    // then fall back to common development ports
    const portsToTry = preferredPort ? [preferredPort] : [80, 8080, 3000, 0]; // 0 = random port

    const createFetch = () => (req: Request) => {
      const url = new URL(req.url);

      // Handle OAuth callback at /callback
      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');

        // Handle error from OAuth provider
        if (error) {
          const callbackData: CallbackData = {
            code: '',
            state: state || '',
            error,
            errorDescription: errorDescription || undefined,
          };

          // Resolve pending callback with error
          if (state) {
            const pending = this.pendingCallbacks.get(state);
            if (pending) {
              clearTimeout(pending.timeout);
              pending.resolve(callbackData);
              this.pendingCallbacks.delete(state);
            }
          }

          return new Response(errorHtml(error, errorDescription || undefined), {
            headers: { 'Content-Type': 'text/html' },
          });
        }

        // Validate required params
        if (!code || !state) {
          return new Response(
            errorHtml('invalid_request', 'Missing code or state parameter'),
            {
              status: 400,
              headers: { 'Content-Type': 'text/html' },
            },
          );
        }

        const callbackData: CallbackData = {
          code,
          state,
        };

        // Resolve pending callback
        const pending = this.pendingCallbacks.get(state);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(callbackData);
          this.pendingCallbacks.delete(state);
        }

        return new Response(successHtml(), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    };

    // Try each port until one works
    for (const port of portsToTry) {
      try {
        this.server = Bun.serve({
          port,
          fetch: createFetch(),
        });
        debug(`OAuth callback server started on port ${this.server.port}`);
        return;
      } catch (error) {
        debug(
          `Failed to start callback server on port ${port}: ${(error as Error).message}`,
        );
        // Continue to next port
      }
    }

    throw new Error(
      'Failed to start OAuth callback server. Try running with sudo for port 80, or ensure ports 8080/3000 are available.',
    );
  }

  /**
   * Wait for OAuth callback with matching state
   * @param state The state parameter to match
   * @param timeout Timeout in milliseconds (default: 5 minutes)
   */
  waitForCallback(state: string, timeout = 300000): Promise<CallbackData> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingCallbacks.delete(state);
        reject(
          new Error(`OAuth callback timeout after ${timeout / 1000} seconds`),
        );
      }, timeout);

      this.pendingCallbacks.set(state, {
        resolve,
        reject,
        timeout: timeoutId,
      });
    });
  }

  /**
   * Cancel a pending callback
   */
  cancelPending(state: string): void {
    const pending = this.pendingCallbacks.get(state);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Callback cancelled'));
      this.pendingCallbacks.delete(state);
    }
  }

  /**
   * Stop the callback server
   */
  stop(): void {
    // Reject all pending callbacks
    for (const [state, pending] of this.pendingCallbacks) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server stopped'));
      this.pendingCallbacks.delete(state);
    }

    this.server?.stop();
    this.server = null;
    debug('OAuth callback server stopped');
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Get the port the server is listening on
   */
  getPort(): number {
    if (!this.server || this.server.port === undefined) {
      throw new Error('Server not running or port not available');
    }
    return this.server.port;
  }

  /**
   * Get the redirect URL for OAuth
   * Returns http://localhost/callback for port 80 (standard OAuth format)
   */
  getRedirectUrl(): string {
    const port = this.getPort();
    // Standard HTTP port doesn't need to be specified in URL
    if (port === 80) {
      return 'http://localhost/callback';
    }
    return `http://localhost:${port}/callback`;
  }
}

// Export singleton instance
export const oauthCallbackServer = OAuthCallbackServer.getInstance();
