/**
 * Enhanced error handling with actionable messages for LLM recovery
 *
 * Each error includes:
 * - What went wrong (error type)
 * - Why it failed (details)
 * - How to fix it (recovery suggestions)
 */

/**
 * Error codes matching exit codes
 */
export enum ErrorCode {
  CLIENT_ERROR = 1, // Invalid arguments, config issues
  SERVER_ERROR = 2, // Tool execution failed
  NETWORK_ERROR = 3, // Connection failed
  AUTH_ERROR = 4, // Authentication failed
}

/**
 * Structured error for CLI output
 */
export interface CliError {
  code: ErrorCode;
  type: string;
  message: string;
  details?: string;
  suggestion?: string;
}

/**
 * Format a CLI error for stderr output
 */
export function formatCliError(error: CliError): string {
  const lines: string[] = [];

  lines.push(`Error [${error.type}]: ${error.message}`);

  if (error.details) {
    lines.push(`  Details: ${error.details}`);
  }

  if (error.suggestion) {
    lines.push(`  Suggestion: ${error.suggestion}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Config Errors
// ============================================================================

export function configNotFoundError(path: string): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'CONFIG_NOT_FOUND',
    message: `Config file not found: ${path}`,
    suggestion: `Create mcp_servers.json with: { "mcpServers": { "server-name": { "command": "..." } } }`,
  };
}

export function configSearchError(): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'CONFIG_NOT_FOUND',
    message: 'No mcp_servers.json found in search paths',
    details:
      'Searched: ./mcp_servers.json, ~/.mcp_servers.json, ~/.config/mcp/mcp_servers.json',
    suggestion:
      'Create mcp_servers.json in current directory or use -c/--config to specify path',
  };
}

export function configInvalidJsonError(
  path: string,
  parseError?: string,
): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'CONFIG_INVALID_JSON',
    message: `Invalid JSON in config file: ${path}`,
    details: parseError,
    suggestion:
      'Check for syntax errors: missing commas, unquoted keys, trailing commas',
  };
}

export function configMissingFieldError(path: string): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'CONFIG_MISSING_FIELD',
    message: `Config file missing required "mcpServers" object`,
    details: `File: ${path}`,
    suggestion: 'Config must have structure: { "mcpServers": { ... } }',
  };
}

// ============================================================================
// Server Errors
// ============================================================================

export function serverNotFoundError(
  serverName: string,
  available: string[],
): CliError {
  const availableList = available.length > 0 ? available.join(', ') : '(none)';
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'SERVER_NOT_FOUND',
    message: `Server "${serverName}" not found in config`,
    details: `Available servers: ${availableList}`,
    suggestion:
      available.length > 0
        ? `Use one of: ${available.map((s) => `mcp-cli ${s}`).join(', ')}`
        : `Add server to mcp_servers.json: { "mcpServers": { "${serverName}": { ... } } }`,
  };
}

export function serverConnectionError(
  serverName: string,
  cause: string,
): CliError {
  // Detect common error patterns
  let suggestion =
    'Check server configuration and ensure the server process can start';

  if (cause.includes('ENOENT') || cause.includes('not found')) {
    suggestion =
      'Command not found. Install the MCP server: npx -y @modelcontextprotocol/server-<name>';
  } else if (cause.includes('ECONNREFUSED')) {
    suggestion =
      'Server refused connection. Check if the server is running and URL is correct';
  } else if (cause.includes('ETIMEDOUT') || cause.includes('timeout')) {
    suggestion =
      'Connection timed out. Check network connectivity and server availability';
  } else if (cause.includes('401') || cause.includes('Unauthorized')) {
    suggestion = 'Authentication required. Add Authorization header to config';
  } else if (cause.includes('403') || cause.includes('Forbidden')) {
    suggestion = 'Access forbidden. Check credentials and permissions';
  }

  return {
    code: ErrorCode.NETWORK_ERROR,
    type: 'SERVER_CONNECTION_FAILED',
    message: `Failed to connect to server "${serverName}"`,
    details: cause,
    suggestion,
  };
}

// ============================================================================
// Tool Errors
// ============================================================================

export function toolNotFoundError(
  toolName: string,
  serverName: string,
  availableTools?: string[],
): CliError {
  const toolList = availableTools?.slice(0, 5).join(', ') || '';
  const moreCount =
    availableTools && availableTools.length > 5
      ? ` (+${availableTools.length - 5} more)`
      : '';

  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'TOOL_NOT_FOUND',
    message: `Tool "${toolName}" not found in server "${serverName}"`,
    details: availableTools
      ? `Available tools: ${toolList}${moreCount}`
      : undefined,
    suggestion: `Run 'mcp-cli ${serverName}' to see all available tools`,
  };
}

export function toolExecutionError(
  toolName: string,
  serverName: string,
  cause: string,
): CliError {
  let suggestion = 'Check tool arguments match the expected schema';

  // Detect common MCP error patterns
  if (cause.includes('validation') || cause.includes('invalid_type')) {
    suggestion = `Run 'mcp-cli ${serverName}/${toolName}' to see the input schema, then fix arguments`;
  } else if (cause.includes('required')) {
    suggestion = `Missing required argument. Run 'mcp-cli ${serverName}/${toolName}' to see required fields`;
  } else if (cause.includes('permission') || cause.includes('denied')) {
    suggestion = 'Permission denied. Check file/resource permissions';
  } else if (cause.includes('not found') || cause.includes('ENOENT')) {
    suggestion = 'Resource not found. Verify the path or identifier exists';
  }

  return {
    code: ErrorCode.SERVER_ERROR,
    type: 'TOOL_EXECUTION_FAILED',
    message: `Tool "${toolName}" execution failed`,
    details: cause,
    suggestion,
  };
}

export function toolDisabledError(
  toolName: string,
  serverName: string,
): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'TOOL_DISABLED',
    message: `Tool "${toolName}" is disabled by configuration`,
    details: `Server "${serverName}" has allowedTools/disabledTools filtering configured`,
    suggestion: `Check your mcp_servers.json config. Remove "${toolName}" from disabledTools or add it to allowedTools.`,
  };
}

// ============================================================================
// Argument Errors
// ============================================================================

export function invalidTargetError(target: string): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'INVALID_TARGET',
    message: `Invalid target format: "${target}"`,
    details: 'Expected format: server/tool',
    suggestion: `Use 'mcp-cli <server>/<tool> <json>' format, e.g., 'mcp-cli github/search_repos \'{"query":"mcp"}\''`,
  };
}

export function invalidJsonArgsError(
  input: string,
  parseError?: string,
): CliError {
  // Truncate long input
  const truncated =
    input.length > 100 ? `${input.substring(0, 100)}...` : input;

  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'INVALID_JSON_ARGUMENTS',
    message: 'Invalid JSON in tool arguments',
    details: parseError ? `Parse error: ${parseError}` : `Input: ${truncated}`,
    suggestion: `Use valid JSON: '{"path": "./file.txt"}'. Run 'mcp-cli info <server> <tool>' for the schema.`,
  };
}

export function unknownOptionError(option: string): CliError {
  // Provide context-aware suggestions for common mistakes
  let suggestion: string;

  const optionLower = option.toLowerCase().replace(/^-+/, '');

  if (['server', 's'].includes(optionLower)) {
    suggestion = `Server is a positional argument. Use 'mcp-cli info <server>'`;
  } else if (['tool', 't'].includes(optionLower)) {
    suggestion = `Tool is a positional argument. Use 'mcp-cli call <server> <tool>'`;
  } else if (['args', 'arguments', 'a', 'input'].includes(optionLower)) {
    suggestion = `Pass JSON directly: 'mcp-cli call <server> <tool> '{\"key\": \"value\"}''`;
  } else if (['pattern', 'p', 'search', 'query'].includes(optionLower)) {
    suggestion = `Use 'mcp-cli grep \"*pattern*\"'`;
  } else if (['call', 'run', 'exec'].includes(optionLower)) {
    suggestion = `Use 'call' as a subcommand, not option: 'mcp-cli call <server> <tool>'`;
  } else if (['info', 'list', 'get'].includes(optionLower)) {
    suggestion = `Use 'info' as a subcommand, not option: 'mcp-cli info <server>'`;
  } else {
    suggestion =
      'Valid options: -c/--config, -j/--json, -d/--with-descriptions, -r/--raw';
  }

  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'UNKNOWN_OPTION',
    message: `Unknown option: ${option}`,
    suggestion,
  };
}

export function missingArgumentError(
  command: string,
  argument: string,
): CliError {
  // Provide command-specific format examples
  let suggestion: string;

  switch (command) {
    case 'call':
      if (argument.includes('server')) {
        suggestion = `Use 'mcp-cli call <server> <tool> '{\"key\": \"value\"}''`;
      } else {
        suggestion = `Use 'mcp-cli call <server> <tool> '{\"key\": \"value\"}''`;
      }
      break;
    case 'grep':
      suggestion = `Use 'mcp-cli grep \"*pattern*\"'`;
      break;
    case '-c/--config':
      suggestion = `Use 'mcp-cli -c /path/to/mcp_servers.json'`;
      break;
    default:
      suggestion = `Run 'mcp-cli --help' for usage examples`;
  }

  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'MISSING_ARGUMENT',
    message: `Missing required argument for ${command}: ${argument}`,
    suggestion,
  };
}

