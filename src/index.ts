#!/usr/bin/env bun
/**
 * MCP-CLI - A lightweight CLI for interacting with MCP servers
 *
 * Commands:
 *   mcp-cli                         List all servers and tools
 *   mcp-cli grep <pattern>          Search tools by glob pattern
 *   mcp-cli <server>                Show server details
 *   mcp-cli <server>/<tool>         Show tool schema
 *   mcp-cli <server>/<tool> <json>  Call tool with arguments
 */

import { callCommand } from './commands/call.js';
import { grepCommand } from './commands/grep.js';
import { infoCommand } from './commands/info.js';
import { listCommand } from './commands/list.js';
import { searchCommand } from './commands/search.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_SECONDS,
} from './config.js';
import {
  ErrorCode,
  formatCliError,
  missingArgumentError,
  unknownOptionError,
} from './errors.js';
import { VERSION } from './version.js';

interface ParsedArgs {
  command: 'list' | 'grep' | 'info' | 'call' | 'search' | 'help' | 'version';
  target?: string;
  pattern?: string;
  query?: string;        // For search command
  args?: string;
  json: boolean;
  withDescriptions: boolean;
  configPath?: string;
  threshold?: number;    // For search command
  limit?: number;        // For search command
  showScores?: boolean;  // For search command
  noSynonyms?: boolean;  // For search command
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'list',
    json: false,
    withDescriptions: false,
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '-h':
      case '--help':
        result.command = 'help';
        return result;

      case '-v':
      case '--version':
        result.command = 'version';
        return result;

      case '-j':
      case '--json':
        result.json = true;
        break;

      case '-d':
      case '--with-descriptions':
        result.withDescriptions = true;
        break;

      case '-c':
      case '--config':
        result.configPath = args[++i];
        break;

      case '--threshold':
        result.threshold = Number.parseFloat(args[++i]);
        break;

      case '--limit':
        result.limit = Number.parseInt(args[++i]);
        break;

      case '--score':
      case '--scores':
        result.showScores = true;
        break;

      case '--no-synonyms':
        result.noSynonyms = true;
        break;

      default:
        // Single '-' is allowed (stdin indicator), but other dash-prefixed args are options
        if (arg.startsWith('-') && arg !== '-') {
          console.error(formatCliError(unknownOptionError(arg)));
          process.exit(ErrorCode.CLIENT_ERROR);
        }
        positional.push(arg);
    }
  }

  // Determine command from positional arguments
  if (positional.length === 0) {
    result.command = 'list';
  } else if (positional[0] === 'grep') {
    result.command = 'grep';
    result.pattern = positional[1];
    if (!result.pattern) {
      console.error(formatCliError(missingArgumentError('grep', 'pattern')));
      process.exit(ErrorCode.CLIENT_ERROR);
    }
  } else if (positional[0] === 'search') {
    result.command = 'search';
    result.query = positional.slice(1).join(' ');
    if (!result.query) {
      console.error(formatCliError(missingArgumentError('search', 'query')));
      process.exit(ErrorCode.CLIENT_ERROR);
    }
  } else if (positional[0].includes('/')) {
    // server/tool format
    result.target = positional[0];
    if (positional.length > 1) {
      result.command = 'call';
      // Support '-' to indicate stdin (Unix convention)
      const argsValue = positional.slice(1).join(' ');
      result.args = argsValue === '-' ? undefined : argsValue;
    } else {
      result.command = 'info';
    }
  } else {
    // Just server name
    result.command = 'info';
    result.target = positional[0];
  }

  return result;
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
mcp-cli v${VERSION} - A lightweight CLI for MCP servers

Usage:
  mcp-cli [options]                           List all servers and tools
  mcp-cli [options] grep <pattern>            Search tools by glob pattern
  mcp-cli [options] search <query>            Semantic search for tools
  mcp-cli [options] <server>                  Show server tools and parameters
  mcp-cli [options] <server>/<tool>           Show tool schema and description
  mcp-cli [options> <server>/<tool> <json>    Call tool with arguments

Options:
  -h, --help               Show this help message
  -v, --version            Show version number
  -j, --json               Output as JSON (for scripting)
  -d, --with-descriptions  Include tool descriptions
  -c, --config <path>      Path to mcp_servers.json config file
  --threshold <number>     Minimum relevance score for search (0-1, default: 0.3)
  --limit <number>         Maximum search results (default: 10)
  --score                  Show relevance scores in search results
  --no-synonyms            Disable synonym expansion in search

Output:
  stdout                   Tool results and data (default: text, --json for JSON)
  stderr                   Errors and diagnostics

Environment Variables:
  MCP_CONFIG_PATH          Path to config file (alternative to -c)
  MCP_DEBUG                Enable debug output
  MCP_TIMEOUT              Request timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  MCP_CONCURRENCY          Max parallel server connections (default: ${DEFAULT_CONCURRENCY})
  MCP_MAX_RETRIES          Max retry attempts for transient errors (default: ${DEFAULT_MAX_RETRIES})
  MCP_RETRY_DELAY          Base retry delay in milliseconds (default: ${DEFAULT_RETRY_DELAY_MS})
  MCP_STRICT_ENV           Set to "false" to warn on missing env vars (default: true)

Examples:
  mcp-cli                                    # List all servers
  mcp-cli -d                                 # List with descriptions
  mcp-cli grep "*file*"                      # Search for file tools (glob pattern)
  mcp-cli search "authenticate user"         # Search tools semantically
  mcp-cli search "read file" --score         # Show relevance scores
  mcp-cli filesystem                         # Show server tools
  mcp-cli filesystem/read_file               # Show tool schema
  mcp-cli filesystem/read_file '{"path":"./README.md"}'  # Call tool
  echo '{"path":"./file"}' | mcp-cli server/tool -       # Read JSON from stdin

Config File:
  The CLI looks for mcp_servers.json in:
    1. Path specified by MCP_CONFIG_PATH or -c/--config
    2. ./mcp_servers.json (current directory)
    3. ~/.mcp_servers.json
    4. ~/.config/mcp/mcp_servers.json
`);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'help':
      printHelp();
      break;

    case 'version':
      console.log(`mcp-cli v${VERSION}`);
      break;

    case 'list':
      await listCommand({
        withDescriptions: args.withDescriptions,
        json: args.json,
        configPath: args.configPath,
      });
      break;

    case 'grep':
      await grepCommand({
        pattern: args.pattern ?? '',
        withDescriptions: args.withDescriptions,
        json: args.json,
        configPath: args.configPath,
      });
      break;

    case 'info':
      await infoCommand({
        target: args.target ?? '',
        json: args.json,
        withDescriptions: args.withDescriptions,
        configPath: args.configPath,
      });
      break;

    case 'call':
      await callCommand({
        target: args.target ?? '',
        args: args.args,
        json: args.json,
        configPath: args.configPath,
      });
      break;

    case 'search':
      await searchCommand({
        query: args.query ?? '',
        withDescriptions: args.withDescriptions,
        json: args.json,
        configPath: args.configPath,
        threshold: args.threshold,
        limit: args.limit,
        showScores: args.showScores,
        noSynonyms: args.noSynonyms,
      });
      break;
  }
}

// Handle graceful shutdown on SIGINT/SIGTERM
process.on('SIGINT', () => {
  process.exit(130); // 128 + SIGINT(2)
});
process.on('SIGTERM', () => {
  process.exit(143); // 128 + SIGTERM(15)
});

// Run
main().catch((error) => {
  // Error message already formatted by command handlers
  console.error(error.message);
  process.exit(ErrorCode.CLIENT_ERROR);
});
