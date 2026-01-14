/**
 * Unit tests for hybrid search
 */

import { describe, test, expect } from 'bun:test';
import {
    tokenize,
    calculateBM25Score,
    hybridSearch,
} from '../../src/search/hybrid.js';
import { expandWithSynonyms } from '../../src/search/synonyms.js';

describe('tokenize', () => {
    test('normalizes text to lowercase', () => {
        expect(tokenize('ReadFile')).toEqual(['readfile']);
    });

    test('removes special characters', () => {
        expect(tokenize('read-file_v2.0!')).toContain('read');
        expect(tokenize('read-file_v2.0!')).toContain('file');
    });

    test('filters out short tokens', () => {
        const result = tokenize('a to the file');
        expect(result).not.toContain('a');
        expect(result).not.toContain('to');
        expect(result).toContain('the');
        expect(result).toContain('file');
    });

    test('splits on whitespace', () => {
        expect(tokenize('read the file')).toEqual(['read', 'the', 'file']);
    });
});

describe('expandWithSynonyms', () => {
    test('expands auth to login synonyms', () => {
        const expanded = expandWithSynonyms(['auth']);
        expect(expanded).toContain('auth');
        expect(expanded).toContain('login');
        expect(expanded).toContain('authenticate');
        expect(expanded).toContain('verify');
    });

    test('expands read to get synonyms', () => {
        const expanded = expandWithSynonyms(['read']);
        expect(expanded).toContain('read');
        expect(expanded).toContain('get');
        expect(expanded).toContain('fetch');
        expect(expanded).toContain('retrieve');
    });

    test('preserves original tokens', () => {
        const expanded = expandWithSynonyms(['test', 'query']);
        expect(expanded).toContain('test');
        expect(expanded).toContain('query');
    });

    test('handles multiple tokens', () => {
        const expanded = expandWithSynonyms(['read', 'file']);
        expect(expanded).toContain('read');
        expect(expanded).toContain('file');
        expect(expanded).toContain('get'); // synonym of read
        expect(expanded).toContain('document'); // synonym of file
    });
});

describe('calculateBM25Score', () => {
    test('returns higher score for exact matches', () => {
        const query = ['read', 'file'];
        const doc1 = ['read', 'file', 'from', 'disk'];
        const doc2 = ['database', 'query', 'run'];
        const avgLength = 4;

        const score1 = calculateBM25Score(query, doc1, avgLength);
        const score2 = calculateBM25Score(query, doc2, avgLength);

        expect(score1).toBeGreaterThan(score2);
        expect(score1).toBeGreaterThan(0.5);
        expect(score2).toBe(0);
    });

    test('returns 0 for no matches', () => {
        const query = ['authentication'];
        const doc = ['read', 'file', 'contents'];
        const avgLength = 3;

        const score = calculateBM25Score(query, doc, avgLength);
        expect(score).toBe(0);
    });

    test('normalizes score between 0 and 1', () => {
        const query = ['test'];
        const doc = ['test', 'test', 'test'];
        const avgLength = 3;

        const score = calculateBM25Score(query, doc, avgLength);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    test('penalizes longer documents', () => {
        const query = ['test'];
        const doc1 = ['test'];
        const doc2 = ['test', 'with', 'lots', 'of', 'other', 'words'];
        const avgLength = 3.5;

        const score1 = calculateBM25Score(query, doc1, avgLength);
        const score2 = calculateBM25Score(query, doc2, avgLength);

        // Shorter doc with same term should score higher
        expect(score1).toBeGreaterThan(score2);
    });
});

describe('hybridSearch', () => {
    const mockTools = [
        {
            server: 'filesystem',
            tool: {
                name: 'read_file',
                description: 'Read the contents of a file from disk',
                inputSchema: {},
            },
        },
        {
            server: 'filesystem',
            tool: {
                name: 'write_file',
                description: 'Write data to a file',
                inputSchema: {},
            },
        },
        {
            server: 'github',
            tool: {
                name: 'authenticate',
                description: 'Login to GitHub with credentials',
                inputSchema: {},
            },
        },
        {
            server: 'github',
            tool: {
                name: 'create_repository',
                description: 'Create a new GitHub repository',
                inputSchema: {},
            },
        },
        {
            server: 'slack',
            tool: {
                name: 'send_message',
                description: 'Send a message to a Slack channel',
                inputSchema: {},
            },
        },
    ];

    test('finds tools by name', async () => {
        const results = await hybridSearch('read file', mockTools, 0.1, 10);

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].tool.name).toBe('read_file');
    });

    test('finds tools by synonym', async () => {
        // "auth" should find "authenticate" via synonym expansion
        const results = await hybridSearch('auth', mockTools, 0.1, 10);

        expect(results.length).toBeGreaterThan(0);
        const names = results.map(r => r.tool.name);
        expect(names).toContain('authenticate');
    });

    test('ranks by relevance', async () => {
        const results = await hybridSearch('read file', mockTools, 0.1, 10);

        // read_file should rank higher than write_file
        expect(results[0].tool.name).toBe('read_file');
        expect(results[0].score).toBeGreaterThan(results[1]?.score || 0);
    });

    test('respects threshold', async () => {
        const lowThreshold = await hybridSearch('file', mockTools, 0.1, 10);
        const highThreshold = await hybridSearch('file', mockTools, 0.9, 10);

        expect(lowThreshold.length).toBeGreaterThan(highThreshold.length);
    });

    test('respects limit', async () => {
        const results = await hybridSearch('file', mockTools, 0.1, 2);

        expect(results.length).toBeLessThanOrEqual(2);
    });

    test('returns empty for no matches', async () => {
        const results = await hybridSearch('nonexistent', mockTools, 0.3, 10);

        expect(results.length).toBe(0);
    });

    test('includes matched tokens', async () => {
        const results = await hybridSearch('read file', mockTools, 0.1, 10);

        expect(results[0].matchedTokens.length).toBeGreaterThan(0);
        expect(results[0].matchedTokens).toContain('read');
    });

    test('searches description text', async () => {
        // "login" appears in description, not name
        const results = await hybridSearch('login', mockTools, 0.1, 10);

        expect(results.length).toBeGreaterThan(0);
        const names = results.map(r => r.tool.name);
        expect(names).toContain('authenticate');
    });
});
