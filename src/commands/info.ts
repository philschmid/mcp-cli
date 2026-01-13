/**
 * Info command - Show server or tool details
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectToServer, listTools, safeClose } from '../client.js';
import {
  type McpServersConfig,
  type ServerConfig,
  findDisabledMatch,
  getServerConfig,
  loadConfig,
  loadDisabledTools,
} from '../config.js';
import {
  ErrorCode,
  formatCliError,
  serverConnectionError,
  toolDisabledError,
  toolNotFoundError,
} from '../errors.js';
import {
  formatJson,
  formatServerDetails,
  formatToolSchema,
} from '../output.js';

export interface InfoOptions {
  target: string; // "server" or "server/tool"
  json: boolean;
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

  let client: Client;
  let close: () => Promise<void> = async () => {};

  try {
    const connection = await connectToServer(serverName, serverConfig);
    client = connection.client;
    close = connection.close;
  } catch (error) {
    console.error(
      formatCliError(
        serverConnectionError(serverName, (error as Error).message),
      ),
    );
    process.exit(ErrorCode.NETWORK_ERROR);
  }

  try {
    const disabledPatterns = await loadDisabledTools();

    if (toolName) {
      const disabledMatch = findDisabledMatch(
        `${serverName}/${toolName}`,
        disabledPatterns,
      );
      if (disabledMatch) {
        console.error(
          formatCliError(
            toolDisabledError(
              `${serverName}/${toolName}`,
              disabledMatch.pattern,
              disabledMatch.source,
            ),
          ),
        );
        process.exit(ErrorCode.CLIENT_ERROR);
      }

      // Show specific tool schema
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === toolName);

      if (!tool) {
        const availableTools = tools
          .filter(
            (t) =>
              !findDisabledMatch(`${serverName}/${t.name}`, disabledPatterns),
          )
          .map((t) => t.name);
        console.error(
          formatCliError(
            toolNotFoundError(toolName, serverName, availableTools),
          ),
        );
        process.exit(ErrorCode.CLIENT_ERROR);
      }

      if (options.json) {
        console.log(
          formatJson({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }),
        );
      } else {
        console.log(formatToolSchema(serverName, tool));
      }
    } else {
      // Show server details
      const tools = await listTools(client);

      const filteredTools = tools.filter(
        (t) => !findDisabledMatch(`${serverName}/${t.name}`, disabledPatterns),
      );

      if (options.json) {
        console.log(
          formatJson({
            name: serverName,
            config: serverConfig,
            tools: filteredTools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          }),
        );
      } else {
        console.log(
          formatServerDetails(
            serverName,
            serverConfig,
            filteredTools,
            options.withDescriptions,
          ),
        );
      }
    }
  } finally {
    await safeClose(close);
  }
}
