/**
 * OAuth file storage utilities
 *
 * Handles persistent storage of OAuth tokens, client information,
 * and PKCE verifiers with secure file permissions.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../config.js';

/**
 * Get the MCP CLI storage directory
 * Can be overridden via MCP_CLI_HOME env var for testing
 */
export function getMcpCliDir(): string {
  const baseDir = process.env.MCP_CLI_HOME || homedir();
  return join(baseDir, '.mcp-cli');
}

/**
 * Get storage directory paths
 */
export function getStoragePaths() {
  const mcpCliDir = getMcpCliDir();
  return {
    tokens: join(mcpCliDir, 'tokens'),
    clients: join(mcpCliDir, 'clients'),
    verifiers: join(mcpCliDir, 'verifiers'),
  };
}

/**
 * Ensure a directory exists with secure permissions
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read JSON file safely
 */
export function readJsonFile<T>(path: string): T | undefined {
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
 * Write JSON file safely with secure permissions
 */
export function writeJsonFile(path: string, data: unknown): void {
  ensureDir(join(path, '..'));
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Read text file safely
 */
export function readTextFile(path: string): string | undefined {
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
 * Write text file safely with secure permissions
 */
export function writeTextFile(path: string, content: string): void {
  ensureDir(join(path, '..'));
  writeFileSync(path, content, { mode: 0o600 });
}

/**
 * Delete file safely
 */
export function deleteFile(path: string): void {
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
export function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Get file paths for a server's OAuth data
 */
export function getServerPaths(serverName: string): {
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
