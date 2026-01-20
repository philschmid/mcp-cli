/**
 * MCP Client - Connection management for MCP servers
 */

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  type HttpServerConfig,
  type ServerConfig,
  type StdioServerConfig,
  debug,
  filterTools,
  getConcurrencyLimit,
  getMaxRetries,
  getRetryDelayMs,
  getTimeoutMs,
  isDaemonEnabled,
  isHttpServer,
  isToolAllowed,
} from './config.js';
import {
  type DaemonConnection,
  cleanupOrphanedDaemons,
  getDaemonConnection,
} from './daemon-client.js';
import { formatCliError, oauthFlowError } from './errors.js';
import { McpCliOAuthProvider } from './oauth.js';
import { VERSION } from './version.js';

// Re-export config utilities for convenience
export { debug, getTimeoutMs, getConcurrencyLimit };

export interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Unified connection interface that works with both daemon and direct connections
 */
export interface McpConnection {
  listTools: () => Promise<ToolInfo[]>;
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  getInstructions: () => Promise<string | undefined>;
  close: () => Promise<void>;
  isDaemon: boolean;
}

export interface ConnectOptions {
  /**
   * Allow interactive OAuth flow (browser opens, user authorizes)
   * When false, throws an error if authentication is required
   * Default: true
   */
  allowInteractiveAuth?: boolean;
}

/**
 * Error thrown when authentication is required but interactive auth is disabled
 */
export class AuthRequiredError extends Error {
  constructor(serverName: string) {
    super(
      `Server "${serverName}" requires authentication. Run 'mcp-cli ${serverName}' to authenticate.`,
    );
    this.name = 'AuthRequiredError';
  }
}

export interface ServerInfo {
  name: string;
  version?: string;
  protocolVersion?: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Retry configuration
 */
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  totalBudgetMs: number;
}

/**
 * Get retry config respecting MCP_TIMEOUT budget
 */
function getRetryConfig(): RetryConfig {
  const totalBudgetMs = getTimeoutMs();
  const maxRetries = getMaxRetries();
  const baseDelayMs = getRetryDelayMs();

  // Reserve at least 5s for the final attempt
  const retryBudgetMs = Math.max(0, totalBudgetMs - 5000);

  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs: Math.min(10000, retryBudgetMs / 2),
    totalBudgetMs,
  };
}

/**
 * Check if an error is transient and worth retrying
 * Uses error codes when available, falls back to message matching
 */
