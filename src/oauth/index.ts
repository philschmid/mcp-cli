/**
 * OAuth module for mcp-cli
 *
 * Provides OAuth authentication support for HTTP MCP servers,
 * including authorization code flow with PKCE and client credentials flow.
 */

// Types
export {
  type CallbackServerState,
  DEFAULT_CALLBACK_PORT,
  DEFAULT_PORT_FALLBACK_ORDER,
  type OAuthCallbackResult,
  type OAuthConfig,
} from './types.js';

// Storage utilities
export {
  deleteFile,
  ensureDir,
  getMcpCliDir,
  getServerPaths,
  getStoragePaths,
  readJsonFile,
  readTextFile,
  sanitizeServerName,
  writeJsonFile,
  writeTextFile,
} from './storage.js';

// Browser utilities
export { openBrowser } from './browser.js';

// Callback server
export {
  startCallbackServer,
  startCallbackServerWithFallback,
} from './callback-server.js';

// Main provider
export { McpCliOAuthProvider } from './provider.js';

// Legacy export for backwards compatibility
import { startCallbackServer } from './callback-server.js';
import { DEFAULT_CALLBACK_PORT, type OAuthCallbackResult } from './types.js';

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
