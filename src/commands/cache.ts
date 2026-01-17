/**
 * Cache command - Manage tool list cache
 */

import {
  clearAllCaches,
  clearServerCache,
  getCacheStats,
  getCacheTTLMs,
  isCacheDisabled,
} from '../cache.js';
import { type McpServersConfig, listServerNames, loadConfig } from '../config.js';
import { ErrorCode } from '../errors.js';

export interface CacheOptions {
  action: 'clear' | 'stats';
  server?: string;
  configPath?: string;
}

/**
 * Format seconds into human-readable time
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Execute the cache command
 */
export async function cacheCommand(options: CacheOptions): Promise<void> {
  if (isCacheDisabled()) {
    console.error('Cache is disabled (MCP_NO_CACHE=true)');
    return;
  }

  if (options.action === 'clear') {
    if (options.server) {
      // Validate server exists in config
      try {
        const config = await loadConfig(options.configPath);
        const serverNames = listServerNames(config);

        if (!serverNames.includes(options.server)) {
          console.error(
            `Unknown server: ${options.server}. Available: ${serverNames.join(', ')}`,
          );
          process.exit(ErrorCode.CLIENT_ERROR);
        }

        clearServerCache(options.server);
        console.log(`Cleared cache for server: ${options.server}`);
      } catch (error) {
        console.error((error as Error).message);
        process.exit(ErrorCode.CLIENT_ERROR);
      }
    } else {
      clearAllCaches();
      console.log('Cleared all caches');
    }
  } else if (options.action === 'stats') {
    const stats = await getCacheStats();

    if (stats.length === 0) {
      console.log('No cached tool lists');
      return;
    }

    const ttl = Math.round(getCacheTTLMs() / 1000);
    console.log(`Cache TTL: ${formatDuration(ttl)}\n`);
    console.log('Cached servers:');

    // Sort by server name
    stats.sort((a, b) => a.server.localeCompare(b.server));

    const maxServerLen = Math.max(...stats.map((s) => s.server.length));

    for (const stat of stats) {
      const serverPadded = stat.server.padEnd(maxServerLen);
      const age = formatDuration(stat.age);
      const remaining = ttl - stat.age;
      const validity = remaining > 0 ? `valid for ${formatDuration(remaining)}` : 'expired';

      console.log(
        `  ${serverPadded}  ${stat.toolCount} tools  (age: ${age}, ${validity})`,
      );
    }
  }
}