export function isTransientError(error: Error): boolean {
  // Check error code first (more reliable than message matching)
  const nodeError = error as NodeJS.ErrnoException;
  if (nodeError.code) {
    const transientCodes = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EPIPE',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'EAI_AGAIN',
    ];
    if (transientCodes.includes(nodeError.code)) {
      return true;
    }
  }

  // Fallback to message matching for errors without codes
  const message = error.message;

  // HTTP transient errors - require status code at start or with HTTP context
  // Pattern: "502", "502 Bad Gateway", "HTTP 502", "status 502", "status code 502"
  if (/^(502|503|504|429)\b/.test(message)) return true;
  if (/\b(http|status(\s+code)?)\s*(502|503|504|429)\b/i.test(message))
    return true;
  if (
    /\b(502|503|504|429)\s+(bad gateway|service unavailable|gateway timeout|too many requests)/i.test(
      message,
    )
  )
    return true;

  // Generic network terms - more specific patterns
  if (/network\s*(error|fail|unavailable|timeout)/i.test(message)) return true;
  if (/connection\s*(reset|refused|timeout)/i.test(message)) return true;
  if (/\btimeout\b/i.test(message)) return true;

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * 2 ** attempt;
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  // Add jitter (±25%)
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic for transient failures
 * Respects overall timeout budget from MCP_TIMEOUT
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string,
  config: RetryConfig = getRetryConfig(),
): Promise<T> {
  let lastError: Error | undefined;
  const startTime = Date.now();

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    // Check if we've exceeded the total timeout budget
    const elapsed = Date.now() - startTime;
    if (elapsed >= config.totalBudgetMs) {
      debug(`${operationName}: timeout budget exhausted after ${elapsed}ms`);
      break;
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      const remainingBudget = config.totalBudgetMs - (Date.now() - startTime);
      const shouldRetry =
        attempt < config.maxRetries &&
        isTransientError(lastError) &&
        remainingBudget > 1000; // At least 1s remaining

      if (shouldRetry) {
        const delay = Math.min(
          calculateDelay(attempt, config),
          remainingBudget - 1000,
        );
        debug(
          `${operationName} failed (attempt ${attempt + 1}/${config.maxRetries + 1}): ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      } else {
        throw lastError;
      }
    }
  }

  throw lastError;
}

/**
 * Safely close a connection, logging but not throwing on error
 */
export async function safeClose(close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch (err) {
    debug(`Failed to close connection: ${(err as Error).message}`);
  }
}

/**
 * Connect to an MCP server with retry logic
 * Captures stderr from stdio servers to include in error messages
 * Handles OAuth flow for HTTP servers with authentication
 */
export async function connectToServer(
  serverName: string,
  config: ServerConfig,
  options: ConnectOptions = {},
): Promise<ConnectedClient> {
  const { allowInteractiveAuth = true } = options;
  // Collect stderr for better error messages
  const stderrChunks: string[] = [];

  return withRetry(async () => {
    const client = new Client(
      {
        name: 'mcp-cli',
        version: VERSION,
      },
      {
        capabilities: {},
      },
    );

    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    let authProvider: McpCliOAuthProvider | undefined;

    if (isHttpServer(config)) {
      const result = createHttpTransport(serverName, config);
      transport = result.transport;
      authProvider = result.authProvider;

      // Configure whether interactive auth is allowed
      authProvider.setAllowInteractiveAuth(allowInteractiveAuth);
    } else {
      transport = createStdioTransport(config);

      // Capture stderr for debugging - attach BEFORE connect
      // Always stream stderr immediately so auth prompts are visible
      const stderrStream = transport.stderr;
      if (stderrStream) {
        stderrStream.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stderrChunks.push(text);
          // Always stream stderr immediately so users can see auth prompts
          process.stderr.write(`[${serverName}] ${text}`);
        });
      }
    }

    try {
      await client.connect(transport);
    } catch (error) {
      // Handle OAuth authorization required
      if (isOAuthNeeded(error as Error) && authProvider) {
        debug(`OAuth authorization required for ${serverName}`);

        // If interactive auth was blocked by the provider, throw a clear error
        if (authProvider.interactiveAuthBlocked) {
          authProvider.cleanupCallbackServer();
          throw new AuthRequiredError(serverName);
        }

        // For authorization_code flow, wait for callback
        const oauthConfig = (config as HttpServerConfig).oauth;
        if (
          !oauthConfig?.grantType ||
          oauthConfig.grantType === 'authorization_code'
        ) {
          try {
            console.error('Waiting for OAuth authorization...');

            // Wait for the callback server that was started by redirectToAuthorization
            const { code } = await authProvider.waitForCallback();
            debug('Authorization code received, completing OAuth flow');

            // Complete the OAuth flow with the authorization code
            await (transport as StreamableHTTPClientTransport).finishAuth(code);

            // Create new client and transport for authenticated connection
            // (original transport is in started state and can't be reused)
            debug('Creating new connection with authenticated tokens');
            const newClient = new Client(
              { name: 'mcp-cli', version: VERSION },
              { capabilities: {} },
            );
            const newResult = createHttpTransport(serverName, config as HttpServerConfig);
            await newClient.connect(newResult.transport);

            return {
              client: newClient,
              close: async () => {
                await newClient.close();
              },
            };
          } catch (oauthError) {
            throw new Error(
              formatCliError(
                oauthFlowError(serverName, (oauthError as Error).message),
              ),
            );
          }
        } else {
          // client_credentials should not need interactive flow
          throw new Error(
            formatCliError(
              oauthFlowError(
                serverName,
                'client_credentials authentication failed - check clientId and clientSecret',
              ),
            ),
          );
        }
      } else {
        // Enhance error with captured stderr
        const stderrOutput = stderrChunks.join('').trim();
        if (stderrOutput) {
          const err = error as Error;
          err.message = `${err.message}\n\nServer stderr:\n${stderrOutput}`;
        }
        throw error;
      }
    }

    // For successful connections, forward stderr to console
    if (!isHttpServer(config)) {
      const stderrStream = (transport as StdioClientTransport).stderr;
      if (stderrStream) {
        stderrStream.on('data', (chunk: Buffer) => {
          process.stderr.write(chunk);
        });
      }
    }

    return {
      client,
      close: async () => {
        await client.close();
      },
    };
  }, `connect to ${serverName}`);
}

/**
 * Create HTTP transport for remote servers
 * Always creates an auth provider to handle OAuth flows (server-initiated or explicit)
 */
function createHttpTransport(
  serverName: string,
  config: HttpServerConfig,
): {
  transport: StreamableHTTPClientTransport;
  authProvider: McpCliOAuthProvider;
} {
  const url = new URL(config.url);

  // Always create OAuth provider for HTTP servers to handle server-initiated OAuth
  // If explicit oauth config exists, use it; otherwise use defaults
  const oauthConfig = config.oauth || {};
  const authProvider = new McpCliOAuthProvider(
    serverName,
    config.url,
    oauthConfig,
  );
  debug(
    `OAuth provider created for ${serverName} (${oauthConfig.grantType || 'authorization_code'})`,
  );

  const transport = new StreamableHTTPClientTransport(url, {
    authProvider,
    requestInit: {
      headers: config.headers,
    },
  });

  return { transport, authProvider };
}

/**
 * Check if an error indicates OAuth authorization is needed
 */
function isOAuthNeeded(error: Error): boolean {
  // Check for UnauthorizedError from SDK
  if (error instanceof UnauthorizedError) {
    return true;
  }
  // Check for invalid_token error in message (common OAuth error response)
  if (error.message.includes('invalid_token')) {
    return true;
  }
  return false;
}

/**
 * Create stdio transport for local servers
 * Uses stderr: 'pipe' to capture server output for debugging
 */
function createStdioTransport(config: StdioServerConfig): StdioClientTransport {
  // Merge process.env with config.env, filtering out undefined values
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }
  if (config.env) {
    Object.assign(mergedEnv, config.env);
  }

  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: mergedEnv,
    cwd: config.cwd,
    stderr: 'pipe', // Capture stderr for better error messages
  });
}

/**
 * List all tools from a connected client with retry logic
 */
export async function listTools(client: Client): Promise<ToolInfo[]> {
  return withRetry(async () => {
    const result = await client.listTools();
    return result.tools.map((tool: Tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }, 'list tools');
}

/**
 * Get a specific tool by name
 */
export async function getTool(
  client: Client,
  toolName: string,
): Promise<ToolInfo | undefined> {
  const tools = await listTools(client);
  return tools.find((t) => t.name === toolName);
}

/**
 * Call a tool with arguments and retry logic
 */
export async function callTool(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return withRetry(async () => {
    const result = await client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      undefined,
      { timeout: getTimeoutMs() },
    );
    return result;
  }, `call tool ${toolName}`);
}

// ============================================================================
// Unified Connection Interface (Daemon + Direct)
// ============================================================================

/**
 * Get a unified connection to an MCP server
 *
 * If daemon mode is enabled (default), tries to use a cached daemon connection.
 * Falls back to direct connection if daemon fails or is disabled.
 *
 * @param serverName - Name of the server from config
 * @param config - Server configuration
 * @returns McpConnection with listTools, callTool, and close methods
 */
export async function getConnection(
  serverName: string,
  config: ServerConfig,
  options: ConnectOptions = {},
): Promise<McpConnection> {
  // Clean up any orphaned daemons on first call
  await cleanupOrphanedDaemons();

  // Try daemon connection if enabled
  if (isDaemonEnabled()) {
    try {
      const daemonConn = await getDaemonConnection(serverName, config);
      if (daemonConn) {
        debug(`Using daemon connection for ${serverName}`);
        return {
          async listTools(): Promise<ToolInfo[]> {
            const data = await daemonConn.listTools();
            const tools = data as ToolInfo[];
            // Apply tool filtering from config
            return filterTools(tools, config);
          },
          async callTool(
            toolName: string,
            args: Record<string, unknown>,
          ): Promise<unknown> {
            // Check if tool is allowed before calling
            if (!isToolAllowed(toolName, config)) {
              throw new Error(
                `Tool "${toolName}" is disabled by configuration`,
              );
            }
            return daemonConn.callTool(toolName, args);
          },
          async getInstructions(): Promise<string | undefined> {
            return daemonConn.getInstructions();
          },
          async close(): Promise<void> {
            await daemonConn.close();
          },
          isDaemon: true,
        };
      }
    } catch (err) {
      debug(
        `Daemon connection failed for ${serverName}: ${(err as Error).message}, falling back to direct`,
      );
    }
  }

  // Fall back to direct connection
  debug(`Using direct connection for ${serverName}`);
  const { client, close } = await connectToServer(serverName, config, options);

  return {
    async listTools(): Promise<ToolInfo[]> {
      const tools = await listTools(client);
      // Apply tool filtering from config
      return filterTools(tools, config);
    },
    async callTool(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      // Check if tool is allowed before calling
      if (!isToolAllowed(toolName, config)) {
        throw new Error(`Tool "${toolName}" is disabled by configuration`);
      }
      return callTool(client, toolName, args);
    },
    async getInstructions(): Promise<string | undefined> {
      return client.getInstructions();
    },
    async close(): Promise<void> {
      await close();
    },
    isDaemon: false,
  };
}
