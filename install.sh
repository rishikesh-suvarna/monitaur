#!/bin/sh

# Monitaur Agent Installer
#
# Pin the script to the tag you install, so installer and binary match:
#   curl -fsSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/v1.2.3/install.sh | sudo bash -s v1.2.3
# Without a version argument it installs the latest release:
#   curl -fsSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/main/install.sh | sudo bash
#
# The archive is checked against the release's SHA256SUMS before it is
# extracted, and nothing downloaded runs before that check passes.

set -eu
# Everything this script creates is private unless a mode is given explicitly.
umask 077

REPO="rishikesh-suvarna/monitaur"
VERSION="${1:-latest}"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/monitaur"
SERVICE_DIR="/etc/systemd/system"
BINARY_NAME="monitaur-agent"
SERVICE_NAME="monitaur-agent"
SERVICE_USER="monitaur"
CHECKSUMS_FILE="SHA256SUMS"
VERSION_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# The case rejects anything but v, digits and dots (including newlines, which
# would let a line-based grep match only part of the value).
is_valid_version() {
    case "$1" in
        ''|*[!v0-9.]*) return 1 ;;
    esac
    printf '%s\n' "$1" | grep -Eq "$VERSION_PATTERN"
}

log "Installing Monitaur Agent..."

if [ "$(id -u)" -ne 0 ]; then
    die "please run as root (use sudo)"
fi

for cmd in curl tar sha256sum install systemctl useradd; do
    command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done

ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "unsupported architecture: $ARCH" ;;
esac

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
    linux) ;;
    darwin) die "macOS detected, please download manually from GitHub releases" ;;
    *) die "unsupported OS: $OS" ;;
esac

log "Detected: $OS/$ARCH"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Turn signals into a normal exit so the EXIT trap cleans up in every shell.
trap 'exit 1' HUP INT TERM

if [ "$VERSION" = "latest" ]; then
    log "Getting latest version..."
    curl -fsSL -o "$TMP/latest.json" "https://api.github.com/repos/$REPO/releases/latest" \
        || die "could not look up the latest release, please pass a version"
    VERSION="$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$TMP/latest.json" | head -n 1)"
fi

# Validate before the version goes into any URL or path.
is_valid_version "$VERSION" || die "invalid version, expected vMAJOR.MINOR.PATCH (for example v1.2.3)"

log "Installing version: $VERSION"

PACKAGE="${BINARY_NAME}_${VERSION}_${OS}_${ARCH}"
ARCHIVE="$PACKAGE.tar.gz"
BASE_URL="https://github.com/$REPO/releases/download/$VERSION"

log "Downloading $ARCHIVE..."
curl -fsSL -o "$TMP/$ARCHIVE" "$BASE_URL/$ARCHIVE" \
    || die "failed to download $BASE_URL/$ARCHIVE (check https://github.com/$REPO/releases)"
curl -fsSL -o "$TMP/$CHECKSUMS_FILE" "$BASE_URL/$CHECKSUMS_FILE" \
    || die "failed to download $CHECKSUMS_FILE for $VERSION (releases published before checksums cannot be verified)"

log "Verifying checksum..."
# Check only this archive's entry, and fail if the release does not list it.
awk -v f="$ARCHIVE" '$2 == f || $2 == ("*" f)' "$TMP/$CHECKSUMS_FILE" > "$TMP/$ARCHIVE.sha256"
[ -s "$TMP/$ARCHIVE.sha256" ] || die "$ARCHIVE is not listed in $CHECKSUMS_FILE"
(cd "$TMP" && sha256sum -c "$ARCHIVE.sha256") || die "checksum mismatch for $ARCHIVE, refusing to install"

log "Extracting..."
tar -xzf "$TMP/$ARCHIVE" -C "$TMP" --no-same-owner
SRC_DIR="$TMP/$PACKAGE"

# --- Shared install steps: identical in install.sh and in the package
# --- install.sh that .github/workflows/agent-release.yml generates.
[ -f "$SRC_DIR/$BINARY_NAME" ] || die "$BINARY_NAME not found in $SRC_DIR"

log "Creating service user..."
if id "$SERVICE_USER" >/dev/null 2>&1; then
    log "User '$SERVICE_USER' already exists"
else
    useradd -r -s /bin/false "$SERVICE_USER"
    log "Created user '$SERVICE_USER'"
fi

log "Installing binary..."
[ -d "$INSTALL_DIR" ] || install -d -m 0755 "$INSTALL_DIR"
# Write next to the target, then rename over it: a running agent keeps its
# old inode (no "text file busy") and the path never shows a partial file.
install -m 0755 "$SRC_DIR/$BINARY_NAME" "$INSTALL_DIR/.$BINARY_NAME.new"
mv -f "$INSTALL_DIR/.$BINARY_NAME.new" "$INSTALL_DIR/$BINARY_NAME"

log "Setting up configuration..."
# The config holds the server token: root owns it, the service user may only read it.
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
chown "root:$SERVICE_USER" "$CONFIG_DIR"
chmod 0750 "$CONFIG_DIR"
# CONFIG_DIR is root-owned, so the service user cannot plant files in it;
# refuse a symlink anyway rather than follow it as root.
if [ -L "$CONFIG_FILE" ]; then
    die "$CONFIG_FILE is a symlink, refusing to touch it"
fi
if [ -f "$CONFIG_FILE" ]; then
    log "Config already exists at $CONFIG_FILE"
else
    if [ -f "$SRC_DIR/config.json.example" ]; then
        cp "$SRC_DIR/config.json.example" "$TMP/config.json"
    else
        cat > "$TMP/config.json" << 'CONFIGEOF'
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
CONFIGEOF
    fi
    install -m 0640 -o root -g "$SERVICE_USER" "$TMP/config.json" "$CONFIG_FILE"
    log "Created config template at $CONFIG_FILE"
fi
# Also fixes ownership and mode of a config an older installer wrote.
chown "root:$SERVICE_USER" "$CONFIG_FILE"
chmod 0640 "$CONFIG_FILE"

log "Installing systemd service..."
cat > "$TMP/$SERVICE_NAME.service" << 'SERVICEEOF'
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
SERVICEEOF
install -m 0644 "$TMP/$SERVICE_NAME.service" "$SERVICE_DIR/$SERVICE_NAME.service"

systemctl daemon-reload
# Restarts only a unit that is already running: an upgrade picks up the new
# binary, a fresh install stays stopped until the config has a token.
systemctl try-restart "$SERVICE_NAME"

# Run the installed copy as the service user, the way systemd will.
if command -v runuser >/dev/null 2>&1 \
    && INSTALLED_VERSION="$(runuser -u "$SERVICE_USER" -- "$INSTALL_DIR/$BINARY_NAME" -version 2>/dev/null)"; then
    log "$INSTALLED_VERSION installed successfully!"
else
    log "Installed $BINARY_NAME to $INSTALL_DIR/$BINARY_NAME"
fi
# --- End of shared install steps.

log ""
log "Next steps:"
log "1. Edit configuration: sudo nano $CONFIG_DIR/config.json"
log "2. Add your server token from the Monitaur dashboard"
log "3. Start and enable the service: sudo systemctl enable --now $SERVICE_NAME"
log "4. Check status: sudo systemctl status $SERVICE_NAME"
log ""
log "View logs: sudo journalctl -u $SERVICE_NAME -f"
log "Test config: sudo -u $SERVICE_USER $BINARY_NAME -help"
log "GitHub: https://github.com/$REPO"
log ""
log "Happy monitoring!"
