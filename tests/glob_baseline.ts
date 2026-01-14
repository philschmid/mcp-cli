/**
 * Glob baseline search - simulates current grep behavior
 * 
 * BASELINE DEFINITION:
 * This intentionally models grep behavior as simple substring matching on tool ID only.
 * 
 * - Pattern: *word* → extracts "word"
 * - Matches: case-insensitive substring match on "server/tool_name"
 * - Does NOT search: tool descriptions
 * - Real glob has edge cases, but this models the common use case
 * 
 * This baseline proves where current grep limitations exist (vocabulary mismatch).
 */

import type { TestTool } from './fixtures/tools.js';

/**
 * Parse glob pattern to extract search word
 * Handles patterns like: *word*, *word, word*
 */
export function parseGlobPattern(pattern: string): string {
    return pattern.replace(/\*/g, '').toLowerCase();
}

/**
 * Simulate grep behavior: match pattern against tool ID only
 * 
 * @param tools - List of tools to search
 * @param globPattern - Glob pattern (e.g., "*ticket*")
 * @returns Array of matching tool IDs (server/name)
 */
export function globSearch(tools: TestTool[], globPattern: string): string[] {
    const searchWord = parseGlobPattern(globPattern);
    const results: string[] = [];

    for (const tool of tools) {
        const toolId = `${tool.server}/${tool.name}`.toLowerCase();

        // Match only on tool ID (server/name), NOT description
        if (toolId.includes(searchWord)) {
            results.push(`${tool.server}/${tool.name}`);
        }
    }

    return results;
}
