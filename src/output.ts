/**
 * Output formatting utilities
 */

import type { ToolInfo } from './client.js';
import type { ServerConfig } from './config.js';
import { isHttpServer } from './config.js';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

/**
 * Check if output should be colorized
 */
function shouldColorize(): boolean {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

/**
 * Apply color if terminal supports it
 */
function color(text: string, colorCode: string): string {
  if (!shouldColorize()) return text;
  return `${colorCode}${text}${colors.reset}`;
}

/**
 * Format server list for display
 */
export function formatServerList(
  servers: Array<{ name: string; tools: ToolInfo[] }>,
  withDescriptions: boolean,
): string {
  const lines: string[] = [];

  for (const server of servers) {
    lines.push(color(server.name, colors.bold + colors.cyan));

    for (const tool of server.tools) {
      if (withDescriptions && tool.description) {
        lines.push(`  • ${tool.name} - ${color(tool.description, colors.dim)}`);
      } else {
        lines.push(`  • ${tool.name}`);
      }
    }

    lines.push(''); // Empty line between servers
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format search results (used by grep command)
 */
export function formatGrepResults(
  results: Array<{ server: string; tool: ToolInfo }>,
  withDescriptions: boolean,
): string {
  const lines: string[] = [];

  for (const result of results) {
    const path = `${color(result.server, colors.cyan)}/${color(result.tool.name, colors.green)}`;
    if (withDescriptions && result.tool.description) {
      lines.push(`${path} - ${color(result.tool.description, colors.dim)}`);
    } else {
      lines.push(path);
    }
  }

  return lines.join('\n');
}

/**
 * Format search results with scores (used by search command)
 */
export function formatSearchResults(
  results: Array<{ server: string; tool: ToolInfo; score: number }>,
  withDescriptions: boolean,
  withScores = false,
): string {
  const lines: string[] = [];

  for (const result of results) {
    const path = `${color(result.server, colors.cyan)}/${color(result.tool.name, colors.green)}`;

    let line = path;

    // Add score if requested
    if (withScores) {
      const scoreStr = color(`[${(result.score * 100).toFixed(0)}%]`, colors.dim);
      line = `${scoreStr} ${line}`;
    }

    // Add description if requested
    if (withDescriptions && result.tool.description) {
      line += ` - ${color(result.tool.description, colors.dim)}`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Format server details
 */
export function formatServerDetails(
  serverName: string,
  config: ServerConfig,
  tools: ToolInfo[],
  withDescriptions = false,
): string {
  const lines: string[] = [];

  lines.push(
    `${color('Server:', colors.bold)} ${color(serverName, colors.cyan)}`,
  );

  if (isHttpServer(config)) {
    lines.push(`${color('Transport:', colors.bold)} HTTP`);
    lines.push(`${color('URL:', colors.bold)} ${config.url}`);
  } else {
    lines.push(`${color('Transport:', colors.bold)} stdio`);
    lines.push(
      `${color('Command:', colors.bold)} ${config.command} ${(config.args || []).join(' ')}`,
    );
  }

  lines.push('');
  lines.push(`${color(`Tools (${tools.length}):`, colors.bold)}`);

  for (const tool of tools) {
    lines.push(`  ${color(tool.name, colors.green)}`);
    if (withDescriptions && tool.description) {
      lines.push(`    ${color(tool.description, colors.dim)}`);
    }

    // Show parameters from schema
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    if (schema.properties) {
      lines.push(`    ${color('Parameters:', colors.yellow)}`);
      for (const [name, prop] of Object.entries(schema.properties)) {
        const required = schema.required?.includes(name)
          ? 'required'
          : 'optional';
        const type = prop.type || 'any';
        const desc =
          withDescriptions && prop.description ? ` - ${prop.description}` : '';
        lines.push(`      • ${name} (${type}, ${required})${desc}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format tool schema
 */
export function formatToolSchema(serverName: string, tool: ToolInfo): string {
  const lines: string[] = [];

  lines.push(
    `${color('Tool:', colors.bold)} ${color(tool.name, colors.green)}`,
  );
  lines.push(
    `${color('Server:', colors.bold)} ${color(serverName, colors.cyan)}`,
  );
  lines.push('');

  if (tool.description) {
    lines.push(`${color('Description:', colors.bold)}`);
    lines.push(`  ${tool.description}`);
    lines.push('');
  }

  lines.push(`${color('Input Schema:', colors.bold)}`);
  lines.push(JSON.stringify(tool.inputSchema, null, 2));

  return lines.join('\n');
}

/**
 * Format tool call result
 */
export function formatToolResult(result: unknown): string {
  if (typeof result === 'object' && result !== null) {
    const r = result as { content?: Array<{ type: string; text?: string }> };

    // Handle MCP tool result format
    if (r.content && Array.isArray(r.content)) {
      const textParts = r.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text);

      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }
  }

  // Fallback to JSON
  return JSON.stringify(result, null, 2);
}

/**
 * Format as JSON
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format error message
 */
export function formatError(message: string): string {
  return color(`Error: ${message}`, '\x1b[31m'); // Red
}
