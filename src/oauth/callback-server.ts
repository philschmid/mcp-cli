/**
 * OAuth callback server
 *
 * HTTP server that listens for OAuth authorization callbacks
 * and extracts the authorization code.
 */

import { createServer } from 'node:http';
import { debug } from '../config.js';
import type { CallbackServerState, OAuthCallbackResult } from './types.js';

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
 * Start an OAuth callback server that listens for the authorization code
 * Returns immediately with a promise that resolves when the callback is received
 */
export function startCallbackServer(
  port: number,
  timeoutMs = 300000,
): Promise<CallbackServerState> {
  return new Promise((resolveStart, rejectStart) => {
    let callbackResolve: (result: OAuthCallbackResult) => void;
    let callbackReject: (error: Error) => void;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let server: ReturnType<typeof createServer> | undefined;

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
      const httpServer = server;
      if (httpServer) {
        resolveStart({
          server: httpServer,
          promise: callbackPromise,
          cleanup,
        });
      }
    });
  });
}

/**
 * Start an OAuth callback server with port fallback
 * Tries ports in order until one succeeds
 * @returns The server state and the actual port used
 */
export async function startCallbackServerWithFallback(
  portsToTry: number[],
  timeoutMs = 300000,
): Promise<{ state: CallbackServerState; actualPort: number }> {
  const errors: string[] = [];

  for (const port of portsToTry) {
    try {
      debug(
        `Trying to start callback server on port ${port === 0 ? 'random' : port}`,
      );
      const state = await startCallbackServer(port, timeoutMs);
      // Get the actual port (important when port was 0 for random)
      const address = state.server.address();
      const actualPort =
        typeof address === 'object' && address ? address.port : port;
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
