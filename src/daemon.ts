/**
 * MCP-CLI Daemon - Background worker that maintains persistent MCP connections
 * 
 * This is spawned as a detached process and manages a Unix socket for IPC.
 * It maintains the MCP server connection and forwards requests from CLI invocations.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ServerConfig,
  debug,
  getDaemonTimeoutMs,
  getSocketPath,
  getPidPath,
  getSocketDir,
  getConfigHash,
} from './config.js';
import { connectToServer, listTools, callTool, type ConnectedClient } from './client.js';

// ============================================================================
// Types
// ============================================================================

export interface DaemonRequest {
  id: string;
  type: 'listTools' | 'callTool' | 'ping' | 'close' | 'getInstructions';
  toolName?: string;
  args?: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface PidFileContent {
  pid: number;
  configHash: string;
  startedAt: string;
}

// ============================================================================
// PID File Management
// ============================================================================

/**
 * Write PID file with config hash for stale detection
 */
export function writePidFile(serverName: string, configHash: string): void {
  const pidPath = getPidPath(serverName);
  const dir = dirname(pidPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const content: PidFileContent = {
    pid: process.pid,
    configHash,
    startedAt: new Date().toISOString(),
  };

  writeFileSync(pidPath, JSON.stringify(content), { mode: 0o600 });
}

/**
 * Read PID file content
 */
export function readPidFile(serverName: string): PidFileContent | null {
  const pidPath = getPidPath(serverName);

  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const content = readFileSync(pidPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Remove PID file
 */
export function removePidFile(serverName: string): void {
  const pidPath = getPidPath(serverName);
  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Remove socket file
 */
export function removeSocketFile(serverName: string): void {
  const socketPath = getSocketPath(serverName);
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process by PID
 */
export function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Daemon Worker
// ============================================================================

/**
 * Main daemon entry point - run as detached background process
 */
export async function runDaemon(serverName: string, config: ServerConfig): Promise<void> {
  const socketPath = getSocketPath(serverName);
  const configHash = getConfigHash(config);
  const timeoutMs = getDaemonTimeoutMs();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let mcpClient: ConnectedClient | null = null;
  let server: ReturnType<typeof Bun.listen> | null = null;
  // biome-ignore lint: Socket type from Bun.listen handlers
  const activeConnections = new Set<unknown>();

  // Cleanup function
  const cleanup = async () => {
    debug(`[daemon:${serverName}] Shutting down...`);

    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // Close all active socket connections
    for (const conn of activeConnections) {
      try {
        (conn as { end: () => void }).end();
      } catch {
        // Ignore
      }
    }
    activeConnections.clear();

    // Close MCP connection
    if (mcpClient) {
      try {
        await mcpClient.close();
      } catch {
        // Ignore
      }
      mcpClient = null;
    }

    // Close socket server
    if (server) {
      try {
        server.stop();
      } catch {
        // Ignore
      }
      server = null;
    }

    // Clean up files
    removeSocketFile(serverName);
    removePidFile(serverName);

    debug(`[daemon:${serverName}] Cleanup complete`);
  };

  // Reset idle timer
  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(async () => {
      debug(`[daemon:${serverName}] Idle timeout reached, shutting down`);
      await cleanup();
      process.exit(0);
    }, timeoutMs);
  };

  // Handle signals
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  // Ensure socket dir exists
  const socketDir = getSocketDir();
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }

  // Remove stale socket if exists
  removeSocketFile(serverName);

  // Write PID file
  writePidFile(serverName, configHash);

  // Connect to MCP server
  try {
    debug(`[daemon:${serverName}] Connecting to MCP server...`);
    mcpClient = await connectToServer(serverName, config);
    debug(`[daemon:${serverName}] Connected to MCP server`);
  } catch (error) {
    console.error(`[daemon:${serverName}] Failed to connect:`, (error as Error).message);
    await cleanup();
    process.exit(1);
  }

  // Handle incoming request
  const handleRequest = async (data: Buffer): Promise<DaemonResponse> => {
    resetIdleTimer();

    let request: DaemonRequest;
    try {
      request = JSON.parse(data.toString());
    } catch {
      return {
        id: 'unknown',
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'Invalid JSON' },
      };
    }

    debug(`[daemon:${serverName}] Request: ${request.type} (${request.id})`);

    if (!mcpClient) {
      return {
        id: request.id,
        success: false,
        error: { code: 'NOT_CONNECTED', message: 'MCP client not connected' },
      };
    }

    try {
      switch (request.type) {
        case 'ping':
          return { id: request.id, success: true, data: 'pong' };

        case 'listTools': {
          const tools = await listTools(mcpClient.client);
          return { id: request.id, success: true, data: tools };
        }

        case 'callTool': {
          if (!request.toolName) {
            return {
              id: request.id,
              success: false,
              error: { code: 'MISSING_TOOL', message: 'toolName required' },
            };
          }
          const result = await callTool(mcpClient.client, request.toolName, request.args ?? {});
          return { id: request.id, success: true, data: result };
        }

        case 'getInstructions': {
          const instructions = mcpClient.client.getInstructions();
          return { id: request.id, success: true, data: instructions };
        }

        case 'close':
          // Graceful shutdown requested
          setTimeout(async () => {
            await cleanup();
            process.exit(0);
          }, 100);
          return { id: request.id, success: true, data: 'closing' };

        default:
          return {
            id: request.id,
            success: false,
            error: { code: 'UNKNOWN_TYPE', message: `Unknown request type: ${request.type}` },
          };
      }
    } catch (error) {
      const err = error as Error;
      return {
        id: request.id,
        success: false,
        error: { code: 'EXECUTION_ERROR', message: err.message },
      };
    }
  };

  // Start Unix socket server
  try {
    server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          activeConnections.add(socket);
          debug(`[daemon:${serverName}] Client connected`);
        },
        async data(socket, data) {
          const response = await handleRequest(data);
          socket.write(JSON.stringify(response) + '\n');
        },
        close(socket) {
          activeConnections.delete(socket);
          debug(`[daemon:${serverName}] Client disconnected`);
        },
        error(socket, error) {
          debug(`[daemon:${serverName}] Socket error: ${error.message}`);
          activeConnections.delete(socket);
        },
      },
    });

    debug(`[daemon:${serverName}] Listening on ${socketPath}`);

    // Start idle timer
    resetIdleTimer();

    // Signal readiness by writing to stdout (parent will read this)
    console.log('DAEMON_READY');

  } catch (error) {
    console.error(`[daemon:${serverName}] Failed to start socket server:`, (error as Error).message);
    await cleanup();
    process.exit(1);
  }
}

// ============================================================================
// Entry point when run directly
// ============================================================================

// Check if running as daemon process
if (process.argv[2] === '--daemon') {
  const serverName = process.argv[3];
  const configJson = process.argv[4];

  if (!serverName || !configJson) {
    console.error('Usage: daemon.ts --daemon <serverName> <configJson>');
    process.exit(1);
  }

  let config: ServerConfig;
  try {
    config = JSON.parse(configJson);
  } catch {
    console.error('Invalid config JSON');
    process.exit(1);
  }

  runDaemon(serverName, config).catch((error) => {
    console.error('Daemon failed:', error);
    process.exit(1);
  });
}
