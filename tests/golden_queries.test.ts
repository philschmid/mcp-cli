/**
 * Golden Query Comparison Tests
 * 
 * Proves that search improves recall under vocabulary mismatch
 * while retaining expected behavior on literal queries.
 * 
 * Comparison:
 * - Glob baseline (current grep behavior): matches tool name only
 * - Search (new feature): matches name + description with BM25
 */

import { describe, test, expect } from 'bun:test';
import { TEST_CORPUS, type TestTool } from './fixtures/tools.js';
import { GOLDEN_QUERIES } from './fixtures/golden_queries.js';
import { globSearch } from './glob_baseline.js';
import { hybridSearch, type SearchResult } from '../src/search/hybrid.js';
import type { ToolInfo } from '../src/client.js';

/**
 * Convert test tool to format expected by hybridSearch
 */
function toSearchFormat(tools: TestTool[]): Array<{ server: string; tool: ToolInfo }> {
    return tools.map(t => ({
        server: t.server,
        tool: {
            name: t.name,
            description: t.description,
            inputSchema: { type: 'object', properties: {} },
        },
    }));
}

/**
 * Extract tool IDs from search results
 */
function extractToolIds(results: SearchResult[]): string[] {
    return results.map(r => `${r.server}/${r.tool.name}`);
}

