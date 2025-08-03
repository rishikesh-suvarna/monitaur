#!/bin/bash

# Build script for Monitaur Agent
# Usage: ./scripts/build.sh [version]

set -e

VERSION=${1:-"1.0.0"}
APP_NAME="monitaur-agent"
BUILD_DIR="dist"
PLATFORMS=("linux/amd64" "linux/arm64" "darwin/amd64" "darwin/arm64" "windows/amd64")

echo "Building $APP_NAME version $VERSION..."

# Clean previous builds
rm -rf $BUILD_DIR
mkdir -p $BUILD_DIR

# Build for each platform
for platform in "${PLATFORMS[@]}"; do
    platform_split=(${platform//\// })
    GOOS=${platform_split[0]}
    GOARCH=${platform_split[1]}

    output_name=$APP_NAME
    if [ $GOOS = "windows" ]; then
        output_name+='.exe'
    fi

    output_path="$BUILD_DIR/${APP_NAME}_${VERSION}_${GOOS}_${GOARCH}"
    if [ $GOOS = "windows" ]; then
        output_path+='.exe'
    fi

    echo "Building for $GOOS/$GOARCH..."

    env GOOS=$GOOS GOARCH=$GOARCH go build \
        -ldflags="-s -w -X main.Version=$VERSION" \
        -o $output_path \
        .

    # Create platform-specific package
    pkg_dir="$BUILD_DIR/${APP_NAME}_${VERSION}_${GOOS}_${GOARCH}"
    mkdir -p $pkg_dir

    # Copy binary
    cp $output_path $pkg_dir/$output_name

    # Copy configuration template
    cp config.json.example $pkg_dir/config.json.example 2>/dev/null || true

    # Create install script for Linux/macOS
    if [ $GOOS != "windows" ]; then
        cat > $pkg_dir/install.sh << 'EOF'
#!/bin/bash
set -e

INSTALL_DIR="/usr/local/bin"
SERVICE_DIR="/etc/systemd/system"
CONFIG_DIR="/etc/monitaur"

echo "Installing Monitaur Agent..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

# Copy binary
cp monitaur-agent $INSTALL_DIR/
chmod +x $INSTALL_DIR/monitaur-agent

# Create config directory
mkdir -p $CONFIG_DIR
if [ ! -f $CONFIG_DIR/config.json ]; then
    cp config.json.example $CONFIG_DIR/config.json
    echo "Created config template at $CONFIG_DIR/config.json"
    echo "Please edit this file with your server token"
fi

# Create systemd service
cat > $SERVICE_DIR/monitaur-agent.service << 'SERVICEEOF'
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

[Install]
WantedBy=multi-user.target
SERVICEEOF

# Create user for service
useradd -r -s /bin/false monitaur 2>/dev/null || true
chown -R monitaur:monitaur $CONFIG_DIR

echo "Installation complete!"
echo ""
echo "Next steps:"
echo "1. Edit /etc/monitaur/config.json with your server token"
echo "2. Start the service: sudo systemctl start monitaur-agent"
echo "3. Enable auto-start: sudo systemctl enable monitaur-agent"
echo "4. Check status: sudo systemctl status monitaur-agent"
EOF
        chmod +x $pkg_dir/install.sh
    fi

    # Create README
    cat > $pkg_dir/README.md << EOF
# Monitaur Agent

Server monitoring agent for Monitaur.

## Installation

### Automatic Installation (Linux/macOS)
\`\`\`bash
sudo ./install.sh
\`\`\`

### Manual Installation
1. Copy the binary to your PATH:
   \`\`\`bash
   sudo cp monitaur-agent /usr/local/bin/
   sudo chmod +x /usr/local/bin/monitaur-agent
   \`\`\`

2. Create configuration:
   \`\`\`bash
   sudo mkdir -p /etc/monitaur
   sudo cp config.json.example /etc/monitaur/config.json
   \`\`\`

3. Edit configuration with your server token:
   \`\`\`bash
   sudo nano /etc/monitaur/config.json
   \`\`\`

4. Run the agent:
   \`\`\`bash
   monitaur-agent
   \`\`\`

## Configuration

Edit \`/etc/monitaur/config.json\`:

\`\`\`json
{
  "token": "your-server-token-here",
  "api_endpoint": "wss://your-domain.com/agent/connect",
  "collection_interval": 5,
  "server_name": "my-server",
  "alert_thresholds": {
    "cpu": 80,
    "memory": 85,
    "disk": 90
  }
}
\`\`\`

## Service Management (Linux)

\`\`\`bash
# Start service
sudo systemctl start monitaur-agent

# Enable auto-start
sudo systemctl enable monitaur-agent

# Check status
sudo systemctl status monitaur-agent

# View logs
sudo journalctl -u monitaur-agent -f
\`\`\`

## Version
$VERSION
EOF

    # Create archive
    if [ $GOOS = "windows" ]; then
        (cd $BUILD_DIR && zip -r ${APP_NAME}_${VERSION}_${GOOS}_${GOARCH}.zip $(basename $pkg_dir))
    else
        tar -czf $BUILD_DIR/${APP_NAME}_${VERSION}_${GOOS}_${GOARCH}.tar.gz -C $BUILD_DIR $(basename $pkg_dir)
    fi

    echo "✓ Built for $GOOS/$GOARCH"
done

echo ""
echo "Build complete! Files in $BUILD_DIR:"
ls -la $BUILD_DIR/

echo ""
echo "To create a release:"
echo "1. Upload archives to GitHub Releases"
echo "2. Update download URLs in documentation"
