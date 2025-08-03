# Monitaur - A Monitoring and Alerting System

Monitaur is a lightweight monitoring and alerting system designed to help you keep track of your applications and services. It provides real-time metrics, alerting capabilities, and a user-friendly interface for managing your monitoring needs.

MVP Features
Phase 1:

- Basic system metrics collection
- Simple web dashboard
- Email alerts
- User registration/auth

Phase 2:

- Custom metric collection
- Advanced alerting (Slack, webhooks)
- Historical data & trends
- Multi-server management

## Features

- 🔄 **Real-time monitoring** - CPU, Memory, Disk, Network metrics
- 📊 **Interactive dashboard** - Beautiful charts and statistics
- 🚨 **Smart alerts** - Configurable thresholds with notifications
- 🔗 **WebSocket streaming** - Low-latency data transmission
- 🖥️ **Multi-platform** - Linux, macOS, Windows support
- 🔧 **Easy deployment** - Single binary, systemd service
- 🔐 **Secure** - Firebase authentication, encrypted connections

## Quick Start

### Install Agent (Ubuntu/Debian)

```bash
curl -sSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/main/install.sh | sudo bash
```

### Manual Installation

1. **Download** the latest release for your platform:
   - [Linux (AMD64)](https://github.com/rishikesh-suvarna/monitaur/releases/latest/download/monitaur-agent_latest_linux_amd64.tar.gz)
   - [Linux (ARM64)](https://github.com/rishikesh-suvarna/monitaur/releases/latest/download/monitaur-agent_latest_linux_arm64.tar.gz)
   - [macOS (Intel)](https://github.com/rishikesh-suvarna/monitaur/releases/latest/download/monitaur-agent_latest_darwin_amd64.tar.gz)
   - [macOS (Apple Silicon)](https://github.com/rishikesh-suvarna/monitaur/releases/latest/download/monitaur-agent_latest_darwin_arm64.tar.gz)
   - [Windows](https://github.com/rishikesh-suvarna/monitaur/releases/latest/download/monitaur-agent_latest_windows_amd64.zip)

2. **Extract and install**:
   ```bash
   tar -xzf monitaur-agent_*.tar.gz
   cd monitaur-agent_*
   sudo ./install.sh  # Linux only
   ```

3. **Configure**:
   ```bash
   sudo nano /etc/monitaur/config.json
   ```

4. **Start monitoring**:
   ```bash
   sudo systemctl start monitaur-agent
   sudo systemctl enable monitaur-agent
   ```

## Configuration

Edit `/etc/monitaur/config.json`:

```json
{
  "token": "your-server-token-from-dashboard",
  "api_endpoint": "wss://your-monitaur-domain.com/agent/connect",
  "collection_interval": 5,
  "server_name": "my-production-server",
  "alert_thresholds": {
    "cpu": 80,
    "memory": 85,
    "disk": 90
  }
}
```

Get your server token from the Monitaur dashboard by adding a new server.

## Dashboard

Access your monitoring dashboard at your Monitaur domain to:

- View real-time server metrics
- Monitor multiple servers from one place
- Set up custom alert thresholds
- Analyze historical performance data
- Manage server configurations

## Commands

```bash
# Show version
monitaur-agent -version

# Create sample config
monitaur-agent -init

# Show help
monitaur-agent -help

# Test configuration
sudo -u monitaur monitaur-agent
```

## Service Management (Linux)

```bash
# Start service
sudo systemctl start monitaur-agent

# Stop service
sudo systemctl stop monitaur-agent

# Enable auto-start
sudo systemctl enable monitaur-agent

# Check status
sudo systemctl status monitaur-agent

# View logs
sudo journalctl -u monitaur-agent -f

# Restart service
sudo systemctl restart monitaur-agent
```

## Development

### Prerequisites

- Go 1.21+
- Node.js 18+
- PostgreSQL
- Firebase project

### Backend Setup

```bash
cd backend
go mod download
cp config.yaml.example config.yaml
# Edit config.yaml with your settings
go run main.go -migrate
go run main.go
```

### Frontend Setup

```bash
cd frontend
npm install
# Update src/config/firebase.js with your Firebase config
npm run dev
```

### Agent Development

```bash
cd agent
go mod download
go run main.go -init
# Edit config.json
go run main.go
```

### Building Releases

The project uses GitHub Actions to automatically build and release binaries when you create a git tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Go Agents     │────│   Go Backend     │────│   PostgreSQL    │
│   (Servers)     │    │   + Firebase     │    │ + TimescaleDB   │
└─────────────────┘    │                  │    │                 │
                       │  - WebSocket     │    │ - Metrics       │
┌─────────────────┐    │  - REST API      │    │ - Users         │
│ React Frontend  │────│  - Authentication│    │ - Alerts        │
│ + Firebase Auth │    │                  │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## API

The backend provides a REST API for dashboard operations and WebSocket endpoints for real-time agent communication.

### Authentication

All API requests require a Firebase ID token:

```bash
curl -H "Authorization: Bearer <firebase-id-token>" \
     https://your-domain.com/api/v1/dashboard
```

### Endpoints

- `GET /api/v1/dashboard` - Dashboard summary
- `GET /api/v1/servers` - List servers
- `POST /api/v1/servers` - Create server
- `GET /api/v1/servers/:id/metrics` - Server metrics
- `WS /agent/connect` - Agent WebSocket connection

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- 📖 [Documentation](https://github.com/rishikesh-suvarna/monitaur/wiki)
- 🐛 [Bug Reports](https://github.com/rishikesh-suvarna/monitaur/issues)
- 💬 [Discussions](https://github.com/rishikesh-suvarna/monitaur/discussions)

---