// ============================================================================
// Subcommand Errors
// ============================================================================

/**
 * Error when user provides ambiguous command like "mcp-cli server tool"
 */
export function ambiguousCommandError(
  serverName: string,
  toolName: string,
  hasArgs?: boolean,
): CliError {
  const cmd = hasArgs
    ? `mcp-cli call ${serverName} ${toolName} '<json>'`
    : `mcp-cli call ${serverName} ${toolName}`;
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'AMBIGUOUS_COMMAND',
    message: 'Ambiguous command: did you mean to call a tool or view info?',
    details: `Received: mcp-cli ${serverName} ${toolName}${hasArgs ? ' ...' : ''}`,
    suggestion: `Use '${cmd}' to execute, or 'mcp-cli info ${serverName} ${toolName}' to view schema`,
  };
}

/**
 * Error when user uses unknown subcommand with smart suggestions
 */
export function unknownSubcommandError(subcommand: string): CliError {
  // Map common aliases to correct subcommands
  const suggestions: Record<string, string> = {
    run: 'call',
    execute: 'call',
    exec: 'call',
    invoke: 'call',
    list: 'info',
    ls: 'info',
    get: 'info',
    show: 'info',
    describe: 'info',
    search: 'grep',
    find: 'grep',
    query: 'grep',
  };

  const suggested = suggestions[subcommand.toLowerCase()];
  const validCommands = 'info, grep, call';

  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'UNKNOWN_SUBCOMMAND',
    message: `Unknown subcommand: "${subcommand}"`,
    details: `Valid subcommands: ${validCommands}`,
    suggestion: suggested
      ? `Did you mean 'mcp-cli ${suggested}'?`
      : `Use 'mcp-cli --help' to see available commands`,
  };
}

