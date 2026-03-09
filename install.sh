#!/bin/bash
# Install script for mcp-cli
# Usage: curl -fsSL https://raw.githubusercontent.com/philschmid/mcp-cli/main/install.sh | bash
# Optional: set INSTALL_DIR to override the target install directory

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


require_sudo() {
    if ! command -v sudo &> /dev/null; then
        echo -e "${RED}sudo is required for writing to $INSTALL_DIR but is not installed.${NC}"
        echo "Set INSTALL_DIR to a writable path (e.g. INSTALL_DIR=$HOME/.local/bin) and retry."
        exit 1
    fi
}

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
    linux)
        case "$ARCH" in
            x86_64|amd64|x64)
                BINARY_CANDIDATES=("mcp-cli-linux-x64")
                ;;
            aarch64|arm64)
                BINARY_CANDIDATES=("mcp-cli-linux-arm64" "mcp-cli-linux-aarch64")
                ;;
            *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
        esac
        ;;
    darwin)
        case "$ARCH" in
            x86_64|amd64|x64) BINARY_CANDIDATES=("mcp-cli-darwin-x64") ;;
            arm64|aarch64) BINARY_CANDIDATES=("mcp-cli-darwin-arm64") ;;
            *) echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
        esac
        ;;
    *)
        echo -e "${RED}Unsupported OS: $OS${NC}"
        exit 1
        ;;
esac

# Local build fallback command/output by platform
case "$OS" in
    linux)
        BUILD_CMD="bun run build:linux-arm"
        BUILD_OUTPUT="dist/mcp-cli-linux-arm64"
        ;;
    darwin)
        BUILD_CMD="bun run build:macos-arm"
        BUILD_OUTPUT="dist/mcp-cli-darwin-arm64"
        ;;
    *)
        BUILD_CMD="bun run build"
        BUILD_OUTPUT="dist/mcp-cli"
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
echo -e "  ${BOLD}Binary${NC}:    auto (${BINARY_CANDIDATES[*]})"
echo -e "  ${BOLD}Location${NC}:  $INSTALL_DIR/mcp-cli"
echo -e "  ${BOLD}Source${NC}:    https://github.com/$GITHUB_REPO/releases/latest"
echo ""

# Check for existing installation
if command -v mcp-cli &> /dev/null; then
    EXISTING_VERSION=$(mcp-cli --version 2>/dev/null || echo "unknown")
    echo -e "${YELLOW}Note: Updating existing installation ($EXISTING_VERSION)${NC}"
    echo ""
fi

# Get latest release URL
CHECKSUM_URL="https://github.com/$GITHUB_REPO/releases/latest/download/checksums.txt"

# Dependency check
if ! command -v curl &> /dev/null; then
    echo -e "${RED}curl is required but not installed.${NC}"
    case "$OS" in
        darwin)
            echo "Install hint: brew install curl"
            ;;
        linux)
            echo "Install hint: use your distro package manager (e.g. apt, dnf/yum, pacman, apk) to install curl"
            ;;
    esac
    echo "Please install curl and retry."
    exit 1
fi

# Download binary (with architecture fallback candidates)
echo -e "${BLUE}Downloading release assets from GitHub...${NC}"
if [ ${#BINARY_CANDIDATES[@]} -gt 1 ]; then
    echo "Candidate binaries: ${BINARY_CANDIDATES[*]}"
fi

TMP_FILE=$(mktemp)
BINARY=""
for candidate in "${BINARY_CANDIDATES[@]}"; do
    DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/latest/download/$candidate"
    if curl --retry 3 --connect-timeout 10 -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"; then
        BINARY="$candidate"
        break
    fi
done

if [ -z "$BINARY" ]; then
    echo -e "${RED}Failed to download a binary for $OS/$ARCH.${NC}"
    echo "Checked candidates: ${BINARY_CANDIDATES[*]}"
    echo ""
    echo "The latest release may not include this architecture yet."
    echo "Release page: https://github.com/$GITHUB_REPO/releases"
    echo ""
    echo "Workaround (build locally with Bun):"
    if ! command -v bun &> /dev/null; then
        echo "  # Bun is not installed. Install it first: https://bun.sh"
    fi
    echo "  git clone https://github.com/$GITHUB_REPO.git"
    echo "  cd mcp-cli"
    echo "  bun install"
    echo "  $BUILD_CMD"
    echo "  mkdir -p "$INSTALL_DIR""
    if [ -w "$INSTALL_DIR" ]; then
        echo "  cp $BUILD_OUTPUT "$INSTALL_DIR/mcp-cli""
    else
        echo "  sudo cp $BUILD_OUTPUT "$INSTALL_DIR/mcp-cli""
    fi
    echo "  export PATH="$INSTALL_DIR:\$PATH""
    exit 1
fi

echo -e "${GREEN}✓${NC} Selected binary: $BINARY"
echo "Download URL: $DOWNLOAD_URL"

# Verify checksum (if available)
TMP_CHECKSUM=$(mktemp)
if curl --retry 3 --connect-timeout 10 -fsSL "$CHECKSUM_URL" -o "$TMP_CHECKSUM" 2>/dev/null; then
    # Extract checksum for our binary
    EXPECTED_CHECKSUM=$(awk -v binary="$BINARY" '$2 == binary { print $1 }' "$TMP_CHECKSUM")
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
            echo "Checksum source: $CHECKSUM_URL"
        fi
    else
        echo -e "${YELLOW}Warning: No checksum entry found for $BINARY; skipping verification.${NC}"
        echo "Checksum source: $CHECKSUM_URL"
    fi
else
    echo -e "${YELLOW}Warning: Could not download checksums.txt; skipping checksum verification.${NC}"
    echo "Checksum source: $CHECKSUM_URL"
fi

# Make executable
chmod +x "$TMP_FILE"

# Create install directory if needed
if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${BLUE}Creating $INSTALL_DIR...${NC}"
    if [ -w "$(dirname "$INSTALL_DIR")" ]; then
        mkdir -p "$INSTALL_DIR"
    else
        echo -e "${YELLOW}Requires sudo to create $INSTALL_DIR${NC}"
        require_sudo
        sudo mkdir -p "$INSTALL_DIR"
    fi
fi

# Install
echo -e "${BLUE}Installing...${NC}"
if [ -w "$INSTALL_DIR" ]; then
    mv "$TMP_FILE" "$INSTALL_DIR/mcp-cli"
else
    echo -e "${YELLOW}Requires sudo to install to $INSTALL_DIR${NC}"
    require_sudo
    sudo mv "$TMP_FILE" "$INSTALL_DIR/mcp-cli"
fi
TMP_FILE=""  # Clear so cleanup doesn't try to delete

# Success message
echo ""
echo -e "${GREEN}✓ mcp-cli installed successfully!${NC}"
echo "Installed to: $INSTALL_DIR/mcp-cli"
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
echo "  mcp-cli --version"
echo ""
if ! command -v mcp-cli &> /dev/null; then
    echo -e "${YELLOW}Note:${NC} mcp-cli is not currently on PATH in this shell."
    echo "Add $INSTALL_DIR to your PATH or open a new shell session."
    echo ""
fi
