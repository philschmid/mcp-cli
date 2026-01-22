#!/usr/bin/env bun
/**
 * Example: Generate System Instructions
 * 
 * This script generates a system prompt snippet containing all available
 * MCP servers with their instructions and tools.
 * 
 * Usage:
 *   bun run scripts/generate-system-instructions.ts
 *   bun run scripts/generate-system-instructions.ts -c /path/to/config.json
 */

import { getConnection, safeClose, getConcurrencyLimit, type McpConnection } from '../src/client.js';
import { loadConfig, listServerNames, getServerConfig, type McpServersConfig } from '../src/config.js';

interface ServerInfo {
  name: string;
  instructions?: string;
  tools: string[];
  error?: string;
}

async function fetchServerInfo(serverName: string, config: McpServersConfig): Promise<ServerInfo> {
  let connection: McpConnection | null = null;
  try {
    const serverConfig = getServerConfig(config, serverName);
    connection = await getConnection(serverName, serverConfig);

    const tools = await connection.listTools();
    const instructions = await connection.getInstructions();

    return {
      name: serverName,
      instructions,
      tools: tools.map(t => t.name),
    };
  } catch (error) {
    return {
      name: serverName,
      tools: [],
      error: (error as Error).message,
    };
  } finally {
    if (connection) {
      await safeClose(connection.close);
    }
  }
}

function formatSystemInstructions(servers: ServerInfo[]): string {
  const lines: string[] = [];

  lines.push('# Available MCP Servers');
  lines.push('');
  lines.push('You have access to the following MCP servers via `mcp-cli`:');
  lines.push('');

  for (const server of servers) {
    lines.push(`## ${server.name}`);

    if (server.error) {
      lines.push(`  (Error: ${server.error})`);
      lines.push('');
      continue;
    }

    if (server.instructions) {
      lines.push('');
      lines.push('**Instructions:**');
      lines.push(server.instructions);
    }

    lines.push('');
    lines.push('**Tools:**');
    for (const tool of server.tools) {
      lines.push(`- ${tool}`);
    }

    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Use `mcp-cli info <server> <tool>` to see tool schema before calling.');

  return lines.join('\n');
}

async function main() {
  const configPath = process.argv.includes('-c')
    ? process.argv[process.argv.indexOf('-c') + 1]
    : undefined;

  try {
    const config = await loadConfig(configPath);
    const serverNames = listServerNames(config);

    if (serverNames.length === 0) {
      console.error('No servers configured');
      process.exit(1);
    }

    console.error(`Fetching info from ${serverNames.length} servers...`);

    // Fetch all servers in parallel
    const servers = await Promise.all(
      serverNames.map(name => fetchServerInfo(name, config))
    );

    // Sort alphabetically
    servers.sort((a, b) => a.name.localeCompare(b.name));

    // Output the formatted system instructions
    console.log(formatSystemInstructions(servers));

    process.exit(0);

  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