describe('Search vs Glob Baseline Comparison', () => {

    test('ticket/case mismatch - FLAGSHIP TEST', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'ticket_case_mismatch')!;

        // Baseline: glob search (current grep behavior)
        const globResults = globSearch(TEST_CORPUS, query.globPattern);

        // New: semantic search
        const searchResults = await hybridSearch(
            query.query,
            toSearchFormat(TEST_CORPUS),
            0.1, // Low threshold to catch all matches
            10,
            true, // Use synonyms
        );
        const searchToolIds = extractToolIds(searchResults);

        // PROOF: Glob fails, search succeeds
        console.log(`\nQuery: "${query.query}"`);
        console.log(`Glob pattern: "${query.globPattern}"`);
        console.log(`Glob results: ${globResults.length > 0 ? globResults.join(', ') : 'NONE (❌ MISS)'}`);
        console.log(`Search results (top 3): ${searchToolIds.slice(0, 3).join(', ')}`);

        // Assertions
        expect(globResults).not.toContain('crm/create_case'); // Glob FAILS
        expect(searchToolIds).toContain('crm/create_case'); // Search SUCCEEDS
        expect(searchToolIds.slice(0, 3)).toContain('crm/create_case'); // In top 3
    });

    test('refund/reverse_charge mismatch', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'refund_reverse_charge_mismatch')!;

        const globResults = globSearch(TEST_CORPUS, query.globPattern);
        const searchResults = await hybridSearch(query.query, toSearchFormat(TEST_CORPUS), 0.1, 10, true);
        const searchToolIds = extractToolIds(searchResults);

        console.log(`\nQuery: "${query.query}"`);
        console.log(`Glob: ${globResults.length > 0 ? globResults.join(', ') : 'NONE (❌ MISS)'}`);
        console.log(`Search: ${searchToolIds.slice(0, 3).join(', ')}`);

        expect(globResults).not.toContain('payments/reverse_charge');
        expect(searchToolIds.slice(0, 3)).toContain('payments/reverse_charge');
    });

    test('meeting/event mismatch', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'meeting_event_mismatch')!;

        const globResults = globSearch(TEST_CORPUS, query.globPattern);
        const searchResults = await hybridSearch(query.query, toSearchFormat(TEST_CORPUS), 0.1, 10, true);
        const searchToolIds = extractToolIds(searchResults);

        console.log(`\nQuery: "${query.query}"`);
        console.log(`Glob: ${globResults.length > 0 ? globResults.join(', ') : 'NONE (❌ MISS)'}`);
        console.log(`Search: ${searchToolIds.slice(0, 3).join(', ')}`);

        expect(globResults).not.toContain('calendar/create_event');
        expect(searchToolIds.slice(0, 3)).toContain('calendar/create_event');
    });

    test('credentials/auth mismatch', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'credentials_auth_mismatch')!;

        const globResults = globSearch(TEST_CORPUS, query.globPattern);
        const searchResults = await hybridSearch(query.query, toSearchFormat(TEST_CORPUS), 0.1, 10, true);
        const searchToolIds = extractToolIds(searchResults);

        console.log(`\nQuery: "${query.query}"`);
        console.log(`Glob: ${globResults.length > 0 ? globResults.join(', ') : 'NONE (❌ MISS)'}`);
        console.log(`Search: ${searchToolIds.slice(0, 3).join(', ')}`);

        expect(globResults).not.toContain('auth/verify_user');
        expect(searchToolIds.slice(0, 3)).toContain('auth/verify_user');
    });

    test('repositories/code mismatch', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'repositories_code_mismatch')!;

        const globResults = globSearch(TEST_CORPUS, query.globPattern);
        const searchResults = await hybridSearch(query.query, toSearchFormat(TEST_CORPUS), 0.1, 10, true);
        const searchToolIds = extractToolIds(searchResults);

        console.log(`\nQuery: "${query.query}"`);
        console.log(`Glob: ${globResults.length > 0 ? globResults.join(', ') : 'NONE (❌ MISS)'}`);
        console.log(`Search: ${searchToolIds.slice(0, 3).join(', ')}`);

        expect(globResults).not.toContain('github/find_code');
        expect(searchToolIds.slice(0, 3)).toContain('github/find_code');
    });

    test('ticket/issue (Jira) mismatch', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'ticket_issue_mismatch')!;

        const globResults = globSearch(TEST_CORPUS, query.globPattern);
        const searchResults = await hybridSearch(query.query, toSearchFormat(TEST_CORPUS), 0.1, 10, true);
        const searchToolIds = extractToolIds(searchResults);

        console.log(`\nQuery: "${query.query}"`);
        console.log(`Glob: ${globResults.length > 0 ? globResults.join(', ') : 'NONE (❌ MISS)'}`);
        console.log(`Search: ${searchToolIds.slice(0, 3).join(', ')}`);

        expect(globResults).not.toContain('jira/create_issue');
        expect(searchToolIds.slice(0, 3)).toContain('jira/create_issue');
    });

    // ===== CONTROL TESTS (glob should work) =====

    test('CONTROL: read_file exact match - both should succeed', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'read_file_exact')!;

        const globResults = globSearch(TEST_CORPUS, query.globPattern);
        const searchResults = await hybridSearch(query.query, toSearchFormat(TEST_CORPUS), 0.1, 10, true);
        const searchToolIds = extractToolIds(searchResults);

        console.log(`\nCONTROL Query: "${query.query}"`);
        console.log(`Glob: ${globResults.join(', ')}`);
        console.log(`Search: ${searchToolIds.slice(0, 3).join(', ')}`);

        // Both should find it
        expect(globResults).toContain('filesystem/read_file');
        expect(searchToolIds).toContain('filesystem/read_file');
    });

    test('CONTROL: create_event exact match - both should succeed', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'create_event_exact')!;

        const globResults = globSearch(TEST_CORPUS, query.globPattern);
        const searchResults = await hybridSearch(query.query, toSearchFormat(TEST_CORPUS), 0.1, 10, true);
        const searchToolIds = extractToolIds(searchResults);

        console.log(`\nCONTROL Query: "${query.query}"`);
        console.log(`Glob: ${globResults.join(', ')}`);
        console.log(`Search: ${searchToolIds.slice(0, 3).join(', ')}`);

        expect(globResults).toContain('calendar/create_event');
        expect(searchToolIds).toContain('calendar/create_event');
    });

    test('CONTROL: execute_query exact match - both should succeed', async () => {
        const query = GOLDEN_QUERIES.find(q => q.id === 'execute_query_exact')!;

        const globResults = globSearch(TEST_CORPUS, query.globPattern);
        const searchResults = await hybridSearch(query.query, toSearchFormat(TEST_CORPUS), 0.1, 10, true);
        const searchToolIds = extractToolIds(searchResults);

        console.log(`\nCONTROL Query: "${query.query}"`);
        console.log(`Glob: ${globResults.join(', ')}`);
        console.log(`Search: ${searchToolIds.slice(0, 3).join(', ')}`);

        expect(globResults).toContain('database/execute_query');
        expect(searchToolIds).toContain('database/execute_query');
    });
});

describe('Synonym Weighting Validation', () => {

    test('exact match beats synonym match', async () => {
        // Tools with exact vs synonym vocabulary
        const tools: TestTool[] = [
            {
                server: 'filesystem',
                name: 'read_file',
                description: 'Read a file from disk',
            },
            {
                server: 'docs',
                name: 'read_document',
                description: 'Read a document from storage',
            },
        ];

        // Query: "read file" (file is exact, document is synonym)
        const results = await hybridSearch(
            'read file',
            toSearchFormat(tools),
            0.1,
            10,
            true, // Synonyms enabled
        );

        const toolIds = extractToolIds(results);

        console.log(`\nSynonym weighting test: "read file"`);
        console.log(`Results: ${toolIds.join(', ')}`);
        console.log(`Scores: ${results.map(r => r.score.toFixed(2)).join(', ')}`);

        // filesystem/read_file should rank higher than docs/read_document
        // because "file" is an exact match, "document" is a synonym
        expect(toolIds[0]).toBe('filesystem/read_file');
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });
});
