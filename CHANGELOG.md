# Changelog

## [0.3.0] - 2026-01-22

### Added

- **Server Instructions Support** - Display MCP server instructions in output
  - `mcp-cli` (list all): Shows first line of instructions per server
  - `mcp-cli info <server>`: Shows full instructions under "Instructions:" heading

- **Tool Filtering** - Restrict tools per server via config
  - `allowedTools`: Glob patterns for tools to allow (e.g., `["read_*", "list_*"]`)
  - `disabledTools`: Glob patterns for tools to exclude (e.g., `["delete_*"]`)
  - `disabledTools` takes precedence over `allowedTools`
  - Filtering applies globally to all CLI operations (info, grep, call)

- **Connection Daemon** - Lazy-spawn connection pooling
  - Per-server daemon keeps MCP connections warm
  - 60s idle timeout (configurable via `MCP_DAEMON_TIMEOUT`)
  - Automatic config hash invalidation
  - `MCP_NO_DAEMON=1` to disable

- **3-Subcommand Architecture** - `info`, `grep`, `call`
  - Flexible format support: `server tool` and `server/tool`
  - `call` always outputs raw JSON (for piping/scripting)
  - `info`/`grep` always output human-readable format

- **Improved Error Messages for LLMs**
  - AMBIGUOUS_COMMAND: Shows both `call` and `info` options
  - UNKNOWN_SUBCOMMAND: Smart mapping (run→call, list→info, search→grep)
  - MISSING_ARGUMENT: Shows available servers list
  - INVALID_JSON: Schema hint with example

- **Advanced Chaining Examples** - New documentation section
  - Search and read pipelines with jq
  - Multi-file processing with loops
  - Conditional execution with `jq -e`
  - Multi-server aggregation
  - Error handling patterns

- **Generate System Instructions Script** - `scripts/generate-system-instructions.ts`

### Changed

- **CLI Command Structure**
  - `mcp-cli` (no args) lists all servers
  - `mcp-cli info <server>` requires a server argument

- **Grep Output Format**
  - Output now uses space-separated format: `<server> <tool> <description>`
  - Descriptions are always shown when available
  - Pattern now matches tool name only (not server name or description)

### Removed

- **Backward Compatibility Syntax** - `mcp-cli server/tool [args]` now errors with helpful message
- **`--json` and `--raw` options** - Output format now automatic based on command
