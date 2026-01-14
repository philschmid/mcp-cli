/**
 * Grep command - Search tools by pattern
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
import { formatJson, formatGrepResults } from '../output.js';

export interface GrepOptions {
  pattern: string;
  withDescriptions: boolean;
  json: boolean;
  configPath?: string;
}

interface SearchResult {
  server: string;
  tool: ToolInfo;
}

interface ServerSearchResult {
  serverName: string;
  results: SearchResult[];
  error?: string;
}

/**
 * Convert glob pattern to regex
 * Handles: * (any chars), ? (single char), ** (globstar)
 *
 * Examples:
 * - "*file*" matches "read_file", "file_utils"
 * - "**test**" matches "test", "my_test_tool", "testing"
 * - "server/*" matches "server/tool" but not "server/sub/tool"
 * - "server/**" matches "server/tool" and "server/sub/tool"
 */
export function globToRegex(pattern: string): RegExp {
  let escaped = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*' && pattern[i + 1] === '*') {
      // ** (globstar) - match anything including slashes (zero or more chars)
      escaped += '.*';
      i += 2;
      // Skip any immediately following * (e.g., *** becomes .*)
      while (pattern[i] === '*') {
        i++;
      }
    } else if (char === '*') {
      // * - match any chars except slash (zero or more)
      escaped += '[^/]*';
      i += 1;
    } else if (char === '?') {
      // ? - match single char (not slash)
      escaped += '[^/]';
      i += 1;
    } else if ('[.+^${}()|\\]'.includes(char)) {
      // Escape special regex chars
      escaped += `\\${char}`;
      i += 1;
    } else {
      escaped += char;
      i += 1;
    }
  }

  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Process items with limited concurrency, preserving order
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

  // Start workers up to concurrency limit
  const workers = Array.from(
    { length: Math.min(maxConcurrency, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

/**
 * Search tools in a single server
 */
async function searchServerTools(
  serverName: string,
  config: McpServersConfig,
  pattern: RegExp,
): Promise<ServerSearchResult> {
  try {
    const serverConfig = getServerConfig(config, serverName);
    const { client, close } = await connectToServer(serverName, serverConfig);

    try {
      const tools = await listTools(client);
      const results: SearchResult[] = [];

      for (const tool of tools) {
        // Match against tool name, server/tool path, or description
        const fullPath = `${serverName}/${tool.name}`;
        const matchesName = pattern.test(tool.name);
        const matchesPath = pattern.test(fullPath);
        const matchesDescription =
          tool.description && pattern.test(tool.description);

        if (matchesName || matchesPath || matchesDescription) {
          results.push({ server: serverName, tool });
        }
      }

      debug(`${serverName}: found ${results.length} matches`);
      return { serverName, results };
    } finally {
      await safeClose(close);
    }
  } catch (error) {
    const errorMsg = (error as Error).message;
    debug(`${serverName}: connection failed - ${errorMsg}`);
    return { serverName, results: [], error: errorMsg };
  }
}

/**
 * Execute the grep command
 */
export async function grepCommand(options: GrepOptions): Promise<void> {
  let config: McpServersConfig;

  try {
    config = await loadConfig(options.configPath);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  const pattern = globToRegex(options.pattern);
  const serverNames = listServerNames(config);

  if (serverNames.length === 0) {
    console.error(
      'Warning: No servers configured. Add servers to mcp_servers.json',
    );
    return;
  }

  const concurrencyLimit = getConcurrencyLimit();

  debug(
    `Searching ${serverNames.length} servers for pattern "${options.pattern}" (concurrency: ${concurrencyLimit})`,
  );

  // Process servers in parallel with concurrency limit
  const serverResults = await processWithConcurrency(
    serverNames,
    (serverName) => searchServerTools(serverName, config, pattern),
    concurrencyLimit,
  );

  const allResults: SearchResult[] = [];
  const failedServers: string[] = [];

  for (const result of serverResults) {
    allResults.push(...result.results);
    if (result.error) {
      failedServers.push(result.serverName);
    }
  }

  // Show failed servers warning
  if (failedServers.length > 0) {
    console.error(
      `Warning: ${failedServers.length} server(s) failed to connect: ${failedServers.join(', ')}`,
    );
  }

  if (allResults.length === 0) {
    console.log(`No tools found matching "${options.pattern}"`);
    return;
  }

  if (options.json) {
    const jsonOutput = allResults.map((r) => ({
      server: r.server,
      tool: r.tool.name,
      description: r.tool.description,
      inputSchema: r.tool.inputSchema,
    }));
    console.log(formatJson(jsonOutput));
  } else {
    console.log(formatGrepResults(allResults, options.withDescriptions));
  }
}