/**
 * Error when too many positional arguments provided
 */
export function tooManyArgumentsError(
  command: string,
  received: number,
  max: number,
): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'TOO_MANY_ARGUMENTS',
    message: `Too many arguments for ${command}`,
    details: `Received ${received} arguments, maximum is ${max}`,
    suggestion: `Run 'mcp-cli --help' for correct usage`,
  };
}

// ============================================================================
// OAuth Errors
// ============================================================================

export function oauthConfigError(
  serverName: string,
  details: string,
): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'OAUTH_CONFIG_ERROR',
    message: `Invalid OAuth configuration for server "${serverName}"`,
    details,
    suggestion: 'Check your mcp_servers.json OAuth configuration',
  };
}

export function oauthFlowError(serverName: string, cause: string): CliError {
  let suggestion = 'Try again or check your OAuth server configuration';

  if (cause.includes('timeout')) {
    suggestion =
      'Authorization timed out. Try again and complete the browser authorization within the time limit';
  } else if (cause.includes('callback')) {
    suggestion =
      'Failed to receive OAuth callback. Ensure your firewall allows connections to localhost';
  } else if (cause.includes('token')) {
    suggestion =
      'Token exchange failed. Check your client credentials and OAuth server configuration';
  } else if (cause.includes('refresh')) {
    suggestion =
      'Token refresh failed. Your session may have expired - try re-authenticating';
  }

  return {
    code: ErrorCode.AUTH_ERROR,
    type: 'OAUTH_FLOW_ERROR',
    message: `OAuth authentication failed for server "${serverName}"`,
    details: cause,
    suggestion,
  };
}
