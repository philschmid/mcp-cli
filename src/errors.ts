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
    suggestion:
      'Arguments must be valid JSON. Use single quotes around JSON: \'{"key": "value"}\'',
  };
}

export function unknownOptionError(option: string): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'UNKNOWN_OPTION',
    message: `Unknown option: ${option}`,
    suggestion: "Run 'mcp-cli --help' to see available options",
  };
}

export function missingArgumentError(
  command: string,
  argument: string,
): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'MISSING_ARGUMENT',
    message: `Missing required argument for ${command}: ${argument}`,
    suggestion: `Run 'mcp-cli --help' for usage examples`,
  };
}

export function toolDisabledError(
  toolPath: string,
  pattern: string,
  source: string,
): CliError {
  return {
    code: ErrorCode.CLIENT_ERROR,
    type: 'TOOL_DISABLED',
    message: `Tool "${toolPath}" is disabled`,
    details: `Matched pattern "${pattern}" from ${source}`,
    suggestion: 'Use alternative tools or approaches to complete this task',
  };
}
