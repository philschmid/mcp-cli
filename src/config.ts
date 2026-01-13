/**
 * MCP-CLI Configuration Types and Loader
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ErrorCode,
  configInvalidJsonError,
  configMissingFieldError,
  configNotFoundError,
  configSearchError,
  formatCliError,
  serverNotFoundError,
} from './errors.js';

/**
 * stdio server configuration (local process)
 */
export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * HTTP server configuration (remote)
 */
export interface HttpServerConfig {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpServersConfig {
  mcpServers: Record<string, ServerConfig>;
}

/**
 * Check if a server config is HTTP-based
 */
export function isHttpServer(config: ServerConfig): config is HttpServerConfig {
  return 'url' in config;
}

/**
 * Check if a server config is stdio-based
 */
export function isStdioServer(
  config: ServerConfig,
): config is StdioServerConfig {
  return 'command' in config;
}

// ============================================================================
// Environment Variables & Runtime Configuration
// ============================================================================

/**
 * Default configuration values - centralized to avoid inline magic numbers
 */
export const DEFAULT_TIMEOUT_SECONDS = 1800; // 30 minutes
export const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_SECONDS * 1000;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000; // 1 second base delay

/**
 * Debug logging utility - only logs when MCP_DEBUG is set
 */
export function debug(message: string): void {
  if (process.env.MCP_DEBUG) {
    console.error(`[mcp-cli] ${message}`);
  }
}

/**
 * Get configured timeout in milliseconds
 * @env MCP_TIMEOUT - timeout in seconds (default: 1800 = 30 minutes)
 */
export function getTimeoutMs(): number {
  const envTimeout = process.env.MCP_TIMEOUT;
  if (envTimeout) {
    const seconds = Number.parseInt(envTimeout, 10);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Get concurrency limit for parallel server connections
 * @env MCP_CONCURRENCY - max parallel connections (default: 5)
 */
export function getConcurrencyLimit(): number {
  const envConcurrency = process.env.MCP_CONCURRENCY;
  if (envConcurrency) {
    const limit = Number.parseInt(envConcurrency, 10);
    if (!Number.isNaN(limit) && limit > 0) {
      return limit;
    }
  }
  return DEFAULT_CONCURRENCY;
}

/**
 * Get max retry attempts for transient failures
 * @env MCP_MAX_RETRIES - max retry attempts (default: 3, use 0 to disable retries)
 */
export function getMaxRetries(): number {
  const envRetries = process.env.MCP_MAX_RETRIES;
  if (envRetries) {
    const retries = Number.parseInt(envRetries, 10);
    if (!Number.isNaN(retries) && retries >= 0) {
      return retries;
    }
  }
  return DEFAULT_MAX_RETRIES;
}

/**
 * Get base delay for retry backoff in milliseconds
 * @env MCP_RETRY_DELAY - base delay in milliseconds (default: 1000)
 */
export function getRetryDelayMs(): number {
  const envDelay = process.env.MCP_RETRY_DELAY;
  if (envDelay) {
    const delay = Number.parseInt(envDelay, 10);
    if (!Number.isNaN(delay) && delay > 0) {
      return delay;
    }
  }
  return DEFAULT_RETRY_DELAY_MS;
}

/**
 * Check if strict environment variable mode is enabled
 * @env MCP_STRICT_ENV - set to "false" to warn instead of error (default: true)
 */
function isStrictEnvMode(): boolean {
  const value = process.env.MCP_STRICT_ENV?.toLowerCase();
  return value !== 'false' && value !== '0';
}

/**
 * Substitute environment variables in a string
 * Supports ${VAR_NAME} syntax
 *
 * By default (strict mode), throws an error when referenced env var is not set.
 * Set MCP_STRICT_ENV=false to warn instead of error.
 */
function substituteEnvVars(value: string): string {
  const missingVars: string[] = [];

  const result = value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      missingVars.push(varName);
      return '';
    }
    return envValue;
  });

  if (missingVars.length > 0) {
    const varList = missingVars.map((v) => `\${${v}}`).join(', ');
    const message = `Missing environment variable${missingVars.length > 1 ? 's' : ''}: ${varList}`;

    if (isStrictEnvMode()) {
      throw new Error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'MISSING_ENV_VAR',
          message: message,
          details: 'Referenced in config but not set in environment',
          suggestion: `Set the variable(s) before running: export ${missingVars[0]}="value" or set MCP_STRICT_ENV=false to use empty values`,
        }),
      );
    }
    // Non-strict mode: warn but continue
    console.error(`[mcp-cli] Warning: ${message}`);
  }

  return result;
}

/**
 * Recursively substitute environment variables in an object
 */
function substituteEnvVarsInObject<T>(obj: T): T {
  if (typeof obj === 'string') {
    return substituteEnvVars(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVarsInObject) as T;
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsInObject(value);
    }
    return result as T;
  }
  return obj;
}

/**
 * Get default config search paths
 */
