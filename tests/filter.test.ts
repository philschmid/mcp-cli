/**
 * Tests for tool filtering (allowedTools/disabledTools)
 */

import { describe, test, expect } from 'bun:test';
import { filterTools, isToolAllowed } from '../src/config.js';

describe('Tool Filtering', () => {
  const sampleTools = [
    { name: 'read_file', description: 'Read a file' },
    { name: 'write_file', description: 'Write a file' },
    { name: 'delete_file', description: 'Delete a file' },
    { name: 'list_directory', description: 'List directory contents' },
    { name: 'search_files', description: 'Search files' },
  ];

  describe('filterTools', () => {
    test('returns all tools when no filtering configured', () => {
      const config = { command: 'test' };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(5);
    });

    test('filters to only allowed tools (exact match)', () => {
      const config = {
        command: 'test',
        allowedTools: ['read_file', 'list_directory'],
      };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.name)).toContain('read_file');
      expect(result.map(t => t.name)).toContain('list_directory');
    });

    test('filters to only allowed tools (wildcard)', () => {
      const config = {
        command: 'test',
        allowedTools: ['*file*'],
      };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(4);
      expect(result.map(t => t.name)).toContain('read_file');
      expect(result.map(t => t.name)).toContain('write_file');
      expect(result.map(t => t.name)).toContain('delete_file');
      expect(result.map(t => t.name)).toContain('search_files');
    });

    test('filters to only allowed tools (prefix wildcard)', () => {
      const config = {
        command: 'test',
        allowedTools: ['read_*'],
      };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
    });

    test('excludes disabled tools (exact match)', () => {
      const config = {
        command: 'test',
        disabledTools: ['delete_file'],
      };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(4);
      expect(result.map(t => t.name)).not.toContain('delete_file');
    });

    test('excludes disabled tools (wildcard)', () => {
      const config = {
        command: 'test',
        disabledTools: ['*file'],
      };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.name)).toContain('list_directory');
      expect(result.map(t => t.name)).toContain('search_files');
    });

    test('disabledTools takes precedence over allowedTools', () => {
      const config = {
        command: 'test',
        allowedTools: ['*file*'],
        disabledTools: ['write_file', 'delete_file'],
      };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.name)).toContain('read_file');
      expect(result.map(t => t.name)).toContain('search_files');
      expect(result.map(t => t.name)).not.toContain('write_file');
      expect(result.map(t => t.name)).not.toContain('delete_file');
    });

    test('combines allowedTools and disabledTools', () => {
      const config = {
        command: 'test',
        allowedTools: ['read_file', 'write_file', 'delete_file'],
        disabledTools: ['delete_file'],
      };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.name)).toContain('read_file');
      expect(result.map(t => t.name)).toContain('write_file');
    });

    test('pattern matching is case-insensitive', () => {
      const config = {
        command: 'test',
        allowedTools: ['READ_FILE'],
      };
      const result = filterTools(sampleTools, config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
    });

    test('supports ? wildcard for single character', () => {
      const tools = [
        { name: 'file1' },
        { name: 'file2' },
        { name: 'file10' },
      ];
      const config = {
        command: 'test',
        allowedTools: ['file?'],
      };
      const result = filterTools(tools, config);
      expect(result).toHaveLength(2);
      expect(result.map(t => t.name)).toContain('file1');
      expect(result.map(t => t.name)).toContain('file2');
    });
  });

  describe('isToolAllowed', () => {
    test('returns true when no filtering configured', () => {
      const config = { command: 'test' };
      expect(isToolAllowed('any_tool', config)).toBe(true);
    });

    test('returns true for allowed tool', () => {
      const config = {
        command: 'test',
        allowedTools: ['read_file'],
      };
      expect(isToolAllowed('read_file', config)).toBe(true);
    });

    test('returns false for non-allowed tool', () => {
      const config = {
        command: 'test',
        allowedTools: ['read_file'],
      };
      expect(isToolAllowed('write_file', config)).toBe(false);
    });

    test('returns false for disabled tool', () => {
      const config = {
        command: 'test',
        disabledTools: ['delete_file'],
      };
      expect(isToolAllowed('delete_file', config)).toBe(false);
    });

    test('returns true for tool not in disabled list', () => {
      const config = {
        command: 'test',
        disabledTools: ['delete_file'],
      };
      expect(isToolAllowed('read_file', config)).toBe(true);
    });

    test('disabled takes precedence over allowed', () => {
      const config = {
        command: 'test',
        allowedTools: ['*file*'],
        disabledTools: ['write_file'],
      };
      expect(isToolAllowed('write_file', config)).toBe(false);
      expect(isToolAllowed('read_file', config)).toBe(true);
    });

    test('supports wildcard patterns', () => {
      const config = {
        command: 'test',
        allowedTools: ['read_*'],
      };
      expect(isToolAllowed('read_file', config)).toBe(true);
      expect(isToolAllowed('read_directory', config)).toBe(true);
      expect(isToolAllowed('write_file', config)).toBe(false);
    });
  });
});
