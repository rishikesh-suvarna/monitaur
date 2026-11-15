# Monitaur - A Monitoring and Alerting System

Monitaur is a lightweight monitoring and alerting system designed to help you keep track of your applications and services. It provides real-time metrics, alerting capabilities, and a user-friendly interface for managing your monitoring needs.

## Features

- **Live fleet overview**: CPU, memory, disk and network for every server, streamed to the browser over SSE, with sparklines and a command palette (Cmd+K).
- **Alert rules**: "when CPU is above 90% for 5 min, raise critical", scoped to all servers, specific servers or tags, with cooldown, auto-resolve, acknowledgement and a 7-day preview. A server-down (missing heartbeat) rule is on by default.
- **Incidents, not alert spam**: a breach that lasts 40 minutes is one incident.
- **Notification channels**: email, Slack, Discord, Telegram and signed webhooks.
- **History**: 1 h to 30 days, downsampled server-side.
- **Public status pages** with 90-day uptime per service.
- **Teams**: organizations, roles, invites, plans and quotas.
- **Agent**: a single Go binary (Linux, macOS, Windows), outbound-only, installed as a systemd service.

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
  "token": "mt_live_... (shown once when you add the server)",
  "api_endpoint": "wss://your-monitaur-domain.com/agent/connect",
  "collection_interval": 10,
  "server_name": "my-production-server"
}
```

The backend can raise the interval to your plan's minimum. Alert thresholds now live in the dashboard (Alert rules); an `alert_thresholds` block in old configs is ignored by v2 backends.

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

- Go 1.24+
- Node.js 20+ and Yarn 1
- PostgreSQL 14+ (Neon works; any Postgres you can reach)
- A Firebase project (Authentication with Google and email/password)

### Backend

```bash
cd backend
go run . -init        # writes config.yaml; set database, firebase.project_id,
                      # secrets.encryption_key (openssl rand -base64 32), public URLs
go run .              # applies migrations on start, serves :8080
```

Every setting can be overridden with an environment variable, for example `MONITAUR_DATABASE_URL` or `MONITAUR_SECRETS_ENCRYPTION_KEY`.

Tests (DB tests need a Postgres where the user may create databases, and skip otherwise):

```bash
MONITAUR_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable" go test -race ./...
```

### Frontend

```bash
cd frontend
yarn install
yarn dev              # needs VITE_APP_SERVER_URL, VITE_APP_SERVER_WS_URL and VITE_FIREBASE_* in .env.development.local
yarn typecheck && yarn lint && yarn test && yarn build
```

### Agent

```bash
cd agent
go run . -init        # writes config.json (0600)
go run .
```

### Releases

Pushing a `vX.Y.Z` tag builds the agent for every platform and publishes the archives with a `SHA256SUMS` file, which `install.sh` verifies.

## Architecture

```
agents --wss--> ingest hub --> metrics store (in memory: raw + 1 min rings)
                     |                 |
                     |                 +--> every 30 min: one batched write of
                     |                      1 min / 1 h rollups to Postgres
                     +--> alert rules engine --> incidents --> email, Slack,
                                                              Discord, Telegram,
                                                              webhooks
browser --https--> REST API + SSE live stream --> in-memory directory (orgs,
                                                  servers, rules, channels)
```

Postgres is touched on a schedule and on user actions only, never per agent message or per dashboard poll, so a serverless database such as Neon can suspend between flushes. Design and budget: `PLAN.md` section 2.3.

Monitaur is multi-tenant: users belong to organizations with roles (owner, admin, member, viewer) and a plan with limits. Agent tokens are stored hashed and shown once.

## API

REST under `/api/v1` with a Firebase ID token (`Authorization: Bearer <token>`), the live stream at `GET /api/v1/stream` (Server-Sent Events), public status pages at `GET /api/v1/public/status/:slug`, and the agent WebSocket at `GET /agent/connect`. The full contract is in [docs/platform-v2.md](docs/platform-v2.md).

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
