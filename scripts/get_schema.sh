#!/usr/bin/env bash
#
# ==============================================================================
# MCP Schema Documentation Generator
# ==============================================================================
#
# DESCRIPTION:
#   Automatically discovers all available MCP servers and tools,
#   retrieves their JSON schemas, and updates the SKILL.md documentation.
#
# USAGE:
#   From project root:
#     bash scripts/get_schema.sh
#
#   From scripts directory:
#     bash get_schema.sh
#
# WHAT IT DOES:
#   1. Discovers all MCP servers and tools via 'mcp-cli -d'
#   2. Queries JSON schema for each operation via 'mcp-cli info'
#   3. Formats output as markdown with tools grouped by category
#   4. Updates SKILL.md with results
#
# OUTPUT:
#   - Updates: SKILL.md (in project root)
#   - Creates: /tmp/mcp_tools.md (formatted output)
#   - Creates: /tmp/mcp_raw.txt (raw mcp-cli output)
#
# REQUIREMENTS:
#   - bash 4.0+ (for associative arrays)
#   - mcp-cli installed and configured with active servers
#   - python3 (for JSON schema parsing)
#
# EXAMPLES:
#   # Run from project root
#   bash scripts/get_schema.sh
#
#   # Check what servers would be discovered
#   mcp-cli -d
#
#   # View generated markdown before it's added to SKILL.md
#   cat /tmp/mcp_tools.md
#
# NOTES:
#   - Script is idempotent - safe to run multiple times
#   - Takes ~2 minutes depending on number of tools
#   - Automatically groups tools by prefix (catalog_, health_, etc.)
#   - Removes any existing "Available Servers & Tools" section
#   - Queries each operation from each server (no deduplication)
#
# ==============================================================================

set -e

# Check for bash 4+ (needed for associative arrays)
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "Error: This script requires bash 4.0 or higher"
  echo "Current bash version: ${BASH_VERSION}"
  exit 1
fi

SKILL_FILE="SKILL.md"
TEMP_OUTPUT="/tmp/mcp_tools.md"
TEMP_RAW="/tmp/mcp_raw.txt"

echo "Discovering MCP servers and tools..."

# Get list of servers and tools with descriptions
mcp-cli -d > "$TEMP_RAW" 2>&1

# Parse the output to extract servers and tools
declare -A servers_ops
declare -A op_descriptions

current_server=""
while IFS= read -r line; do
  # Check if line is a server name (no leading spaces/bullets)
  if [[ ! "$line" =~ ^[[:space:]] && -n "$line" ]]; then
    current_server="$line"
    servers_ops[$current_server]=""
  # Check if line is an operation (starts with bullet)
  elif [[ "$line" =~ ^[[:space:]]*•[[:space:]]*([a-z_]+)[[:space:]]*-[[:space:]]*(.*) ]]; then
    operation="${BASH_REMATCH[1]}"
    description="${BASH_REMATCH[2]}"
    if [[ -n "$current_server" ]]; then
      servers_ops[$current_server]+="$operation "
      # Store description from first occurrence
      if [[ -z "${op_descriptions[$operation]}" ]]; then
        op_descriptions[$operation]="$description"
      fi
    fi
  fi
done < "$TEMP_RAW"

echo "Found ${#servers_ops[@]} server(s)"

# Start building the markdown output
cat > "$TEMP_OUTPUT" << 'EOF'

## Available Servers & Tools

EOF

