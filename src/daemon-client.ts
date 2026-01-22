/**
 * MCP-CLI Daemon Client - IPC client for communicating with daemon workers
 * 
 * Handles spawning daemons, detecting stale connections, and forwarding requests.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ServerConfig,
  debug,
  getSocketPath,
  getConfigHash,
  getSocketDir,
} from './config.js';
import {
  readPidFile,
  removePidFile,
  removeSocketFile,
  isProcessRunning,
  killProcess,
  type DaemonRequest,
  type DaemonResponse,
} from './daemon.js';

// ============================================================================
// Daemon Connection
// ============================================================================

/**
 * Represents a daemon connection for a specific server
 */
export interface DaemonConnection {
  serverName: string;
  listTools: () => Promise<unknown>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  getInstructions: () => Promise<string | undefined>;
  close: () => Promise<void>;
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Send a request to the daemon and wait for response
 */
async function sendRequest(socketPath: string, request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(request));
        },
        data(socket, data) {
          try {
            const response = JSON.parse(data.toString().trim());
            socket.end();
            resolve(response);
          } catch (err) {
            socket.end();
            reject(new Error('Invalid response from daemon'));
          }
        },
        error(socket, error) {
          reject(error);
        },
        close() {
          // Connection closed
        },
        connectError(socket, error) {
          reject(error);
        },
      },
    });

    // Timeout after 5 seconds (fast fallback to direct connection)
    setTimeout(() => {
      reject(new Error('Daemon request timeout'));
    }, 5000);
  });
}

/**
 * Check if daemon is running and has matching config
 */
function isDaemonValid(serverName: string, config: ServerConfig): boolean {
  const socketPath = getSocketPath(serverName);
  const pidInfo = readPidFile(serverName);

  // No PID file = no daemon
  if (!pidInfo) {
    debug(`[daemon-client] No PID file for ${serverName}`);
    return false;
  }

  // Check if process is actually running
  if (!isProcessRunning(pidInfo.pid)) {
    debug(`[daemon-client] Process ${pidInfo.pid} not running, cleaning up`);
    removePidFile(serverName);
    removeSocketFile(serverName);
    return false;
  }

  // Check if config matches
  const currentHash = getConfigHash(config);
  if (pidInfo.configHash !== currentHash) {
    debug(`[daemon-client] Config hash mismatch for ${serverName}, killing old daemon`);
    killProcess(pidInfo.pid);
    removePidFile(serverName);
    removeSocketFile(serverName);
    return false;
  }

  // Check if socket exists
  if (!existsSync(socketPath)) {
    debug(`[daemon-client] Socket missing for ${serverName}, cleaning up`);
    killProcess(pidInfo.pid);
    removePidFile(serverName);
    return false;
  }

  return true;
}

/**
 * Spawn a new daemon process for a server
 */
async function spawnDaemon(serverName: string, config: ServerConfig): Promise<boolean> {
  debug(`[daemon-client] Spawning daemon for ${serverName}`);

  // Find the daemon script path
  const daemonScript = join(import.meta.dir, 'daemon.ts');

  const configJson = JSON.stringify(config);

  // Spawn detached process
  const proc = Bun.spawn({
    cmd: ['bun', 'run', daemonScript, '--daemon', serverName, configJson],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });

  // Wait for daemon to signal readiness or fail
  return new Promise((resolve) => {
    let resolved = false;

    const reader = proc.stdout.getReader();

    const checkReady = async () => {
      try {
        const { value, done } = await reader.read();
        if (done) {
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
          return;
        }

        const text = new TextDecoder().decode(value);
        if (text.includes('DAEMON_READY')) {
          if (!resolved) {
            resolved = true;
            // Don't await the process, let it run detached
            proc.unref();
            resolve(true);
          }
        } else {
          // Keep reading
          checkReady();
        }
      } catch {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }
    };

    checkReady();

    // Timeout after 5 seconds (fast fallback to direct connection)
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        debug(`[daemon-client] Daemon spawn timeout for ${serverName}`);
        resolve(false);
      }
    }, 5000);

    // Check for early exit
    proc.exited.then((code) => {
      if (!resolved && code !== 0) {
        resolved = true;
        debug(`[daemon-client] Daemon exited with code ${code}`);
        resolve(false);
      }
    });
  });
}

/**
 * Get or create a daemon connection for a server
 * Returns null if daemon mode fails (caller should fallback to direct connection)
 */
export async function getDaemonConnection(
  serverName: string,
  config: ServerConfig,
): Promise<DaemonConnection | null> {
  const socketPath = getSocketPath(serverName);

  // Check if valid daemon exists
  if (!isDaemonValid(serverName, config)) {
    // Spawn new daemon
    const spawned = await spawnDaemon(serverName, config);
    if (!spawned) {
      debug(`[daemon-client] Failed to spawn daemon for ${serverName}`);
      return null;
    }

    // Wait a bit for socket to be ready
    await new Promise((r) => setTimeout(r, 100));
  }

  // Verify socket exists
  if (!existsSync(socketPath)) {
    debug(`[daemon-client] Socket not found after spawn for ${serverName}`);
    return null;
  }

  // Test connection with ping
  try {
    const pingResponse = await sendRequest(socketPath, {
      id: generateRequestId(),
      type: 'ping',
    });

    if (!pingResponse.success) {
      debug(`[daemon-client] Ping failed for ${serverName}`);
      return null;
    }
  } catch (error) {
    debug(`[daemon-client] Connection test failed for ${serverName}: ${(error as Error).message}`);
    return null;
  }

  debug(`[daemon-client] Connected to daemon for ${serverName}`);

  // Return connection interface
  return {
    serverName,

    async listTools(): Promise<unknown> {
      const response = await sendRequest(socketPath, {
        id: generateRequestId(),
        type: 'listTools',
      });

      if (!response.success) {
        throw new Error(response.error?.message ?? 'listTools failed');
      }

      return response.data;
    },

    async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
      const response = await sendRequest(socketPath, {
        id: generateRequestId(),
        type: 'callTool',
        toolName,
        args,
      });

      if (!response.success) {
        throw new Error(response.error?.message ?? 'callTool failed');
      }

      return response.data;
    },

    async getInstructions(): Promise<string | undefined> {
      const response = await sendRequest(socketPath, {
        id: generateRequestId(),
        type: 'getInstructions',
      });

      if (!response.success) {
        throw new Error(response.error?.message ?? 'getInstructions failed');
      }

      return response.data as string | undefined;
    },

    async close(): Promise<void> {
      // Just disconnect, don't tell daemon to close (let it idle timeout)
      debug(`[daemon-client] Disconnecting from ${serverName} daemon`);
    },
  };
}

/**
 * Clean up any orphaned daemon processes and sockets
 * Call this on CLI startup
 */
export async function cleanupOrphanedDaemons(): Promise<void> {
  const socketDir = getSocketDir();

  if (!existsSync(socketDir)) {
    return;
  }

  try {
    const files = await Array.fromAsync(new Bun.Glob('*.pid').scan(socketDir));

    for (const file of files) {
      const serverName = file.replace('.pid', '');
      const pidInfo = readPidFile(serverName);

      if (pidInfo && !isProcessRunning(pidInfo.pid)) {
        debug(`[daemon-client] Cleaning up orphaned daemon: ${serverName}`);
        removePidFile(serverName);
        removeSocketFile(serverName);
      }
    }
  } catch {
    // Ignore errors during cleanup scan
  }
}
