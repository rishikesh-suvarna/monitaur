#!/bin/bash

# Monitaur Agent Installer
# Usage: curl -sSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/main/install.sh | sudo bash
# Or with version: curl -sSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/main/install.sh | sudo bash -s v1.0.0

set -e

# Configuration
REPO="rishikesh-suvarna/monitaur"
VERSION=${1:-"latest"}
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/monitaur"
SERVICE_DIR="/etc/systemd/system"

echo "🚀 Installing Monitaur Agent..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "❌ Please run as root (use sudo)"
    exit 1
fi

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "❌ Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case $OS in
    linux) ;;
    darwin) echo "⚠️  macOS detected. Please download manually from GitHub releases."; exit 1 ;;
    *) echo "❌ Unsupported OS: $OS"; exit 1 ;;
esac

echo "📦 Detected: $OS/$ARCH"

# Get latest version if not specified
if [ "$VERSION" = "latest" ]; then
    echo "🔍 Getting latest version..."
    VERSION=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$VERSION" ]; then
        echo "❌ Could not get latest version. Please specify a version."
        exit 1
    fi
fi

echo "📥 Installing version: $VERSION"

# Download URL
FILENAME="monitaur-agent_${VERSION}_${OS}_${ARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$FILENAME"

echo "⬇️  Downloading from GitHub releases..."
if ! curl -sSL -f -o "/tmp/$FILENAME" "$DOWNLOAD_URL"; then
    echo "❌ Failed to download $DOWNLOAD_URL"
    echo "   Please check if the version exists: https://github.com/$REPO/releases"
    exit 1
fi

# Extract
echo "📦 Extracting..."
cd /tmp
tar -xzf "$FILENAME"

# Install binary
echo "📋 Installing binary..."
EXTRACTED_DIR="monitaur-agent_${VERSION}_${OS}_${ARCH}"
if [ ! -f "$EXTRACTED_DIR/monitaur-agent" ]; then
    echo "❌ Binary not found in archive"
    exit 1
fi

cp "$EXTRACTED_DIR/monitaur-agent" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/monitaur-agent"

# Create config directory
echo "⚙️  Setting up configuration..."
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
    if [ -f "$EXTRACTED_DIR/config.json.example" ]; then
        cp "$EXTRACTED_DIR/config.json.example" "$CONFIG_DIR/config.json"
        echo "✅ Created config template at $CONFIG_DIR/config.json"
    else
        # Create default config if example doesn't exist
        cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "token": "your-server-token-here",
  "api_endpoint": "wss://your-domain.com/agent/connect",
  "collection_interval": 5,
  "server_name": "",
  "alert_thresholds": {
    "cpu": 80,
    "memory": 85,
    "disk": 90
  }
}
EOF
        echo "✅ Created default config at $CONFIG_DIR/config.json"
    fi
else
    echo "⚠️  Config already exists at $CONFIG_DIR/config.json"
fi

# Create systemd service
echo "🔧 Installing systemd service..."
cat > "$SERVICE_DIR/monitaur-agent.service" << 'EOF'
[Unit]
Description=Monitaur Server Monitoring Agent
After=network.target

[Service]
Type=simple
User=monitaur
WorkingDirectory=/etc/monitaur
ExecStart=/usr/local/bin/monitaur-agent
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Create user for service
echo "👤 Creating service user..."
if ! id "monitaur" &>/dev/null; then
    useradd -r -s /bin/false monitaur
    echo "✅ Created user 'monitaur'"
else
    echo "⚠️  User 'monitaur' already exists"
fi

chown -R monitaur:monitaur "$CONFIG_DIR"

# Reload systemd
systemctl daemon-reload

# Cleanup
rm -rf "/tmp/$FILENAME" "/tmp/$EXTRACTED_DIR"

# Verify installation
if monitaur-agent -version &>/dev/null; then
    INSTALLED_VERSION=$(monitaur-agent -version 2>/dev/null | head -n1)
    echo "✅ $INSTALLED_VERSION installed successfully!"
else
    echo "⚠️  Installation completed but version check failed"
fi

echo ""
echo "📝 Next steps:"
echo "1. Edit configuration: sudo nano $CONFIG_DIR/config.json"
echo "2. Add your server token from the Monitaur dashboard"
echo "3. Start the service: sudo systemctl start monitaur-agent"
echo "4. Enable auto-start: sudo systemctl enable monitaur-agent"
echo "5. Check status: sudo systemctl status monitaur-agent"
echo ""
echo "📊 View logs: sudo journalctl -u monitaur-agent -f"
echo "🔧 Test config: sudo -u monitaur monitaur-agent -help"
echo "📋 GitHub: https://github.com/$REPO"
echo ""
echo "🎉 Happy monitoring!"
