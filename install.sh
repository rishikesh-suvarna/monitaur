#!/bin/bash
set -e

# Monitaur Agent Installer - Cross-platform Linux
REPO="rishikesh-suvarna/monitaur"
VERSION=${1:-"latest"}
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/monitaur"
SERVICE_DIR="/etc/systemd/system"

echo "🚀 Installing Monitaur Agent..."

# Must be root
if [ "$EUID" -ne 0 ]; then
    echo "❌ Please run as root (use sudo)"
    exit 1
fi

# Check dependencies
for cmd in curl tar grep uname id systemctl; do
    if ! command -v $cmd &>/dev/null; then
        echo "❌ Missing dependency: $cmd. Please install it and retry."
        exit 1
    fi
done

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "❌ Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
if [[ "$OS" != "linux" ]]; then
    echo "❌ Unsupported OS: $OS"
    exit 1
fi

echo "📦 Detected: $OS/$ARCH"

# Get latest version
if [ "$VERSION" = "latest" ]; then
    echo "🔍 Fetching latest version..."
    VERSION=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep -Po '"tag_name":\s*"\K[^"]+')
    if [ -z "$VERSION" ]; then
        echo "❌ Could not get latest version. Please specify a version."
        exit 1
    fi
fi

echo "📥 Installing version: $VERSION"

# Download binary
FILENAME="monitaur-agent_${VERSION}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/$REPO/releases/download/$VERSION/$FILENAME"

echo "⬇️  Downloading from $URL..."
if ! curl -sSL -f -o "/tmp/$FILENAME" "$URL"; then
    echo "❌ Failed to download binary. Check version/architecture."
    exit 1
fi

# Extract
echo "📦 Extracting..."
cd /tmp
tar -xzf "$FILENAME"

EXTRACTED_DIR="monitaur-agent_${VERSION}_${OS}_${ARCH}"
if [ ! -f "$EXTRACTED_DIR/monitaur-agent" ]; then
    echo "❌ Binary not found in extracted archive"
    exit 1
fi

# Install binary
echo "📋 Installing binary..."
cp "$EXTRACTED_DIR/monitaur-agent" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/monitaur-agent"

# Config
echo "⚙️  Setting up configuration..."
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
    if [ -f "$EXTRACTED_DIR/config.json.example" ]; then
        cp "$EXTRACTED_DIR/config.json.example" "$CONFIG_DIR/config.json"
    else
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
    fi
    echo "✅ Config created at $CONFIG_DIR/config.json"
else
    echo "⚠️  Config already exists at $CONFIG_DIR/config.json"
fi

# Create service user (compatible across distros)
echo "👤 Creating service user..."
if ! id "monitaur" &>/dev/null; then
    NOLOGIN_SHELL=$(command -v nologin || command -v false)
    useradd -r -s "$NOLOGIN_SHELL" monitaur
    echo "✅ Created user 'monitaur'"
else
    echo "⚠️  User 'monitaur' already exists"
fi
chown -R monitaur:monitaur "$CONFIG_DIR"

# Systemd service
if command -v systemctl &>/dev/null; then
    echo "🔧 Installing systemd service..."
    cat > "$SERVICE_DIR/monitaur-agent.service" << EOF
[Unit]
Description=Monitaur Server Monitoring Agent
After=network.target

[Service]
Type=simple
User=monitaur
WorkingDirectory=$CONFIG_DIR
ExecStart=$INSTALL_DIR/monitaur-agent
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
else
    echo "⚠️  Systemd not found. You will need to run the binary manually."
fi

# Cleanup
rm -rf "/tmp/$FILENAME" "/tmp/$EXTRACTED_DIR"

# Verify
if monitaur-agent -version &>/dev/null; then
    echo "✅ $(monitaur-agent -version) installed successfully!"
else
    echo "⚠️  Installation completed but version check failed."
fi

echo ""
echo "📝 Next steps:"
echo "1. Edit configuration: sudo nano $CONFIG_DIR/config.json"
echo "2. Add your server token from the Monitaur dashboard"
if command -v systemctl &>/dev/null; then
    echo "3. Start: sudo systemctl start monitaur-agent"
    echo "4. Enable on boot: sudo systemctl enable monitaur-agent"
    echo "5. Check status: sudo systemctl status monitaur-agent"
fi
echo ""
