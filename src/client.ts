/**
 * MCP Client - Connection management for MCP servers
 */

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { oauthCallbackServer } from './auth/callback-server.js';
import {
  CliOAuthProvider,
  ensureCallbackServerRunning,
  stopCallbackServer,
} from './auth/oauth-provider.js';
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
 * Supports OAuth authentication for HTTP servers
 */
export async function connectToServer(
  serverName: string,
  config: ServerConfig,
): Promise<ConnectedClient> {
  // Collect stderr for better error messages
  const stderrChunks: string[] = [];

  return withRetry(async () => {
    // For HTTP servers with OAuth, we may need to retry after auth
    if (isHttpServer(config)) {
      return await connectHttpServer(serverName, config);
    }

    // For stdio servers, standard connection
    const client = new Client(
      {
        name: 'mcp-cli',
        version: VERSION,
      },
      {
        capabilities: {},
      },
    );

    const transport = createStdioTransport(config);

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

    try {
      await client.connect(transport);
    } catch (error) {
      // Enhance error with captured stderr
      const stderrOutput = stderrChunks.join('').trim();
      if (stderrOutput) {
        const err = error as Error;
        err.message = `${err.message}\n\nServer stderr:\n${stderrOutput}`;
      }
      throw error;
    }

    // For successful connections, forward stderr to console
    if (stderrStream) {
      stderrStream.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
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
 * Connect to an HTTP MCP server with OAuth support
 */
async function connectHttpServer(
  serverName: string,
  config: HttpServerConfig,
): Promise<ConnectedClient> {
  const { transport, oauthProvider } = await createHttpTransport(
    serverName,
    config,
  );

  const client = new Client(
    {
      name: 'mcp-cli',
      version: VERSION,
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport);
    return {
      client,
      close: async () => {
        await client.close();
        stopCallbackServer();
      },
    };
  } catch (error) {
    // Handle OAuth redirect - user needs to complete authorization
    if (error instanceof UnauthorizedError && oauthProvider) {
      debug(`OAuth redirect required for ${serverName}`);

      // Get the state that was used in the authorization URL
      // (state() was called by the SDK when building the auth URL)
      const state = oauthProvider.getLastState();
      if (!state) {
        throw new Error(
          'OAuth state not found - authorization flow may have failed',
        );
      }

      try {
        console.error('Waiting for authorization...');
        const callbackData = await oauthCallbackServer.waitForCallback(
          state,
          300000,
        );

        if (callbackData.error) {
          throw new Error(
            `OAuth error: ${callbackData.errorDescription || callbackData.error}`,
          );
        }

        // Exchange the authorization code for tokens
        // finishAuth stores the tokens in the provider
        await transport.finishAuth(callbackData.code);

        // Create a NEW transport and client for the actual connection
        // (the old transport is already "started" and can't be reused)
        const { transport: newTransport } = await createHttpTransport(
          serverName,
          config,
        );

        const newClient = new Client(
          {
            name: 'mcp-cli',
            version: VERSION,
          },
          {
            capabilities: {},
          },
        );

        await newClient.connect(newTransport);

        return {
          client: newClient,
          close: async () => {
            await newClient.close();
            stopCallbackServer();
          },
        };
      } catch (authError) {
        // Clean up callback server on auth failure
        stopCallbackServer();
        throw authError;
      }
    }

    throw error;
  }
}

/**
 * Create HTTP transport for remote servers
 * Supports OAuth authentication when configured
 */
async function createHttpTransport(
  serverName: string,
  config: HttpServerConfig,
): Promise<{
  transport: StreamableHTTPClientTransport;
  oauthProvider?: CliOAuthProvider;
}> {
  const url = new URL(config.url);

  // Check if OAuth is enabled for this server
  const oauthEnabled =
    config.oauth === true || typeof config.oauth === 'object';

  if (oauthEnabled) {
    // Start the OAuth callback server
    await ensureCallbackServerRunning();

    // Create OAuth provider
    const oauthConfig = typeof config.oauth === 'object' ? config.oauth : {};
    const oauthProvider = new CliOAuthProvider({
      serverUrl: config.url,
      clientName: oauthConfig.clientName || `mcp-cli (${serverName})`,
      onAuthorizationUrl: async (authUrl) => {
        debug(`Authorization URL: ${authUrl.toString()}`);
      },
    });

    // If pre-configured client credentials are provided, set them
    if (oauthConfig.clientId) {
      oauthProvider.saveClientInformation({
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
      });
    }

    const transport = new StreamableHTTPClientTransport(url, {
      authProvider: oauthProvider,
      requestInit: {
        headers: config.headers,
      },
    });

    return { transport, oauthProvider };
  }

  // No OAuth - simple transport
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: config.headers,
    },
  });

  return { transport };
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
  const { client, close } = await connectToServer(serverName, config);

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
