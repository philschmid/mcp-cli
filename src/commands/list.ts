/**
 * List command - List all servers and their tools
 */

import {
  type ToolInfo,
  type McpConnection,
  getConnection,
  debug,
  getConcurrencyLimit,
  safeClose,
} from '../client.js';
import {
  type McpServersConfig,
  getServerConfig,
  listServerNames,
  loadConfig,
} from '../config.js';
import { ErrorCode } from '../errors.js';
import { formatServerList } from '../output.js';

export interface ListOptions {
  withDescriptions: boolean;
  configPath?: string;
}

interface ServerWithTools {
  name: string;
  tools: ToolInfo[];
  instructions?: string;
  error?: string;
}

/**
 * Process items with limited concurrency, preserving order
 * Uses a worker pool pattern where each worker grabs the next item from a shared index
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
 * Fetch tools from a single server (uses daemon if enabled)
 */
async function fetchServerTools(
  serverName: string,
  config: McpServersConfig,
): Promise<ServerWithTools> {
  let connection: McpConnection | null = null;
  try {
    const serverConfig = getServerConfig(config, serverName);
    connection = await getConnection(serverName, serverConfig);

    const tools = await connection.listTools();
    const instructions = await connection.getInstructions();
    debug(`${serverName}: loaded ${tools.length} tools`);
    return { name: serverName, tools, instructions };
  } catch (error) {
    const errorMsg = (error as Error).message;
    debug(`${serverName}: connection failed - ${errorMsg}`);
    return {
      name: serverName,
      tools: [],
      error: errorMsg,
    };
  } finally {
    if (connection) {
      await safeClose(connection.close);
    }
  }
}

/**
 * Execute the list command
 */
export async function listCommand(options: ListOptions): Promise<void> {
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
    `Processing ${serverNames.length} servers with concurrency ${concurrencyLimit}`,
  );

  // Process servers in parallel with concurrency limit
  const servers = await processWithConcurrency(
    serverNames,
    (name) => fetchServerTools(name, config),
    concurrencyLimit,
  );

  // Sort by name to ensure consistent output order
  servers.sort((a, b) => a.name.localeCompare(b.name));

  // Convert errors to tool-like display for human output
  const displayServers = servers.map((s) => ({
    name: s.name,
    instructions: s.instructions,
    tools: s.error
      ? [
          {
            name: `<error: ${s.error}>`,
            description: undefined,
            inputSchema: {},
          },
        ]
      : s.tools,
  }));

  // Human-readable output
  console.log(formatServerList(displayServers, options.withDescriptions));
}
