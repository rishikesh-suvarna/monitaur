# Deploying platform v2

The runbook for shipping the open PRs. Each step needs access only you have (Neon, the VM, AWS SES, GitHub secrets), and merging to `main` deploys to production. Run the steps in order; each one is safe to stop after.

## 0. Before anything

```bash
gh pr list --state open      # expect #1 to #6 (plus the monitoring PR stacked on #6)
gh pr checks 5               # CI from #3 runs once #3 is merged; until then rely on the PR descriptions' local results
```

## 1. Neon restore point (required before #5)

Migration 00002 hashes agent tokens and clears the plaintext, so a v1 binary cannot run against the upgraded database. Take a restore point first:

```bash
# Neon CLI (npm i -g neonctl; neonctl auth)
neonctl branches create --project-id <project-id> --name pre-v2-$(date +%Y%m%d) --parent main
```

Or in the console: Branches, New branch, parent `main`, "Current point in time". Note the branch name.

## 2. Pipeline fixes (#2, #3) and agent client (#1, #4)

```bash
gh pr merge 2 --rebase          # backend deploys start installing the uploaded binary; redeploys today's code
gh run watch                    # expect "Deployed: <sha256>" in the install step
gh pr merge 3 --rebase          # frontend deploy, installer, release workflow, PR CI
gh pr merge 1 --rebase
gh pr edit 4 --base main && gh pr merge 4 --rebase
```

Optional host key pinning for deploys:

```bash
ssh-keyscan -t ed25519 <vm-host> 2>/dev/null | ssh-keygen -lf - | awk '{print $2}' | gh secret set HOST_FINGERPRINT
```

## 3. Backend v2 config on the VM (before merging #5)

Add to the backend's `config.yaml` (or the matching `MONITAUR_*` environment variables in the systemd unit):

```yaml
server:
  allow_origins: https://<dashboard-domain>        # comma-separated, never "*"
  release: true
public:
  app_url: https://<dashboard-domain>
  ingest_url: wss://<api-domain>/agent/connect
secrets:
  encryption_key: <output of: openssl rand -base64 32>   # keep it: channel configs are encrypted with it
smtp:
  host: <ses-smtp-endpoint>                         # no longer defaulted
  port: "587"
  username: <ses-smtp-username>
  password: <ses-smtp-password>
  from: alerts@<your-domain>
limits:
  default_plan: free                                # existing users are moved to the unlimited "legacy" plan
log:
  format: json
```

`metrics.journal_dir` defaults to `/var/lib/monitaur/journal`; the deploy from #2 creates it for the unit's user. `database.auto_migrate` defaults to true, so migrations run on start (they take well under a second; the v1 metrics backfill runs afterwards in the background).

## 4. Backend v2 and the dashboard (#5, then #6 immediately)

```bash
gh pr merge 5 --rebase && gh run watch          # backend deploy; health check must pass
gh pr edit 6 --base main && gh pr merge 6 --rebase && gh run watch   # the v1 dashboard cannot talk to v2
```

Then the monitoring additions PR (stacked on #6): retarget to `main` and merge the same way.

Check:

```bash
curl -fsS https://<api-domain>/health                       # {"status":"ok","agents_connected":N}
ssh <vm> 'sudo journalctl -u monitaur-backend -n 50 --no-pager'   # "migration applied", "seeded default rules", "agent connected"
```

Expected right after deploy: the seeded `host-unreachable` rule raises a critical incident for every server whose agent has been offline for more than 5 minutes.

## 5. Agent release

After #3 and #4 are on `main`:

```bash
git switch main && git pull
git tag v1.1.0 && git push origin v1.1.0        # builds every platform and publishes SHA256SUMS
```

Releases before this one have no `SHA256SUMS`, so the new installer refuses them. Upgrade hosts with the pinned installer:

```bash
curl -sSL https://raw.githubusercontent.com/rishikesh-suvarna/monitaur/v1.1.0/install.sh | sudo bash -s v1.1.0
```

## 6. Email (before opening public sign-up)

```bash
aws sesv2 create-email-identity --email-identity <your-domain>          # then add the 3 DKIM CNAMEs it returns
aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT
```

DNS: SPF `v=spf1 include:amazonses.com ~all` and DMARC `v=DMARC1; p=quarantine; rua=mailto:dmarc@<your-domain>`. Request SES production access if the account is still in the sandbox.

Firebase console: add the dashboard domain to Authentication, Settings, Authorized domains. Optionally enable App Check (reCAPTCHA Enterprise), set the `VITE_FIREBASE_APPCHECK_SITE_KEY` secret, then `firebase.require_app_check: true` on the backend.

## Rollback

- **Before #5:** revert the merge commit; deploys keep the previous binary as `/usr/local/bin/monitaur-backend.prev`.
- **After #5:** point `database.url` back at the Neon restore branch from step 1 (or restore it over `main`), then install the `.prev` binary and restart. Data written after the deploy is lost with the restore.
