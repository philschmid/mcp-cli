/**
 * Info command - Show server or tool details
 */

import { getConnection, safeClose, type McpConnection } from '../client.js';
import {
  type McpServersConfig,
  type ServerConfig,
  getServerConfig,
  loadConfig,
} from '../config.js';
import {
  ErrorCode,
  formatCliError,
  serverConnectionError,
  toolNotFoundError,
} from '../errors.js';
import {
  formatServerDetails,
  formatToolSchema,
} from '../output.js';

export interface InfoOptions {
  target: string; // "server" or "server/tool"
  withDescriptions: boolean;
  configPath?: string;
}

/**
 * Parse target into server and optional tool name
 */
function parseTarget(target: string): { server: string; tool?: string } {
  const parts = target.split('/');
  if (parts.length === 1) {
    return { server: parts[0] };
  }
  return { server: parts[0], tool: parts.slice(1).join('/') };
}

/**
 * Execute the info command
 */
export async function infoCommand(options: InfoOptions): Promise<void> {
  let config: McpServersConfig;

  try {
    config = await loadConfig(options.configPath);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  const { server: serverName, tool: toolName } = parseTarget(options.target);

  let serverConfig: ServerConfig;
  try {
    serverConfig = getServerConfig(config, serverName);
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
    if (toolName) {
      // Show specific tool schema
      const tools = await connection.listTools();
      const tool = tools.find((t) => t.name === toolName);

      if (!tool) {
        const availableTools = tools.map((t) => t.name);
        console.error(
          formatCliError(
            toolNotFoundError(toolName, serverName, availableTools),
          ),
        );
        process.exit(ErrorCode.CLIENT_ERROR);
      }

      // Human-readable output
      console.log(formatToolSchema(serverName, tool));
    } else {
      // Show server details
      const tools = await connection.listTools();
      const instructions = await connection.getInstructions();

      // Human-readable output
      console.log(
        formatServerDetails(
          serverName,
          serverConfig,
          tools,
          options.withDescriptions,
          instructions,
        ),
      );
    }
  } finally {
    await safeClose(connection.close);
  }
}