# Process each server and its tools
for server in "${!servers_ops[@]}"; do
  echo "Processing server: $server"
  
  ops_array=(${servers_ops[$server]})
  echo "  Found ${#ops_array[@]} tools"
  
  # Group tools by prefix (catalog, health, status, etc.)
  declare -A grouped_ops
  
  for op in "${ops_array[@]}"; do
    if [[ "$op" =~ ^([a-z]+)_ ]]; then
      prefix="${BASH_REMATCH[1]}"
    else
      prefix="other"
    fi
    grouped_ops[$prefix]+="$op "
  done
  
  # Write server header
  echo "" >> "$TEMP_OUTPUT"
  echo "### Server: $server" >> "$TEMP_OUTPUT"
  echo "" >> "$TEMP_OUTPUT"
  
  # Process each group
  for prefix in $(echo "${!grouped_ops[@]}" | tr ' ' '\n' | sort); do
    if [[ "$prefix" != "other" ]]; then
      # Capitalize first letter for section title
      section_title="$(echo "$prefix" | sed 's/^./\U&/') Tools"
      echo "#### $section_title" >> "$TEMP_OUTPUT"
      echo "" >> "$TEMP_OUTPUT"
    fi
    
    group_ops=(${grouped_ops[$prefix]})
    for op in $(echo "${group_ops[@]}" | tr ' ' '\n' | sort); do
      description="${op_descriptions[$op]}"
      schema="${op_schemas[$op]}"
      
      echo "    Getting schema for: $server/$op"
      
      # Get the tool info
      tool_info=$(mcp-cli info "$server" "$op" 2>&1)
      
      # Extract input schema JSON
      schema=$(echo "$tool_info" | sed -n '/^Input Schema:/,/^$/p' | grep -v "^Input Schema:" | sed '/^$/d')
      
      # Parse JSON schema to simplified format
      if echo "$schema" | grep -q '"properties"'; then
        simplified=$(echo "$schema" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    props = data.get('properties', {})
    required = data.get('required', [])
    
    if not props:
        print('{}')
    else:
        result = {}
        for key, value in props.items():
            type_str = value.get('type', 'any')
            default = value.get('default')
            description = value.get('description', '')

            # Handle anyOf types
            if 'anyOf' in value:
                types = [t.get('type', 'any') for t in value['anyOf']]
                type_str = ' | '.join(types)

            # Build the value string
            val_parts = [type_str]
            if key in required:
                val_parts.append('(required)')
            else:
                val_parts.append('(optional)')

            if default is not None:
                val_parts.append(f'default: {default}')

            result[key] = ' '.join(val_parts)

            if description:
                result[key] += f' - {description}'

        print(json.dumps(result, indent=2))
except Exception as e:
    print('{}')
" 2>/dev/null || echo '{}')
      else
        simplified='{}'
      fi
      
      # Write to output
      echo "**$op** - $description" >> "$TEMP_OUTPUT"
      echo '```json' >> "$TEMP_OUTPUT"
      echo "$simplified" >> "$TEMP_OUTPUT"
      echo '```' >> "$TEMP_OUTPUT"
      echo "" >> "$TEMP_OUTPUT"
    done
  done
  
  # Clear grouped_ops for next server
  unset grouped_ops
done

echo ""
echo "Updating SKILL.md..."

# Remove any existing "## Available Servers & Tools" section
if grep -q "^## Available Servers & Tools" "$SKILL_FILE"; then
  # Find the line number where this section starts
  start_line=$(grep -n "^## Available Servers & Tools" "$SKILL_FILE" | head -1 | cut -d: -f1)
  
  # Find the next ## section after it (or end of file)
  next_section=$(tail -n +$((start_line + 1)) "$SKILL_FILE" | grep -n "^## " | head -1 | cut -d: -f1)
  
  if [ -n "$next_section" ]; then
    # There's another section after, so remove up to that line
    end_line=$((start_line + next_section - 1))
    sed -i.bak "${start_line},${end_line}d" "$SKILL_FILE"
  else
    # This is the last section, remove to end of file
    sed -i.bak "${start_line},\$d" "$SKILL_FILE"
  fi
fi

# Append the new content to the end of the file
cat "$TEMP_OUTPUT" >> "$SKILL_FILE"

echo "✓ SKILL.md updated successfully!"
echo "✓ Output also saved to: $TEMP_OUTPUT"

# Cleanup
rm -f "${SKILL_FILE}.bak"
