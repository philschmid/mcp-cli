#!/bin/bash
# Install script for mcp-cli
# Usage: curl -fsSL https://raw.githubusercontent.com/philschmid/mcp-cli/main/install.sh | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Cleanup on exit
TMP_FILE=""
TMP_CHECKSUM=""
cleanup() {
    if [ -n "$TMP_FILE" ] && [ -f "$TMP_FILE" ]; then
        rm -f "$TMP_FILE"
    fi
    if [ -n "$TMP_CHECKSUM" ] && [ -f "$TMP_CHECKSUM" ]; then
        rm -f "$TMP_CHECKSUM"
    fi
}
trap cleanup EXIT

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
    linux)
        case "$ARCH" in
            x86_64) BINARY="mcp-cli-linux-x64" ;;
            aarch64) BINARY="mcp-cli-linux-arm64" ;;
            *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
        esac
        ;;
    darwin)
        case "$ARCH" in
            x86_64) BINARY="mcp-cli-darwin-x64" ;;
            arm64) BINARY="mcp-cli-darwin-arm64" ;;
            *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
        esac
        ;;
    *)
        echo -e "${RED}Unsupported OS: $OS${NC}"
        exit 1
        ;;
esac

# Installation directory - prefer ~/.local/bin (no sudo needed)
if [ -z "${INSTALL_DIR:-}" ]; then
    if [ -w "/usr/local/bin" ]; then
        INSTALL_DIR="/usr/local/bin"
    else
        INSTALL_DIR="$HOME/.local/bin"
    fi
fi

GITHUB_REPO="philschmid/mcp-cli"

# Print banner
echo ""
echo -e "${BOLD}Installing mcp-cli${NC}"
echo ""
echo -e "  ${BOLD}Platform${NC}:  $OS/$ARCH"
echo -e "  ${BOLD}Binary${NC}:    $BINARY"
echo -e "  ${BOLD}Location${NC}:  $INSTALL_DIR/mcp-cli"
echo ""

# Check for existing installation
if command -v mcp-cli &> /dev/null; then
    EXISTING_VERSION=$(mcp-cli --version 2>/dev/null || echo "unknown")
    echo -e "${YELLOW}Note: Updating existing installation ($EXISTING_VERSION)${NC}"
    echo ""
fi

# Get latest release URL
DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/latest/download/$BINARY"
CHECKSUM_URL="https://github.com/$GITHUB_REPO/releases/latest/download/checksums.txt"

# Download binary
echo -e "${BLUE}Downloading...${NC}"
TMP_FILE=$(mktemp)
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"; then
    echo -e "${RED}Failed to download binary.${NC}"
    echo "  URL: $DOWNLOAD_URL"
    echo ""
    if [ "$OS" = "linux" ] && [ "$ARCH" = "aarch64" ]; then
        echo -e "${YELLOW}Linux arm64 release asset not found for the latest release.${NC}"
        echo "Try installing from source instead:"
        echo "  bun install -g https://github.com/$GITHUB_REPO"
        echo ""
    fi
    echo -e "${RED}Check available releases at:${NC}"
    echo "  https://github.com/$GITHUB_REPO/releases"
    exit 1
fi

# Verify checksum (if available)
TMP_CHECKSUM=$(mktemp)
if curl -fsSL "$CHECKSUM_URL" -o "$TMP_CHECKSUM" 2>/dev/null; then
    # Extract checksum for our binary
    EXPECTED_CHECKSUM=$(grep "$BINARY" "$TMP_CHECKSUM" | awk '{print $1}')
    if [ -n "$EXPECTED_CHECKSUM" ]; then
        echo -e "${BLUE}Verifying checksum...${NC}"
        # Calculate actual checksum
        if command -v sha256sum &> /dev/null; then
            ACTUAL_CHECKSUM=$(sha256sum "$TMP_FILE" | awk '{print $1}')
        elif command -v shasum &> /dev/null; then
            ACTUAL_CHECKSUM=$(shasum -a 256 "$TMP_FILE" | awk '{print $1}')
        else
            echo -e "${YELLOW}Warning: Could not verify checksum (no sha256sum/shasum found)${NC}"
            ACTUAL_CHECKSUM=""
        fi

        if [ -n "$ACTUAL_CHECKSUM" ]; then
            if [ "$EXPECTED_CHECKSUM" != "$ACTUAL_CHECKSUM" ]; then
                echo -e "${RED}Checksum verification failed!${NC}"
                echo "Expected: $EXPECTED_CHECKSUM"
                echo "Actual: $ACTUAL_CHECKSUM"
                exit 1
            fi
            echo -e "${GREEN}✓${NC} Checksum verified"
        fi
    fi
fi

# Make executable
chmod +x "$TMP_FILE"

# Create install directory if needed
if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${BLUE}Creating $INSTALL_DIR...${NC}"
    mkdir -p "$INSTALL_DIR"
fi

# Install
echo -e "${BLUE}Installing...${NC}"
if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP_FILE" "$INSTALL_DIR/mcp-cli"
else
    echo -e "${YELLOW}Requires sudo to install to $INSTALL_DIR${NC}"
    sudo mv "$TMP_FILE" "$INSTALL_DIR/mcp-cli"
fi
TMP_FILE=""  # Clear so cleanup doesn't try to delete

# Success message
echo ""
echo -e "${GREEN}✓ mcp-cli installed successfully!${NC}"
echo ""

# Check if in PATH and show version
if command -v mcp-cli &> /dev/null; then
    mcp-cli --version
else
    # Not in PATH - show setup instructions
    echo -e "${YELLOW}Add mcp-cli to your PATH:${NC}"
    echo ""
    
    SHELL_NAME=$(basename "$SHELL")
    case "$SHELL_NAME" in
        bash)
            echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
            echo "  source ~/.bashrc"
            ;;
        zsh)
            echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
            echo "  source ~/.zshrc"
            ;;
        fish)
            echo "  fish_add_path ~/.local/bin"
            ;;
        *)
            echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
            ;;
    esac
    echo ""
fi

echo "Get started:"
echo "  mcp-cli --help"
echo ""
