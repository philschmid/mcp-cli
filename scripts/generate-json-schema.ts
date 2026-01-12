/**
 * Build script to generate JSON Schema from Zod schemas
 * Run with: bun run generate:schema
 */

import { McpServersConfigSchema } from '../src/config-schema.js';
import { writeFileSync } from 'node:fs';

const jsonSchema = McpServersConfigSchema.toJSONSchema({
  // Preserve strictness: set additionalProperties: false for objects
  override(ctx) {
    const schema = ctx.jsonSchema;
    if (
      schema &&
      typeof schema === 'object' &&
      schema.type === 'object' &&
      schema.additionalProperties === undefined
    ) {
      schema.additionalProperties = false;
    }
  },
});

// Ensure the root schema has an $id
jsonSchema.$id = 'https://mcp-cli.dev/schemas/mcp_servers.json';
jsonSchema.$schema = 'http://json-schema.org/draft-07/schema#';

writeFileSync(
  'mcp_servers.schema.json',
  `${JSON.stringify(jsonSchema, null, 2)}\n`,
);

console.log('Generated: mcp_servers.schema.json');
