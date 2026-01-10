/**
 * Unit tests for errors module
 */

import { describe, test, expect } from 'bun:test';
import {
  formatCliError,
  configNotFoundError,
  configSearchError,
  configInvalidJsonError,
  serverNotFoundError,
  serverConnectionError,
  toolNotFoundError,
  toolExecutionError,
  invalidTargetError,
  invalidJsonArgsError,
  unknownOptionError,
  missingArgumentError,
  ErrorCode,
} from '../src/errors';

describe('errors', () => {
  describe('formatCliError', () => {
    test('formats error with all fields', () => {
      const error = {
        code: ErrorCode.CLIENT_ERROR,
        type: 'TEST_ERROR',
        message: 'Something went wrong',
        details: 'More info here',
        suggestion: 'Try this fix',
      };

      const output = formatCliError(error);
      expect(output).toContain('Error [TEST_ERROR]');
      expect(output).toContain('Something went wrong');
      expect(output).toContain('Details: More info here');
      expect(output).toContain('Suggestion: Try this fix');
    });

    test('formats error without optional fields', () => {
      const error = {
        code: ErrorCode.CLIENT_ERROR,
        type: 'SIMPLE_ERROR',
        message: 'Basic error',
      };

      const output = formatCliError(error);
      expect(output).toContain('Error [SIMPLE_ERROR]');
      expect(output).toContain('Basic error');
      expect(output).not.toContain('Details:');
      expect(output).not.toContain('Suggestion:');
    });
  });

  describe('config errors', () => {
    test('configNotFoundError includes path and suggestion', () => {
      const error = configNotFoundError('/path/to/config.json');
      expect(error.type).toBe('CONFIG_NOT_FOUND');
      expect(error.message).toContain('/path/to/config.json');
      expect(error.suggestion).toBeDefined();
    });

    test('configSearchError lists search paths', () => {
      const error = configSearchError();
      expect(error.type).toBe('CONFIG_NOT_FOUND');
      expect(error.details).toContain('Searched:');
      expect(error.suggestion).toContain('mcp_servers.json');
    });

    test('configInvalidJsonError includes parse error', () => {
      const error = configInvalidJsonError('/config.json', 'Unexpected token');
      expect(error.type).toBe('CONFIG_INVALID_JSON');
      expect(error.details).toContain('Unexpected token');
    });
  });

  describe('server errors', () => {
    test('serverNotFoundError lists available servers', () => {
      const error = serverNotFoundError('unknown', ['github', 'filesystem']);
      expect(error.type).toBe('SERVER_NOT_FOUND');
      expect(error.message).toContain('unknown');
      expect(error.details).toContain('github');
      expect(error.details).toContain('filesystem');
      expect(error.suggestion).toContain('mcp-cli github');
    });

    test('serverNotFoundError handles empty server list', () => {
      const error = serverNotFoundError('unknown', []);
      expect(error.details).toContain('(none)');
      expect(error.suggestion).toContain('Add server to');
    });

    test('serverConnectionError detects command not found', () => {
      const error = serverConnectionError('github', 'ENOENT: command not found');
      expect(error.type).toBe('SERVER_CONNECTION_FAILED');
      expect(error.suggestion).toContain('Install');
    });

    test('serverConnectionError detects connection refused', () => {
      const error = serverConnectionError('remote', 'ECONNREFUSED');
      expect(error.suggestion).toContain('Check if the server is running');
    });

    test('serverConnectionError detects timeout', () => {
      const error = serverConnectionError('remote', 'ETIMEDOUT');
      expect(error.suggestion).toContain('network connectivity');
    });

    test('serverConnectionError detects 401 unauthorized', () => {
      const error = serverConnectionError('remote', '401 Unauthorized');
      expect(error.suggestion).toContain('Authorization header');
    });
  });

  describe('tool errors', () => {
    test('toolNotFoundError lists available tools', () => {
      const error = toolNotFoundError('unknown', 'github', ['search', 'clone']);
      expect(error.type).toBe('TOOL_NOT_FOUND');
      expect(error.message).toContain('unknown');
      expect(error.message).toContain('github');
      expect(error.details).toContain('search');
      expect(error.suggestion).toContain('mcp-cli github');
    });

    test('toolNotFoundError truncates long tool lists', () => {
      const tools = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
      const error = toolNotFoundError('x', 'server', tools);
      expect(error.details).toContain('+3 more');
    });

    test('toolExecutionError detects validation errors', () => {
      const error = toolExecutionError('search', 'github', 'validation failed');
      expect(error.type).toBe('TOOL_EXECUTION_FAILED');
      expect(error.suggestion).toContain('input schema');
    });

    test('toolExecutionError detects missing required fields', () => {
      const error = toolExecutionError('search', 'github', 'required field missing');
      expect(error.suggestion).toContain('required');
    });

    test('toolExecutionError detects permission errors', () => {
      const error = toolExecutionError('read', 'fs', 'permission denied');
      expect(error.suggestion).toContain('permissions');
    });
  });

  describe('argument errors', () => {
    test('invalidTargetError shows expected format', () => {
      const error = invalidTargetError('badformat');
      expect(error.type).toBe('INVALID_TARGET');
      expect(error.details).toContain('server/tool');
      expect(error.suggestion).toContain('mcp-cli <server>/<tool>');
    });

    test('invalidJsonArgsError truncates long input', () => {
      const longInput = 'x'.repeat(200);
      const error = invalidJsonArgsError(longInput);
      expect(error.type).toBe('INVALID_JSON_ARGUMENTS');
      expect(error.details!.length).toBeLessThan(150);
      expect(error.details).toContain('...');
    });

    test('invalidJsonArgsError includes parse error', () => {
      const error = invalidJsonArgsError('{invalid}', 'Unexpected token');
      expect(error.details).toContain('Unexpected token');
    });

    test('unknownOptionError shows help suggestion', () => {
      const error = unknownOptionError('--bad');
      expect(error.type).toBe('UNKNOWN_OPTION');
      expect(error.message).toContain('--bad');
      expect(error.suggestion).toContain('--help');
    });

    test('missingArgumentError includes command and argument', () => {
      const error = missingArgumentError('grep', 'pattern');
      expect(error.type).toBe('MISSING_ARGUMENT');
      expect(error.message).toContain('grep');
      expect(error.message).toContain('pattern');
    });
  });

  describe('error codes', () => {
    test('error codes have correct values', () => {
      expect(ErrorCode.CLIENT_ERROR).toBe(1);
      expect(ErrorCode.SERVER_ERROR).toBe(2);
      expect(ErrorCode.NETWORK_ERROR).toBe(3);
      expect(ErrorCode.AUTH_ERROR).toBe(4);
    });
  });
});
