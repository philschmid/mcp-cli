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
    score: number;           // Raw BM25 score (not normalized)
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
 * @returns Raw BM25 score (not normalized)
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

    // Return raw BM25 score (no capping)
    // Display normalization happens later relative to best score in results
    return score;
}

/**
 * Perform hybrid search on tools
 * 
 * Process:
 * 1. Tokenize query and expand with synonyms
 * 2. Tokenize all tool names/descriptions
 * 3. Calculate BM25 score (with IDF) for each tool, applying synonym weighting
 * 4. Filter by threshold
 * 5. Sort by score with tie-breaking and return top N
 * 
 * @param query - Natural language search query
 * @param tools - Array of tools to search
 * @param threshold - Minimum relevance score (default: 0.3)
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
    // Constant for synonym weighting
    const SYNONYM_WEIGHT = 0.7; // Synonyms contribute 70% of exact matches

    // Tokenize query
    const queryTokens = tokenize(query);

    // Expand with synonyms if enabled
    let expandedTokensArray: string[];
    let originalTokens: Set<string>;

    if (useSynonyms) {
        const { tokens, originalTokens: originals } = expandWithSynonyms(queryTokens);
        expandedTokensArray = tokens;
        originalTokens = originals;
    } else {
        expandedTokensArray = queryTokens;
        originalTokens = new Set(queryTokens);
    }

    // Tokenize tool names separately for tie-breaking
    const toolNameTokens = tools.map(t => tokenize(t.tool.name));

    // Tokenize all documents (tool name + description) - cached for IDF calculation
    const allDocs = tools.map((t, i) => {
        const descTokens = tokenize(t.tool.description || '');
        return [...toolNameTokens[i], ...descTokens];
    });

    // Calculate average document length for BM25
    const avgLength = allDocs.reduce((sum, doc) => sum + doc.length, 0) / (allDocs.length || 1);

    // Score each tool with synonym weighting
    const results: Array<SearchResult & {
        _hasNameMatch: boolean;
        _exactNameMatches: number;
        _toolNameLength: number;
    }> = [];

    for (let i = 0; i < tools.length; i++) {
        const { server, tool } = tools[i];
        const docTokens = allDocs[i];
        const nameTokens = toolNameTokens[i];

        // Calculate BM25 score with synonym weighting
        let score = 0;
        const matched: string[] = [];

        for (const qToken of expandedTokensArray) {
            const tf = docTokens.filter(d => d === qToken).length;
            if (tf === 0) continue;

            const numDocsWithTerm = allDocs.filter(doc => doc.includes(qToken)).length;
            const idf = calculateIDF(allDocs.length, numDocsWithTerm);
            const dl = docTokens.length;
            const k1 = 1.5;
            const b = 0.75;
            const numerator = tf * (k1 + 1);
            const denominator = tf + k1 * (1 - b + b * (dl / avgLength));

            // Apply synonym weight: exact matches get full score, synonyms get 70%
            const weight = originalTokens.has(qToken) ? 1.0 : SYNONYM_WEIGHT;
            score += weight * idf * (numerator / denominator);

            if (!matched.includes(qToken)) {
                matched.push(qToken);
            }
        }

        // Only include results above threshold
        if (score >= threshold) {
            // Calculate tie-breaking indicators
            const hasNameMatch = matched.some(token => nameTokens.includes(token));
            const exactNameMatches = matched.filter(token => nameTokens.includes(token)).length;

            results.push({
                server,
                tool,
                score,
                matchedTokens: matched,
                _hasNameMatch: hasNameMatch,
                _exactNameMatches: exactNameMatches,
                _toolNameLength: tool.name.length,
            });
        }
    }

    // Sort by:
    // 1. BM25 score (primary)
    // 2. Name match vs description-only (tie-breaker)
    // 3. Number of exact name matches (tie-breaker)
    // 4. Shorter name (tie-breaker)
    // 5. Alphabetical by server/tool (stable)
    results.sort((a, b) => {
        // Primary: BM25 score
        if (Math.abs(b.score - a.score) > 0.001) {
            return b.score - a.score;
        }

        // Tie-break 1: Prefer name matches over descriptiononly
        if (b._hasNameMatch !== a._hasNameMatch) {
            return b._hasNameMatch ? 1 : -1;
        }

        // Tie-break 2: More exact name matches
        if (b._exactNameMatches !== a._exactNameMatches) {
            return b._exactNameMatches - a._exactNameMatches;
        }

        // Tie-break 3: Shorter tool name (more focused)
        if (a._toolNameLength !== b._toolNameLength) {
            return a._toolNameLength - b._toolNameLength;
        }

        // Tie-break 4: Alphabetical
        const aPath = `${a.server}/${a.tool.name}`;
        const bPath = `${b.server}/${b.tool.name}`;
        return aPath.localeCompare(bPath);
    });

    // Return top N results (remove tie-breaking fields)
    return results.slice(0, limit).map(r => ({
        server: r.server,
        tool: r.tool,
        score: r.score,
        matchedTokens: r.matchedTokens,
    }));
}
