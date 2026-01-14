/**
 * Glob baseline search - simulates current grep behavior
 * 
 * This is intentionally simple to match the limitation we're trying to prove:
 * - Pattern like *word* matches only if server/tool_name contains word as substring
 * - Case-insensitive matching
 * - Does NOT search descriptions
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
