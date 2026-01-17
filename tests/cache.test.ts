/**
 * Unit tests for cache module
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolInfo } from '../src/client';
import {
  getCacheTTLMs,
  isCacheDisabled,
  getCacheDir,
  getCachedToolList,
  setCachedToolList,
  clearServerCache,
  clearAllCaches,
  getCacheStats,
} from '../src/cache';

describe('cache', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempCacheDir: string;

  beforeEach(async () => {
    // Save original environment
    originalEnv = { ...process.env };

    // Create a temporary cache directory for testing
    tempCacheDir = await mkdtemp(join(tmpdir(), 'mcp-cache-test-'));

    // Override cache directory for testing by mocking getCacheDir
    // Note: This is a simple approach. In production, you might want to inject this as a dependency
    process.env.HOME = tempCacheDir;
  });

  afterEach(async () => {
    // Restore original environment
    process.env = originalEnv;

    // Clean up temporary directory
    await rm(tempCacheDir, { recursive: true, force: true });
  });

  describe('getCacheTTLMs', () => {
    test('returns default TTL (1 hour) when env var not set', () => {
      delete process.env.MCP_CACHE_TTL;
      expect(getCacheTTLMs()).toBe(3600 * 1000); // 1 hour in ms
    });

    test('returns custom TTL from MCP_CACHE_TTL env var', () => {
      process.env.MCP_CACHE_TTL = '7200'; // 2 hours
      expect(getCacheTTLMs()).toBe(7200 * 1000);
    });

    test('returns default TTL for invalid env var (NaN)', () => {
      process.env.MCP_CACHE_TTL = 'invalid';
      expect(getCacheTTLMs()).toBe(3600 * 1000);
    });

    test('returns default TTL for negative values', () => {
      process.env.MCP_CACHE_TTL = '-100';
      expect(getCacheTTLMs()).toBe(3600 * 1000);
    });

    test('returns default TTL for zero', () => {
      process.env.MCP_CACHE_TTL = '0';
      expect(getCacheTTLMs()).toBe(3600 * 1000);
    });

    test('handles very large TTL values', () => {
      process.env.MCP_CACHE_TTL = '86400'; // 1 day
      expect(getCacheTTLMs()).toBe(86400 * 1000);
    });
  });

  describe('isCacheDisabled', () => {
    test('returns false when MCP_NO_CACHE not set', () => {
      delete process.env.MCP_NO_CACHE;
      expect(isCacheDisabled()).toBe(false);
    });

    test('returns true when MCP_NO_CACHE is "true"', () => {
      process.env.MCP_NO_CACHE = 'true';
      expect(isCacheDisabled()).toBe(true);
    });

    test('returns true when MCP_NO_CACHE is "1"', () => {
      process.env.MCP_NO_CACHE = '1';
      expect(isCacheDisabled()).toBe(true);
    });

    test('returns true for "TRUE" (case insensitive)', () => {
      process.env.MCP_NO_CACHE = 'TRUE';
      expect(isCacheDisabled()).toBe(true);
    });

    test('returns false for other values', () => {
      process.env.MCP_NO_CACHE = 'false';
      expect(isCacheDisabled()).toBe(false);

      process.env.MCP_NO_CACHE = '0';
      expect(isCacheDisabled()).toBe(false);

      process.env.MCP_NO_CACHE = 'yes';
      expect(isCacheDisabled()).toBe(false);
    });
  });

  describe('getCacheDir', () => {
    test('returns correct cache directory path', () => {
      const expectedPath = join(homedir(), '.cache', 'mcp-cli');
      expect(getCacheDir()).toBe(expectedPath);
    });
  });

  describe('setCachedToolList and getCachedToolList', () => {
    const mockTools: ToolInfo[] = [
      {
        name: 'test-tool-1',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'test-tool-2',
        description: 'Another test tool',
        inputSchema: {
          type: 'object',
          properties: { param: { type: 'string' } },
        },
      },
    ];

    test('caches and retrieves tool list successfully', async () => {
      const serverName = 'test-server';

      await setCachedToolList(serverName, mockTools);
      const retrieved = await getCachedToolList(serverName);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.length).toBe(2);
      expect(retrieved?.[0].name).toBe('test-tool-1');
      expect(retrieved?.[1].name).toBe('test-tool-2');
    });

    test('returns null when cache does not exist', async () => {
      const result = await getCachedToolList('nonexistent-server');
      expect(result).toBeNull();
    });

    test('sanitizes server names in cache file paths', async () => {
      const weirdName = 'server/with:weird@chars!';
      await setCachedToolList(weirdName, mockTools);

      const retrieved = await getCachedToolList(weirdName);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.length).toBe(2);
    });

    test('does not cache when MCP_NO_CACHE is set', async () => {
      process.env.MCP_NO_CACHE = 'true';
      const serverName = 'no-cache-server';

      await setCachedToolList(serverName, mockTools);
      const retrieved = await getCachedToolList(serverName);

      expect(retrieved).toBeNull();
    });

    test('returns null for expired cache', async () => {
      const serverName = 'expired-server';

      // Set very short TTL
      process.env.MCP_CACHE_TTL = '0'; // This will still use default (1 hour) since 0 is invalid

      // Manually create an expired cache file
      const cacheDir = getCacheDir();
      await mkdir(cacheDir, { recursive: true });

      const cacheFilePath = join(cacheDir, `${serverName}.json`);
      const expiredCache = {
        serverName,
        tools: mockTools,
        timestamp: Date.now() - 4000 * 1000, // 4000 seconds ago (expired)
        version: 1,
      };

      await Bun.write(cacheFilePath, JSON.stringify(expiredCache));

      const retrieved = await getCachedToolList(serverName);
      expect(retrieved).toBeNull();
    });

    test('returns null for cache version mismatch', async () => {
      const serverName = 'version-mismatch';

      // Manually create a cache file with wrong version
      const cacheDir = getCacheDir();
      await mkdir(cacheDir, { recursive: true });

      const cacheFilePath = join(cacheDir, `${serverName}.json`);
      const wrongVersionCache = {
        serverName,
        tools: mockTools,
        timestamp: Date.now(),
        version: 999, // Wrong version
      };

      await Bun.write(cacheFilePath, JSON.stringify(wrongVersionCache));

      const retrieved = await getCachedToolList(serverName);
      expect(retrieved).toBeNull();
    });

    test('handles corrupted cache file gracefully', async () => {
      const serverName = 'corrupted';

      // Manually create a corrupted cache file
      const cacheDir = getCacheDir();
      await mkdir(cacheDir, { recursive: true });

      const cacheFilePath = join(cacheDir, `${serverName}.json`);
      await Bun.write(cacheFilePath, 'not valid json {]');

      const retrieved = await getCachedToolList(serverName);
      expect(retrieved).toBeNull();
    });

    test('caches empty tool list', async () => {
      const serverName = 'empty-tools';
      await setCachedToolList(serverName, []);

      const retrieved = await getCachedToolList(serverName);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.length).toBe(0);
    });

    test('cache respects custom TTL', async () => {
      const serverName = 'custom-ttl';

      // Set custom TTL of 10 seconds
      process.env.MCP_CACHE_TTL = '10';

      await setCachedToolList(serverName, mockTools);

      // Immediately retrieve - should be cached
      const retrieved1 = await getCachedToolList(serverName);
      expect(retrieved1).not.toBeNull();

      // Manually update the cache to be 11 seconds old
      const cacheDir = getCacheDir();
      const cacheFilePath = join(cacheDir, `${serverName}.json`);
      const file = Bun.file(cacheFilePath);
      const content = JSON.parse(await file.text());
      content.timestamp = Date.now() - 11 * 1000; // 11 seconds ago
      await Bun.write(cacheFilePath, JSON.stringify(content));

      // Should be expired now
      const retrieved2 = await getCachedToolList(serverName);
      expect(retrieved2).toBeNull();
    });
  });

  describe('clearServerCache', () => {
    const mockTools: ToolInfo[] = [
      {
        name: 'tool',
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    test('clears cache for specific server', async () => {
      const serverName = 'clear-me';

      await setCachedToolList(serverName, mockTools);

      // Verify cache exists
      const cacheDir = getCacheDir();
      const cacheFile = join(cacheDir, `${serverName}.json`);
      expect(existsSync(cacheFile)).toBe(true);

      // Clear cache
      clearServerCache(serverName);

      // Verify cache is gone
      expect(existsSync(cacheFile)).toBe(false);
    });

    test('does not throw when clearing non-existent cache', () => {
      expect(() => clearServerCache('nonexistent')).not.toThrow();
    });

    test('clears cache for server with sanitized name', async () => {
      const weirdName = 'server:with/special@chars';
      await setCachedToolList(weirdName, mockTools);

      clearServerCache(weirdName);

      const retrieved = await getCachedToolList(weirdName);
      expect(retrieved).toBeNull();
    });
  });

  describe('clearAllCaches', () => {
    const mockTools: ToolInfo[] = [
      {
        name: 'tool',
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    test('clears all cached servers', async () => {
      await setCachedToolList('server1', mockTools);
      await setCachedToolList('server2', mockTools);
      await setCachedToolList('server3', mockTools);

      // Verify caches exist
      const retrieved1 = await getCachedToolList('server1');
      expect(retrieved1).not.toBeNull();

      clearAllCaches();

      // Verify all caches are gone
      const retrieved2 = await getCachedToolList('server1');
      const retrieved3 = await getCachedToolList('server2');
      const retrieved4 = await getCachedToolList('server3');

      expect(retrieved2).toBeNull();
      expect(retrieved3).toBeNull();
      expect(retrieved4).toBeNull();

      // Verify directory is gone
      const cacheDir = getCacheDir();
      expect(existsSync(cacheDir)).toBe(false);
    });

    test('does not throw when cache directory does not exist', () => {
      expect(() => clearAllCaches()).not.toThrow();
    });
  });

  describe('getCacheStats', () => {
    const mockTools1: ToolInfo[] = [
      {
        name: 'tool1',
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'tool2',
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    const mockTools2: ToolInfo[] = [
      {
        name: 'tool3',
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    test('returns empty array when no caches exist', async () => {
      const stats = await getCacheStats();
      expect(stats).toEqual([]);
    });

    test('returns stats for all cached servers', async () => {
      await setCachedToolList('server-a', mockTools1);
      await setCachedToolList('server-b', mockTools2);

      const stats = await getCacheStats();

      expect(stats.length).toBe(2);

      const serverAStats = stats.find((s) => s.server === 'server-a');
      const serverBStats = stats.find((s) => s.server === 'server-b');

      expect(serverAStats).toBeDefined();
      expect(serverAStats?.toolCount).toBe(2);
      expect(serverAStats?.age).toBeGreaterThanOrEqual(0);
      expect(serverAStats?.age).toBeLessThan(10); // Should be very recent

      expect(serverBStats).toBeDefined();
      expect(serverBStats?.toolCount).toBe(1);
    });

    test('handles corrupted cache files gracefully in stats', async () => {
      await setCachedToolList('good-server', mockTools1);

      // Create a corrupted cache file
      const cacheDir = getCacheDir();
      await mkdir(cacheDir, { recursive: true });
      const corruptedFile = join(cacheDir, 'corrupted.json');
      await Bun.write(corruptedFile, 'invalid json');

      const stats = await getCacheStats();

      // Should only return stats for the good server (corrupted file should be ignored)
      const goodServerStats = stats.find((s) => s.server === 'good-server');
      expect(goodServerStats).toBeDefined();
      expect(goodServerStats?.toolCount).toBe(2);

      // Ensure corrupted file doesn't appear in stats
      const corruptedStats = stats.find((s) => s.server === 'corrupted');
      expect(corruptedStats).toBeUndefined();
    });

    test('age is calculated correctly', async () => {
      const serverName = 'age-test';
      await setCachedToolList(serverName, mockTools1);

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 1100)); // Wait 1.1 seconds

      const stats = await getCacheStats();
      const serverStats = stats.find((s) => s.server === serverName);

      expect(serverStats).toBeDefined();
      expect(serverStats?.age).toBeGreaterThanOrEqual(1); // At least 1 second
      expect(serverStats?.age).toBeLessThan(5); // But not too old
    });
  });
});
