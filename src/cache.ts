/**
 * Tool list caching to avoid spawning fresh subprocesses
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolInfo } from './client.js';
import { debug } from './config.js';

/**
 * Default cache TTL in milliseconds
 * @env MCP_CACHE_TTL - cache TTL in seconds (default: 3600 = 1 hour)
 */
const DEFAULT_CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Get cache TTL in milliseconds from environment or default
 */
export function getCacheTTLMs(): number {
  const envTTL = process.env.MCP_CACHE_TTL;
  if (envTTL) {
    const seconds = Number.parseInt(envTTL, 10);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_CACHE_TTL_SECONDS * 1000;
}

/**
 * Check if caching is disabled
 * @env MCP_NO_CACHE - set to "true" to disable caching
 */
export function isCacheDisabled(): boolean {
  const value = process.env.MCP_NO_CACHE?.toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * Get cache directory path
 */
export function getCacheDir(): string {
  const home = homedir();
  return join(home, '.cache', 'mcp-cli');
}

/**
 * Ensure cache directory exists
 */
function ensureCacheDir(): void {
  const cacheDir = getCacheDir();
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
}

/**
 * Get cache file path for a server
 */
function getCacheFilePath(serverName: string): string {
  // Sanitize server name for use in filename
  const safeName = serverName.replace(/[^a-z0-9_-]/gi, '_');
  return join(getCacheDir(), `${safeName}.json`);
}

/**
 * Cached tool list data structure
 */
interface CachedToolList {
  serverName: string;
  tools: ToolInfo[];
  timestamp: number;
  version: number; // Cache format version
}

const CACHE_VERSION = 1;

/**
 * Get cached tool list for a server if valid
 */
export async function getCachedToolList(
  serverName: string,
): Promise<ToolInfo[] | null> {
  if (isCacheDisabled()) {
    debug(`Cache disabled, skipping cache lookup for ${serverName}`);
    return null;
  }

  const cacheFile = getCacheFilePath(serverName);

  if (!existsSync(cacheFile)) {
    debug(`No cache found for ${serverName}`);
    return null;
  }

  try {
    const file = Bun.file(cacheFile);
    const content = await file.text();
    const cached: CachedToolList = JSON.parse(content);

    // Validate cache format version
    if (cached.version !== CACHE_VERSION) {
      debug(
        `Cache version mismatch for ${serverName} (expected ${CACHE_VERSION}, got ${cached.version})`,
      );
      return null;
    }

    // Check if cache is still valid
    const now = Date.now();
    const age = now - cached.timestamp;
    const ttl = getCacheTTLMs();

    if (age > ttl) {
      debug(
        `Cache expired for ${serverName} (age: ${Math.round(age / 1000)}s, ttl: ${Math.round(ttl / 1000)}s)`,
      );
      return null;
    }

    debug(
      `Cache hit for ${serverName} (age: ${Math.round(age / 1000)}s, ${cached.tools.length} tools)`,
    );
    return cached.tools;
  } catch (error) {
    debug(`Failed to read cache for ${serverName}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Save tool list to cache
 */
export async function setCachedToolList(
  serverName: string,
  tools: ToolInfo[],
): Promise<void> {
  if (isCacheDisabled()) {
    debug(`Cache disabled, skipping cache save for ${serverName}`);
    return;
  }

  try {
    ensureCacheDir();

    const cached: CachedToolList = {
      serverName,
      tools,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    };

    const cacheFile = getCacheFilePath(serverName);
    await Bun.write(cacheFile, JSON.stringify(cached, null, 2));

    debug(`Cached ${tools.length} tools for ${serverName}`);
  } catch (error) {
    // Don't fail if caching fails, just log
    debug(`Failed to save cache for ${serverName}: ${(error as Error).message}`);
  }
}

/**
 * Clear cache for a specific server
 */
export function clearServerCache(serverName: string): void {
  const cacheFile = getCacheFilePath(serverName);
  if (existsSync(cacheFile)) {
    rmSync(cacheFile);
    debug(`Cleared cache for ${serverName}`);
  }
}

/**
 * Clear all caches
 */
export function clearAllCaches(): void {
  const cacheDir = getCacheDir();
  if (existsSync(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
    debug('Cleared all caches');
  }
}

/**
 * Get cache stats for all servers
 */
export async function getCacheStats(): Promise<
  Array<{ server: string; age: number; toolCount: number }>
> {
  const cacheDir = getCacheDir();

  if (!existsSync(cacheDir)) {
    return [];
  }

  const stats: Array<{ server: string; age: number; toolCount: number }> = [];

  try {
    const files = await Array.fromAsync(
      new Bun.Glob('*.json').scan({ cwd: cacheDir }),
    );

    for (const file of files) {
      try {
        const cacheFile = join(cacheDir, file);
        const fileObj = Bun.file(cacheFile);
        const content = await fileObj.text();
        const cached: CachedToolList = JSON.parse(content);

        const age = Date.now() - cached.timestamp;

        stats.push({
          server: cached.serverName,
          age: Math.round(age / 1000), // age in seconds
          toolCount: cached.tools.length,
        });
      } catch (error) {
        debug(`Failed to read cache file ${file}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    debug(`Failed to list cache files: ${(error as Error).message}`);
  }

  return stats;
}
