/**
 * Hybrid Keyword Search Implementation
 * 
 * Provides semantic-ish search using BM25 scoring and synonym expansion.
 * No external dependencies or embeddings required.
 */

import type { ToolInfo } from '../client.js';
import { expandWithSynonyms } from './synonyms.js';

/**
 * Search result with relevance scoring
 */
export interface SearchResult {
    server: string;
    tool: ToolInfo;
    score: number;           // Relevance score 0-1
    matchedTokens: string[]; // Which tokens matched
}

/**
 * Tokenize and normalize text for searching
 * - Converts to lowercase
 * - Removes special characters
 * - Filters out tokens < 3 chars (stop words)
 * 
 * @param text - Raw text to tokenize
 * @returns Array of normalized tokens
 */
export function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ') // Remove special chars
        .split(/\s+/)                  // Split on whitespace
        .filter(t => t.length > 2);    // Remove short tokens
}

/**
 * Calculate IDF (Inverse Document Frequency) for a term
 * 
 * IDF reduces the weight of common terms that appear in many documents.
 * Formula: log((N - df + 0.5) / (df + 0.5) + 1)
 * 
 * @param numDocs - Total number of documents
 * @param numDocsWithTerm - Number of documents containing the term
 * @returns IDF score
 */
function calculateIDF(numDocs: number, numDocsWithTerm: number): number {
    return Math.log((numDocs - numDocsWithTerm + 0.5) / (numDocsWithTerm + 0.5) + 1);
}

/**
 * Calculate BM25 score for a document given query tokens
 * 
 * BM25 is a probabilistic ranking function that considers:
 * - Term frequency (TF): How often query terms appear in document
 * - Inverse document frequency (IDF): Reduces weight of common terms
 * - Document length normalization: Penalizes longer documents
 * 
 * @param queryTokens - Expanded tokens from query (with synonyms)
 * @param documentTokens - Tokens from tool name + description
 * @param avgDocLength - Average document length in corpus
 * @param allDocs - All document token arrays (for IDF calculation)
 * @returns Normalized score 0-1
 */
export function calculateBM25Score(
    queryTokens: string[],
    documentTokens: string[],
    avgDocLength: number,
    allDocs: string[][],
): number {
    const k1 = 1.5;  // Term frequency saturation parameter
    const b = 0.75;  // Length normalization parameter
    const numDocs = allDocs.length;

    let score = 0;

    for (const qToken of queryTokens) {
        // Term frequency: count of this token in current document
        const tf = documentTokens.filter(d => d === qToken).length;

        if (tf === 0) continue; // Skip if term not found

        // Calculate IDF: how many docs contain this term?
        const numDocsWithTerm = allDocs.filter(doc => doc.includes(qToken)).length;
        const idf = calculateIDF(numDocs, numDocsWithTerm);

        // Document length for normalization
        const dl = documentTokens.length;

        // BM25 formula with IDF
        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (dl / avgDocLength));

        score += idf * (numerator / denominator);
    }

    // Normalize by query length to get 0-1 range
    return queryTokens.length > 0
        ? Math.min(score / queryTokens.length, 1.0)
        : 0;
}

/**
 * Perform hybrid search on tools
 * 
 * Process:
 * 1. Tokenize query and expand with synonyms
 * 2. Tokenize all tool names/descriptions
 * 3. Calculate BM25 score (with IDF) for each tool
 * 4. Filter by threshold
 * 5. Sort by score and return top N
 * 
 * @param query - Natural language search query
 * @param tools - Array of tools to search
 * @param threshold - Minimum relevance score (0-1, default: 0.3)
 * @param limit - Maximum results to return (default: 10)
 * @param useSynonyms - Whether to expand query with synonyms (default: true)
 * @returns Ranked search results
 */
export async function hybridSearch(
    query: string,
    tools: Array<{ server: string; tool: ToolInfo }>,
    threshold = 0.3,
    limit = 10,
    useSynonyms = true,
): Promise<SearchResult[]> {
    // Tokenize query
    const queryTokens = tokenize(query);

    // Optionally expand with synonyms
    const expandedTokens = useSynonyms
        ? expandWithSynonyms(queryTokens)
        : queryTokens;

    // Tokenize all documents (tool name + description) - cached for IDF calculation
    const allDocs = tools.map(t => {
        const text = `${t.tool.name} ${t.tool.description || ''}`;
        return tokenize(text);
    });

    // Calculate average document length for BM25
    const avgLength = allDocs.reduce((sum, doc) => sum + doc.length, 0) / allDocs.length;

    // Score each tool
    const results: SearchResult[] = [];

    for (let i = 0; i < tools.length; i++) {
        const { server, tool } = tools[i];
        const docTokens = allDocs[i];

        // Calculate BM25 score with IDF
        const score = calculateBM25Score(expandedTokens, docTokens, avgLength, allDocs);

        // Only include results above threshold
        if (score >= threshold) {
            // Find which expanded tokens matched
            const matched = expandedTokens.filter(qt => docTokens.includes(qt));

            results.push({
                server,
                tool,
                score,
                matchedTokens: matched,
            });
        }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Return top N results
    return results.slice(0, limit);
}
