/**
 * Token Storage - Persists OAuth tokens to disk
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { debug } from '../config.js';

/**
 * Stored OAuth data for a server
 */
export interface StoredOAuthData {
  tokens?: OAuthTokens;
  clientId?: string;
  clientSecret?: string;
  codeVerifier?: string;
}

/**
 * All stored OAuth data
 */
interface OAuthStorageFile {
  version: 1;
  servers: Record<string, StoredOAuthData>;
}

/**
 * Get the path to the OAuth storage file
 */
function getStoragePath(): string {
  return join(homedir(), '.config', 'mcp', 'oauth_tokens.json');
}

/**
 * Load stored OAuth data from disk
 */
function loadStorage(): OAuthStorageFile {
  const path = getStoragePath();
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content) as OAuthStorageFile;
      if (data.version === 1 && data.servers) {
        return data;
      }
    }
  } catch (error) {
    debug(`Failed to load OAuth storage: ${(error as Error).message}`);
  }
  return { version: 1, servers: {} };
}

/**
 * Save OAuth data to disk
 */
function saveStorage(data: OAuthStorageFile): void {
  const path = getStoragePath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    debug(`Saved OAuth storage to ${path}`);
  } catch (error) {
    debug(`Failed to save OAuth storage: ${(error as Error).message}`);
  }
}

/**
 * Get a unique key for an OAuth server based on its URL
 */
function getServerKey(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    // Use origin + pathname as the key to differentiate between different endpoints
    return `${url.origin}${url.pathname}`;
  } catch {
    return serverUrl;
  }
}

/**
 * Get stored OAuth data for a server
 */
export function getStoredOAuthData(
  serverUrl: string,
): StoredOAuthData | undefined {
  const storage = loadStorage();
  const key = getServerKey(serverUrl);
  return storage.servers[key];
}

/**
 * Save OAuth data for a server
 */
export function saveOAuthData(
  serverUrl: string,
  data: Partial<StoredOAuthData>,
): void {
  const storage = loadStorage();
  const key = getServerKey(serverUrl);
  storage.servers[key] = { ...storage.servers[key], ...data };
  saveStorage(storage);
}

/**
 * Clear OAuth data for a server
 */
export function clearOAuthData(serverUrl: string): void {
  const storage = loadStorage();
  const key = getServerKey(serverUrl);
  delete storage.servers[key];
  saveStorage(storage);
}

/**
 * Clear all OAuth data
 */
export function clearAllOAuthData(): void {
  saveStorage({ version: 1, servers: {} });
}
