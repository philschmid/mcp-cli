/**
 * Persistent connection daemon for MCP servers
 *
 * Keeps stdio server processes alive across CLI invocations,
 * enabling stateful workflows without reconnection overhead.
 *
 * Architecture:
 *   CLI invocation -> Unix socket -> Daemon -> MCP Server Pool
 *
 * @env MCP_DAEMON_SOCKET - Socket path (default: ~/.mcp-cli/daemon.sock)
 * @env MCP_DAEMON_IDLE_MS - Idle timeout in ms (default: 300000 = 5 min)
 */

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ConnectedClient, connectToServer, safeClose } from './client.js';
import { type ServerConfig, debug } from './config.js';
import { ErrorCode } from './errors.js';

const DEFAULT_SOCKET_PATH = join(homedir(), '.mcp-cli', 'daemon.sock');
const DEFAULT_IDLE_MS = 300000; // 5 minutes

function getSocketPath(): string {
  return process.env.MCP_DAEMON_SOCKET || DEFAULT_SOCKET_PATH;
}

function getIdleTimeoutMs(): number {
  const env = process.env.MCP_DAEMON_IDLE_MS;
  if (env) {
    const ms = Number.parseInt(env, 10);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  return DEFAULT_IDLE_MS;
}

interface PoolEntry {
  connection: ConnectedClient;
  config: ServerConfig;
  lastUsed: number;
}

class ConnectionPool {
  private pool = new Map<string, PoolEntry>();
  private idleTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private idleTimeoutMs: number) {
    this.startIdleCheck();
  }

  async acquire(
    serverName: string,
    config: ServerConfig,
  ): Promise<ConnectedClient> {
    const existing = this.pool.get(serverName);
    if (existing) {
      existing.lastUsed = Date.now();
      debug(`daemon: reusing connection for ${serverName}`);
      return existing.connection;
    }

    debug(`daemon: creating new connection for ${serverName}`);
    const connection = await connectToServer(serverName, config);
    this.pool.set(serverName, {
      connection,
      config,
      lastUsed: Date.now(),
    });
    return connection;
  }

  async release(serverName: string): Promise<void> {
    const entry = this.pool.get(serverName);
    if (entry) {
      debug(`daemon: releasing connection for ${serverName}`);
      await safeClose(entry.connection.close);
      this.pool.delete(serverName);
    }
  }

  async releaseAll(): Promise<void> {
    debug(`daemon: releasing all connections (${this.pool.size} active)`);
    const closes = [...this.pool.entries()].map(async ([name, entry]) => {
      debug(`daemon: closing ${name}`);
      await safeClose(entry.connection.close);
    });
    await Promise.all(closes);
    this.pool.clear();
    this.stopIdleCheck();
  }

  list(): string[] {
    return [...this.pool.keys()];
  }

  private startIdleCheck(): void {
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [name, entry] of this.pool.entries()) {
        if (now - entry.lastUsed > this.idleTimeoutMs) {
          debug(`daemon: idle timeout for ${name}`);
          this.release(name);
        }
      }
    }, 60000); // Check every minute
  }

  private stopIdleCheck(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

interface DaemonRequest {
  method: 'call' | 'connect' | 'disconnect' | 'list' | 'shutdown';
  params?: {
    server?: string;
    config?: ServerConfig;
    tool?: string;
    args?: Record<string, unknown>;
  };
}

interface DaemonResponse {
  ok?: boolean;
  result?: unknown;
  servers?: string[];
  error?: string;
}

export async function startDaemon(): Promise<void> {
  const socketPath = getSocketPath();
  const idleMs = getIdleTimeoutMs();

  const socketDir = dirname(socketPath);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true });
  }

  if (existsSync(socketPath)) {
    unlinkSync(socketPath);
  }

  const pool = new ConnectionPool(idleMs);

  const server = Bun.serve({
    unix: socketPath,
    async fetch(req): Promise<Response> {
      let request: DaemonRequest;
      try {
        request = (await req.json()) as DaemonRequest;
      } catch {
        return Response.json({ error: 'invalid JSON' } as DaemonResponse, {
          status: 400,
        });
      }

      try {
        switch (request.method) {
          case 'connect': {
            const { server: serverName, config } = request.params ?? {};
            if (!serverName || !config) {
              return Response.json(
                { error: 'missing server or config' } as DaemonResponse,
                { status: 400 },
              );
            }
            await pool.acquire(serverName, config);
            return Response.json({ ok: true } as DaemonResponse);
          }

          case 'call': {
            const {
              server: serverName,
              config,
              tool,
              args,
            } = request.params ?? {};
            if (!serverName || !config || !tool) {
              return Response.json(
                { error: 'missing server, config, or tool' } as DaemonResponse,
                { status: 400 },
              );
            }
            const { client } = await pool.acquire(serverName, config);
            const result = await client.callTool({
              name: tool,
              arguments: args ?? {},
            });
            return Response.json({ result } as DaemonResponse);
          }

          case 'disconnect': {
            const { server: serverName } = request.params ?? {};
            if (!serverName) {
              return Response.json(
                { error: 'missing server' } as DaemonResponse,
                { status: 400 },
              );
            }
            await pool.release(serverName);
            return Response.json({ ok: true } as DaemonResponse);
          }

          case 'list': {
            return Response.json({ servers: pool.list() } as DaemonResponse);
          }

          case 'shutdown': {
            await pool.releaseAll();
            // Schedule shutdown after response
            setTimeout(() => {
              server.stop();
              process.exit(0);
            }, 100);
            return Response.json({ ok: true } as DaemonResponse);
          }

          default:
            return Response.json(
              { error: `unknown method: ${request.method}` } as DaemonResponse,
              { status: 400 },
            );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message } as DaemonResponse, {
          status: 500,
        });
      }
    },
  });

  const shutdown = async () => {
    debug('daemon: shutting down');
    await pool.releaseAll();
    server.stop();
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('mcp-cli daemon started');
  console.log(`  Socket: ${socketPath}`);
  console.log(`  Idle timeout: ${idleMs}ms`);
  console.log(`  PID: ${process.pid}`);
}

