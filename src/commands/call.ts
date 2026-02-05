/**
 * Call command - Execute a tool with arguments
 *
 * Output behavior:
 * - Default: Raw text content to stdout (CLI-friendly)
 * - With --json: Full JSON response to stdout
 * - Errors always go to stderr
 */

import {
  type McpConnection,
  debug,
  getConnection,
  getTimeoutMs,
  safeClose,
} from '../client.js';
import {
  type McpServersConfig,
  type ServerConfig,
  getServerConfig,
  loadConfig,
} from '../config.js';
import {
  ErrorCode,
  formatCliError,
  invalidJsonArgsError,
  invalidTargetError,
  serverConnectionError,
  toolExecutionError,
  toolNotFoundError,
} from '../errors.js';
import { formatJson, formatToolResult } from '../output.js';

export interface CallOptions {
  target: string; // "server/tool"
  args?: string; // JSON arguments
  configPath?: string;
}

/**
 * Parse target into server and tool name
 */
function parseTarget(target: string): { server: string; tool: string } {
  const slashIndex = target.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(formatCliError(invalidTargetError(target)));
  }
  return {
    server: target.substring(0, slashIndex),
    tool: target.substring(slashIndex + 1),
  };
}

/**
 * Parse JSON arguments from string or stdin
 */
async function parseArgs(
  argsString?: string,
): Promise<Record<string, unknown>> {
  let jsonString: string;

  if (argsString) {
    jsonString = argsString;
  } else if (!process.stdin.isTTY) {
    // Read from stdin with timeout - use timer cleanup to prevent memory leak
    const timeoutMs = getTimeoutMs();
    const chunks: Buffer[] = [];
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const readPromise = (async () => {
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf-8').trim();
    })();

    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`stdin read timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      jsonString = await Promise.race([readPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } else {
    // No arguments provided
    return {};
  }

  if (!jsonString) {
    return {};
  }

  try {
    return JSON.parse(jsonString);
  } catch (e) {
    throw new Error(
      formatCliError(invalidJsonArgsError(jsonString, (e as Error).message)),
    );
  }
}

/**
 * Execute the call command
 */
export async function callCommand(options: CallOptions): Promise<void> {
  let config: McpServersConfig;

  try {
    config = await loadConfig(options.configPath);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  let serverName: string;
  let toolName: string;

  try {
    const parsed = parseTarget(options.target);
    serverName = parsed.server;
    toolName = parsed.tool;
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  let serverConfig: ServerConfig;
  try {
    serverConfig = getServerConfig(config, serverName);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  let args: Record<string, unknown>;
  try {
    args = await parseArgs(options.args);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  let connection: McpConnection;

  try {
    connection = await getConnection(serverName, serverConfig);
  } catch (error) {
    console.error(
      formatCliError(
        serverConnectionError(serverName, (error as Error).message),
      ),
    );
    process.exit(ErrorCode.NETWORK_ERROR);
  }

  try {
    const result = await connection.callTool(toolName, args);

    // Extract text content from MCP response for CLI-friendly output
    // Uses formatToolResult which extracts text from MCP content array
    console.log(formatToolResult(result));
  } catch (error) {
    // Try to get available tools for better error message
    let availableTools: string[] | undefined;
    try {
      const tools = await connection.listTools();
      availableTools = tools.map((t) => t.name);
    } catch {
      // Ignore - we'll show error without tool list
    }

    const errMsg = (error as Error).message;
    // Check if it's a "tool not found" type error
    if (errMsg.includes('not found') || errMsg.includes('unknown tool')) {
      console.error(
        formatCliError(toolNotFoundError(toolName, serverName, availableTools)),
      );
    } else {
      console.error(
        formatCliError(toolExecutionError(toolName, serverName, errMsg)),
      );
    }
    process.exit(ErrorCode.SERVER_ERROR);
  } finally {
    await safeClose(connection.close);
  }
}
