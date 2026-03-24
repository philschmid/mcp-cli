/**
 * IPC primitives for daemon socket communication.
 *
 * Handles large message transmission over Unix sockets where Bun's
 * socket.write() may only write up to the kernel buffer size (~8KB).
 * Uses newline-delimited JSON as the wire protocol.
 */

/**
 * Create a Unix socket server that receives JSON requests and sends
 * newline-delimited JSON responses, handling partial writes via drain.
 */
export function createIpcServer(
  socketPath: string,
  handler: (request: unknown) => unknown,
) {
  const readBuffers = new Map<unknown, string>();
  const writeBuffers = new Map<unknown, string>();

  function writeAll(socket: { write(data: string): number }, payload: string) {
    const written = socket.write(payload);
    if (written < payload.length) {
      writeBuffers.set(socket, payload.slice(written));
    }
  }

  return Bun.listen({
    unix: socketPath,
    socket: {
      async data(socket, data) {
        if (!readBuffers.has(socket)) readBuffers.set(socket, '');
        readBuffers.set(socket, readBuffers.get(socket)! + data.toString());
        const buf = readBuffers.get(socket)!;
        try {
          JSON.parse(buf);
          readBuffers.delete(socket);
        } catch {
          return; // incomplete JSON, wait for more
        }
        const request = JSON.parse(buf);
        const response = await handler(request);
        writeAll(socket, JSON.stringify(response) + '\n');
      },
      drain(socket) {
        const remaining = writeBuffers.get(socket);
        if (remaining) {
          writeBuffers.delete(socket);
          writeAll(socket, remaining);
        }
      },
      close(socket) {
        readBuffers.delete(socket);
        writeBuffers.delete(socket);
      },
      error(socket) {
        readBuffers.delete(socket);
        writeBuffers.delete(socket);
      },
    },
  });
}

/**
 * Send a JSON request to a Unix socket and receive a newline-delimited
 * JSON response, buffering chunks until the full message arrives.
 */
export function sendIpcRequest(
  socketPath: string,
  request: unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    function settle(fn: () => void) {
      if (!settled) {
        settled = true;
        fn();
      }
    }

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(request));
        },
        data(socket, data) {
          buffer += data.toString();
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) return;
          const message = buffer.slice(0, newlineIndex).trim();
          try {
            const response = JSON.parse(message);
            socket.end();
            settle(() => resolve(response));
          } catch {
            socket.end();
            settle(() => reject(new Error('Invalid response from daemon')));
          }
        },
        close() {
          if (buffer.length > 0) {
            try {
              const response = JSON.parse(buffer.trim());
              settle(() => resolve(response));
            } catch {
              // timeout will handle it
            }
          }
        },
        error(_socket, error) {
          settle(() => reject(error));
        },
        connectError(_socket, error) {
          settle(() => reject(error));
        },
      },
    });

    setTimeout(() => {
      settle(() => reject(new Error('Daemon request timeout')));
    }, timeoutMs);
  });
}