export async function isDaemonRunning(): Promise<boolean> {
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) {
    return false;
  }

  try {
    const res = await fetch('http://localhost/', {
      unix: socketPath,
      method: 'POST',
      body: JSON.stringify({ method: 'list' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function callViaDaemon(
  serverName: string,
  config: ServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const socketPath = getSocketPath();
  const request: DaemonRequest = {
    method: 'call',
    params: {
      server: serverName,
      config,
      tool: toolName,
      args,
    },
  };

  const res = await fetch('http://localhost/', {
    unix: socketPath,
    method: 'POST',
    body: JSON.stringify(request),
  });

  const response = (await res.json()) as DaemonResponse;

  if (response.error) {
    throw new Error(response.error);
  }

  return response.result;
}

export async function listDaemonServers(): Promise<string[]> {
  const socketPath = getSocketPath();
  const res = await fetch('http://localhost/', {
    unix: socketPath,
    method: 'POST',
    body: JSON.stringify({ method: 'list' }),
  });
  const response = (await res.json()) as DaemonResponse;
  return response.servers ?? [];
}

export async function stopDaemon(): Promise<void> {
  const socketPath = getSocketPath();
  if (!existsSync(socketPath)) {
    console.error('Daemon is not running');
    process.exit(ErrorCode.CLIENT_ERROR);
  }

  try {
    await fetch('http://localhost/', {
      unix: socketPath,
      method: 'POST',
      body: JSON.stringify({ method: 'shutdown' }),
    });
    console.log('Daemon stopped');
  } catch {
    console.error('Failed to stop daemon');
    process.exit(ErrorCode.NETWORK_ERROR);
  }
}

export async function daemonStatus(): Promise<void> {
  const socketPath = getSocketPath();
  const running = await isDaemonRunning();

  if (!running) {
    console.log('Daemon: not running');
    console.log(`Socket: ${socketPath}`);
    return;
  }

  const servers = await listDaemonServers();
  console.log('Daemon: running');
  console.log(`Socket: ${socketPath}`);
  console.log(`Active connections: ${servers.length}`);
  if (servers.length > 0) {
    console.log(`  ${servers.join('\n  ')}`);
  }
}

export function getDaemonSocketPath(): string {
  return getSocketPath();
}