function getDefaultConfigPaths(): string[] {
  const paths: string[] = [];
  const home = homedir();

  // Current directory
  paths.push(resolve('./mcp_servers.json'));

  // Home directory variants
  paths.push(join(home, '.mcp_servers.json'));
  paths.push(join(home, '.config', 'mcp', 'mcp_servers.json'));

  return paths;
}

/**
 * Load and parse MCP servers configuration
 */
export async function loadConfig(
  explicitPath?: string,
): Promise<McpServersConfig> {
  let configPath: string | undefined;

  // Check explicit path from argument or environment
  if (explicitPath) {
    configPath = resolve(explicitPath);
  } else if (process.env.MCP_CONFIG_PATH) {
    configPath = resolve(process.env.MCP_CONFIG_PATH);
  }

  // If explicit path provided, it must exist
  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(formatCliError(configNotFoundError(configPath)));
    }
  } else {
    // Search default paths
    const searchPaths = getDefaultConfigPaths();
    for (const path of searchPaths) {
      if (existsSync(path)) {
        configPath = path;
        break;
      }
    }

    if (!configPath) {
      throw new Error(formatCliError(configSearchError()));
    }
  }

  // Read and parse config
  const file = Bun.file(configPath);
  const content = await file.text();

  let config: McpServersConfig;
  try {
    config = JSON.parse(content);
  } catch (e) {
    throw new Error(
      formatCliError(configInvalidJsonError(configPath, (e as Error).message)),
    );
  }

  // Validate structure
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    throw new Error(formatCliError(configMissingFieldError(configPath)));
  }

  // Warn if no servers are configured
  if (Object.keys(config.mcpServers).length === 0) {
    console.error(
      '[mcp-cli] Warning: No servers configured in mcpServers. Add server configurations to use MCP tools.',
    );
  }

  // Validate individual server configs
  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    if (!serverConfig || typeof serverConfig !== 'object') {
      throw new Error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'CONFIG_INVALID_SERVER',
          message: `Invalid server configuration for "${serverName}"`,
          details: 'Server config must be an object',
          suggestion: `Use { "command": "..." } for stdio or { "url": "..." } for HTTP`,
        }),
      );
    }

    const hasCommand = 'command' in serverConfig;
    const hasUrl = 'url' in serverConfig;

    if (!hasCommand && !hasUrl) {
      throw new Error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'CONFIG_INVALID_SERVER',
          message: `Server "${serverName}" missing required field`,
          details: `Must have either "command" (for stdio) or "url" (for HTTP)`,
          suggestion: `Add "command": "npx ..." for local servers or "url": "https://..." for remote servers`,
        }),
      );
    }

    if (hasCommand && hasUrl) {
      throw new Error(
        formatCliError({
          code: ErrorCode.CLIENT_ERROR,
          type: 'CONFIG_INVALID_SERVER',
          message: `Server "${serverName}" has both "command" and "url"`,
          details:
            'A server must be either stdio (command) or HTTP (url), not both',
          suggestion: `Remove one of "command" or "url"`,
        }),
      );
    }
  }

  // Substitute environment variables
  config = substituteEnvVarsInObject(config);

  return config;
}

/**
 * Get a specific server config by name
 */
export function getServerConfig(
  config: McpServersConfig,
  serverName: string,
): ServerConfig {
  const server = config.mcpServers[serverName];
  if (!server) {
    const available = Object.keys(config.mcpServers);
    throw new Error(formatCliError(serverNotFoundError(serverName, available)));
  }
  return server;
}

/**
 * List all server names
 */
export function listServerNames(config: McpServersConfig): string[] {
  return Object.keys(config.mcpServers);
}

export interface DisabledToolsMatch {
  pattern: string;
  source: string;
}

function globMatch(pattern: string, str: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return regex.test(str);
}

function getDisabledToolsPaths(): string[] {
  const home = homedir();
  return [
    join(home, '.config', 'mcp', 'disabled_tools'),
    join(home, '.mcp_disabled_tools'),
    resolve('./mcp_disabled_tools'),
  ];
}

function parseDisabledToolsFile(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export async function loadDisabledTools(): Promise<Map<string, string>> {
  const patterns = new Map<string, string>();

  for (const path of getDisabledToolsPaths()) {
    if (existsSync(path)) {
      const content = await Bun.file(path).text();
      for (const pattern of parseDisabledToolsFile(content)) {
        patterns.set(pattern, path);
      }
      debug(`Loaded ${patterns.size} disabled tool patterns from ${path}`);
    }
  }

  const envPatterns = process.env.MCP_DISABLED_TOOLS;
  if (envPatterns) {
    for (const pattern of envPatterns
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)) {
      patterns.set(pattern, 'MCP_DISABLED_TOOLS');
    }
  }

  return patterns;
}

export function findDisabledMatch(
  toolPath: string,
  patterns: Map<string, string>,
): DisabledToolsMatch | undefined {
  for (const [pattern, source] of patterns) {
    if (globMatch(pattern, toolPath)) {
      return { pattern, source };
    }
  }
  return undefined;
}
