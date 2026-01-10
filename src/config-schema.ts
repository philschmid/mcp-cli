/**
 * Zod schema definitions for mcp_servers.json configuration
 * Used for runtime validation and JSON Schema generation
 */

import * as z from 'zod';

/**
 * Stdio server configuration for running a local MCP server as a subprocess
 * Uses .passthrough() to preserve extra properties for validation
 * Rejects configs that also have 'url' (HTTP property)
 */
export const StdioServerSchema = z
  .object({
    command: z
      .string()
      .describe(
        "The command to execute (e.g., 'npx', 'node', '/path/to/server')",
      ),
    args: z
      .array(z.string())
      .optional()
      .describe('Arguments to pass to the command'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables to set for the subprocess'),
    cwd: z
      .string()
      .optional()
      .describe(
        'Working directory for the subprocess (defaults to current directory)',
      ),
  })
  .loose()
  .refine(
    (data) => {
      // Reject stdio configs that also have 'url' (HTTP property)
      if ('url' in data) {
        throw new z.ZodError([
          {
            code: z.ZodIssueCode.custom,
            message: 'not both',
            path: ['url'],
          },
        ]);
      }
      return true;
    },
    {
      error: 'Stdio server cannot have url property',
    },
  )
  .describe(
    'Stdio server configuration for running a local MCP server as a subprocess',
  );

/**
 * HTTP server configuration for connecting to a remote MCP server
 * Uses .passthrough() to preserve extra properties for validation
 * Rejects configs that also have 'command' (stdio property)
 */
export const HttpServerSchema = z
  .object({
    url: z.url().describe('The URL of the remote MCP server endpoint'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Custom HTTP headers to include with each request'),
    timeout: z
      .number()
      .optional()
      .describe(
        'Request timeout in milliseconds (default: 1800000 = 30 minutes)',
      ),
  })
  .loose()
  .refine(
    (data) => {
      // Reject HTTP configs that also have 'command' (stdio property)
      if ('command' in data) {
        throw new z.ZodError([
          {
            code: z.ZodIssueCode.custom,
            message: 'not both',
            path: ['command'],
          },
        ]);
      }
      return true;
    },
    {
      error: 'HTTP server cannot have command property',
    },
  )
  .describe('HTTP server configuration for connecting to a remote MCP server');

/**
 * Union type for server configurations (either stdio or HTTP)
 * Zod v4: use z.union() instead of .or()
 * Validation is done in individual schemas (rejecting having both command and url)
 */
export const ServerConfigSchema = z
  .union([StdioServerSchema, HttpServerSchema])
  .describe('Configuration for a single MCP server (either stdio or HTTP)');

/**
 * Root configuration schema for mcp_servers.json
 */
export const McpServersConfigSchema = z
  .object({
    mcpServers: z
      .record(z.string(), ServerConfigSchema)
      .describe('Record of MCP server names to their configurations'),
  })
  .describe('Configuration file for Model Context Protocol (MCP) servers');

/**
 * Type exports for TypeScript inference
 * Zod v4: use z.output<> instead of z.infer<>
 */
export type StdioServerConfig = z.output<typeof StdioServerSchema>;
export type HttpServerConfig = z.output<typeof HttpServerSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type McpServersConfig = z.output<typeof McpServersConfigSchema>;
