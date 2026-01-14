/**
 * Search command - Semantic tool discovery using hybrid keyword matching
 * 
 * Provides intelligent tool search without requiring external dependencies.
 * Uses BM25 scoring and synonym expansion for semantic-ish matching.
 */

import {
    type ToolInfo,
    connectToServer,
    debug,
    getConcurrencyLimit,
    listTools,
    safeClose,
} from '../client.js';
import {
    type McpServersConfig,
    getServerConfig,
    listServerNames,
    loadConfig,
} from '../config.js';
import { ErrorCode } from '../errors.js';
import { formatJson, formatSearchResults } from '../output.js';
import { type SearchResult, hybridSearch } from '../search/hybrid.js';

export interface SearchOptions {
    query: string;              // Natural language search query
    withDescriptions: boolean;  // Include tool descriptions in output
    json: boolean;             // JSON output mode
    configPath?: string;       // Path to config file
    threshold?: number;        // Minimum relevance score (0-1)
    limit?: number;           // Maximum results to return
    showScores?: boolean;     // Show relevance scores in output
    noSynonyms?: boolean;     // Disable synonym expansion
}

/**
 * Process items with limited concurrency (same as list/grep commands)
 */
async function processWithConcurrency<T, R>(
    items: T[],
    processor: (item: T, index: number) => Promise<R>,
    maxConcurrency: number,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let currentIndex = 0;

    async function worker(): Promise<void> {
        while (currentIndex < items.length) {
            const index = currentIndex++;
            results[index] = await processor(items[index], index);
        }
    }

    const workers = Array.from(
        { length: Math.min(maxConcurrency, items.length) },
        () => worker(),
    );

    await Promise.all(workers);
    return results;
}

/**
 * Fetch tools from a single server
 */
async function fetchServerTools(
    serverName: string,
    config: McpServersConfig,
): Promise<{ server: string; tools: ToolInfo[]; error?: string }> {
    try {
        const serverConfig = getServerConfig(config, serverName);
        const { client, close } = await connectToServer(serverName, serverConfig);

        try {
            const tools = await listTools(client);
            debug(`${serverName}: loaded ${tools.length} tools`);
            return { server: serverName, tools };
        } finally {
            await safeClose(close);
        }
    } catch (error) {
        const errorMsg = (error as Error).message;
        debug(`${serverName}: connection failed - ${errorMsg}`);
        return {
            server: serverName,
            tools: [],
            error: errorMsg,
        };
    }
}

/**
 * Execute the search command
 */
export async function searchCommand(options: SearchOptions): Promise<void> {
    let config: McpServersConfig;

    try {
        config = await loadConfig(options.configPath);
    } catch (error) {
        console.error((error as Error).message);
        process.exit(ErrorCode.CLIENT_ERROR);
    }

    const serverNames = listServerNames(config);

    if (serverNames.length === 0) {
        console.error(
            'Warning: No servers configured. Add servers to mcp_servers.json',
        );
        return;
    }

    const concurrencyLimit = getConcurrencyLimit();
    debug(
        `Searching ${serverNames.length} servers for "${options.query}" (concurrency: ${concurrencyLimit})`,
    );

    // Fetch tools from all servers in parallel
    const serverResults = await processWithConcurrency(
        serverNames,
        (name) => fetchServerTools(name, config),
        concurrencyLimit,
    );

    // Flatten all tools into single array with server context
    const allTools: Array<{ server: string; tool: ToolInfo }> = [];
    const failedServers: string[] = [];

    for (const result of serverResults) {
        if (result.error) {
            failedServers.push(result.server);
        } else {
            for (const tool of result.tools) {
                allTools.push({ server: result.server, tool });
            }
        }
    }

    // Show warning for failed servers
    if (failedServers.length > 0) {
        console.error(
            `Warning: ${failedServers.length} server(s) failed to connect: ${failedServers.join(', ')}`,
        );
    }

    // Perform hybrid search
    const threshold = options.threshold ?? 0.3;
    const limit = options.limit ?? 10;

    const results: SearchResult[] = await hybridSearch(
        options.query,
        allTools,
        threshold,
        limit,
        !options.noSynonyms, // useSynonyms = !noSynonyms
    );

    // Display results
    if (results.length === 0) {
        console.log(`No tools found matching "${options.query}"`);
        return;
    }

    if (options.json) {
        // JSON output with scores
        const jsonOutput = results.map((r) => ({
            server: r.server,
            tool: r.tool.name,
            description: r.tool.description,
            score: r.score,
            matchedTokens: r.matchedTokens,
            inputSchema: r.tool.inputSchema,
        }));
        console.log(formatJson(jsonOutput));
    } else {
        // Human-readable output
        console.log(
            formatSearchResults(
                results,
                options.withDescriptions,
                options.showScores ?? false,
            ),
        );
    }
}
