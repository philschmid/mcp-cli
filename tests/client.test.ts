/**
 * Unit tests for MCP client module
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  type HttpServerConfig,
  type StdioServerConfig,
  isHttpServer,
  isStdioServer,
  getMaxRetries,
  getRetryDelayMs,
} from '../src/config';
import {
  isTransientError,
  getTimeoutMs,
  getConcurrencyLimit,
  listTools,
} from '../src/client';

describe('client', () => {
  describe('server config type guards', () => {
    test('identifies HTTP server configs', () => {
      const httpConfig: HttpServerConfig = {
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer token' },
      };

      expect(isHttpServer(httpConfig)).toBe(true);
      expect(isStdioServer(httpConfig)).toBe(false);
    });

    test('identifies stdio server configs', () => {
      const stdioConfig: StdioServerConfig = {
        command: 'node',
        args: ['./server.js'],
        env: { DEBUG: 'true' },
      };

      expect(isStdioServer(stdioConfig)).toBe(true);
      expect(isHttpServer(stdioConfig)).toBe(false);
    });

    test('handles minimal HTTP config', () => {
      const minimalHttp: HttpServerConfig = {
        url: 'https://example.com',
      };

      expect(isHttpServer(minimalHttp)).toBe(true);
    });

    test('handles minimal stdio config', () => {
      const minimalStdio: StdioServerConfig = {
        command: 'echo',
      };

      expect(isStdioServer(minimalStdio)).toBe(true);
    });
  });

  describe('isTransientError', () => {
    test('detects transient errors by code', () => {
      const errWithCode = new Error('Connection failed') as NodeJS.ErrnoException;
      errWithCode.code = 'ECONNREFUSED';
      expect(isTransientError(errWithCode)).toBe(true);

      const timeoutErr = new Error('Timeout') as NodeJS.ErrnoException;
      timeoutErr.code = 'ETIMEDOUT';
      expect(isTransientError(timeoutErr)).toBe(true);

      const resetErr = new Error('Reset') as NodeJS.ErrnoException;
      resetErr.code = 'ECONNRESET';
      expect(isTransientError(resetErr)).toBe(true);
    });

    test('detects HTTP transient errors by message', () => {
      expect(isTransientError(new Error('502 Bad Gateway'))).toBe(true);
      expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isTransientError(new Error('504 Gateway Timeout'))).toBe(true);
      expect(isTransientError(new Error('429 Too Many Requests'))).toBe(true);
    });

    test('detects network-related errors by message', () => {
      expect(isTransientError(new Error('network error occurred'))).toBe(true);
      expect(isTransientError(new Error('network timeout'))).toBe(true);
      expect(isTransientError(new Error('connection reset by peer'))).toBe(true);
      expect(isTransientError(new Error('connection refused'))).toBe(true);
      expect(isTransientError(new Error('request timeout'))).toBe(true);
    });

    test('returns false for non-transient errors', () => {
      expect(isTransientError(new Error('Invalid JSON'))).toBe(false);
      expect(isTransientError(new Error('Permission denied'))).toBe(false);
      expect(isTransientError(new Error('Not found'))).toBe(false);
    });

    test('avoids false positives with word boundaries', () => {
      // Should NOT match - these contain numbers but not as HTTP status codes
      expect(isTransientError(new Error('Error at line 502 in file'))).toBe(false);
      expect(isTransientError(new Error('Port 5029 is in use'))).toBe(false);
      // Should NOT match - network is just part of a word
      expect(isTransientError(new Error('social network tool failed'))).toBe(false);
    });
  });

  describe('getTimeoutMs', () => {
    const originalEnv = process.env.MCP_TIMEOUT;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.MCP_TIMEOUT = originalEnv;
      } else {
        delete process.env.MCP_TIMEOUT;
      }
    });

    test('returns default of 1800000ms (30 minutes)', () => {
      delete process.env.MCP_TIMEOUT;
      expect(getTimeoutMs()).toBe(1800000);
    });

    test('respects MCP_TIMEOUT env var', () => {
      process.env.MCP_TIMEOUT = '60';
      expect(getTimeoutMs()).toBe(60000);
    });

    test('ignores invalid values', () => {
      process.env.MCP_TIMEOUT = 'invalid';
      expect(getTimeoutMs()).toBe(1800000);
    });

    test('ignores negative values', () => {
      process.env.MCP_TIMEOUT = '-5';
      expect(getTimeoutMs()).toBe(1800000);
    });

    test('ignores zero', () => {
      process.env.MCP_TIMEOUT = '0';
      expect(getTimeoutMs()).toBe(1800000);
    });
  });

  describe('listTools', () => {
    test('collects all paginated tool pages', async () => {
      const client = {
        listTools: async (params?: { cursor?: string }) => {
          if (!params?.cursor) {
            return {
              tools: [
                {
                  name: 'first-tool',
                  description: 'first page',
                  inputSchema: { type: 'object' },
                },
              ],
              nextCursor: 'page-2',
            };
          }

          expect(params.cursor).toBe('page-2');
          return {
            tools: [
              {
                name: 'second-tool',
                description: 'second page',
                inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
              },
            ],
          };
        },
      };

      await expect(listTools(client as never)).resolves.toEqual([
        {
          name: 'first-tool',
          description: 'first page',
          inputSchema: { type: 'object' },
        },
        {
          name: 'second-tool',
          description: 'second page',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ]);
    });
  });

  describe('getConcurrencyLimit', () => {
    const originalEnv = process.env.MCP_CONCURRENCY;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.MCP_CONCURRENCY = originalEnv;
      } else {
        delete process.env.MCP_CONCURRENCY;
      }
    });

    test('returns default of 5', () => {
      delete process.env.MCP_CONCURRENCY;
      expect(getConcurrencyLimit()).toBe(5);
    });

    test('respects MCP_CONCURRENCY env var', () => {
      process.env.MCP_CONCURRENCY = '10';
      expect(getConcurrencyLimit()).toBe(10);
    });

    test('ignores negative values', () => {
      process.env.MCP_CONCURRENCY = '-3';
      expect(getConcurrencyLimit()).toBe(5);
    });

    test('ignores zero', () => {
      process.env.MCP_CONCURRENCY = '0';
      expect(getConcurrencyLimit()).toBe(5);
    });

    test('ignores invalid values', () => {
      process.env.MCP_CONCURRENCY = 'many';
      expect(getConcurrencyLimit()).toBe(5);
    });
  });

  describe('getMaxRetries', () => {
    const originalEnv = process.env.MCP_MAX_RETRIES;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.MCP_MAX_RETRIES = originalEnv;
      } else {
        delete process.env.MCP_MAX_RETRIES;
      }
    });

    test('returns default of 3', () => {
      delete process.env.MCP_MAX_RETRIES;
      expect(getMaxRetries()).toBe(3);
    });

    test('respects MCP_MAX_RETRIES env var', () => {
      process.env.MCP_MAX_RETRIES = '5';
      expect(getMaxRetries()).toBe(5);
    });

    test('allows zero (disable retries)', () => {
      process.env.MCP_MAX_RETRIES = '0';
      expect(getMaxRetries()).toBe(0);
    });

    test('ignores negative values', () => {
      process.env.MCP_MAX_RETRIES = '-1';
      expect(getMaxRetries()).toBe(3);
    });
  });

  describe('getRetryDelayMs', () => {
    const originalEnv = process.env.MCP_RETRY_DELAY;

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.MCP_RETRY_DELAY = originalEnv;
      } else {
        delete process.env.MCP_RETRY_DELAY;
      }
    });

    test('returns default of 1000ms', () => {
      delete process.env.MCP_RETRY_DELAY;
      expect(getRetryDelayMs()).toBe(1000);
    });

    test('respects MCP_RETRY_DELAY env var', () => {
      process.env.MCP_RETRY_DELAY = '2000';
      expect(getRetryDelayMs()).toBe(2000);
    });

    test('ignores zero', () => {
      process.env.MCP_RETRY_DELAY = '0';
      expect(getRetryDelayMs()).toBe(1000);
    });

    test('ignores negative values', () => {
      process.env.MCP_RETRY_DELAY = '-500';
      expect(getRetryDelayMs()).toBe(1000);
    });
  });

  // Note: Actually testing connectToServer requires a real MCP server
  // Those tests are in the integration test suite
});
