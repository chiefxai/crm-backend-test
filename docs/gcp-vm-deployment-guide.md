# Deploy ChiefVoice CRM to a GCP VM

This is an operator guide for the current repository layout. It describes deployment commands; it does **not** authorize a production release, subscription feature activation, or any billing action.

## What the repositories currently provide

- The backend has a production Docker Compose stack in `docker-compose.yml` plus `docker-compose.caddy.yml`. It runs the API, local MySQL, Redis, ChromaDB, RabbitMQ, scheduler, callback scheduler, retention worker, and Caddy. Caddy binds ports 80/443; the API is exposed at host port `APP_HOST_PORT` (default 3000). The Compose MySQL volume is local to the VM.
- `deploy.sh --prod` uses `.env`, checks Compose configuration and workspace scope, and probes API readiness at `http://127.0.0.1:3000/ready`. `--backup-db` creates a private SQL dump in the git metadata directory; `--migrate` runs `node scripts/migrate.js`. Both options can be combined.
- `/health` is a basic process response. `/ready` checks database and queue readiness. The readiness probe in `deploy.sh` assumes the API is published on host port 3000; if `APP_HOST_PORT` differs, the script's probe may not work as written.
- The frontend is a separate Vite application. `npm run build` creates `dist/`. Its README describes independent static hosting; no VM web-server deployment, Nginx configuration, CI/CD pipeline, or DNS setup is checked in.
- The subscription lifecycle operations runbook says this work is not production-ready. In particular, upgrade payment/apply flow, historical organization reconciliation, access-path coverage, integration evidence, and release operations remain incomplete. Keep lifecycle flags off unless those release gates are separately closed and approved.

## GCP-specific assumptions to confirm

The commands below assume a Linux Compute Engine VM with Docker Engine and the Compose v2 plugin installed, a reserved external IP, a DNS name pointed at that IP, inbound TCP 80/443 allowed by the VPC firewall, and enough disk/RAM for all Compose services. Those are deployment assumptions, not verified GCP configuration. Confirm the actual VM OS, SSH user, repository paths, domain, firewall, disk capacity, current database location, and frontend hosting choice before use.

The checked-in Compose file currently starts MySQL on the VM; `.env.production.example` also contains comments referring to Amazon RDS. Choose the intended database architecture and reconcile the environment before deployment. Do not assume the sample file is safe to use as production secrets. Use Secret Manager or another approved secret store, restrict `.env` permissions, and rotate any real credentials that have ever been committed or shared.

## One-time VM setup

Install a supported Docker Engine and Docker Compose v2 using Docker's official instructions for the VM's Linux distribution. Create a non-root deploy account with access to Docker, configure SSH access, and enable automatic security updates according to your operations policy. Reserve a static external IP and point the API DNS name (`DOMAIN` / `API_DOMAIN`) at it. Allow only the required ingress ports; do not expose MySQL, Redis, RabbitMQ, or ChromaDB publicly. Configure a VM snapshot/backup policy and test restore before relying on the local Compose MySQL volume.

Clone both repositories into stable paths, for example:

```sh
sudo install -d -o "$USER" -g "$USER" /opt/chiefvoice
cd /opt/chiefvoice
git clone <backend-repository-url> crm-backend-test
git clone <frontend-repository-url> com-frontend-test
```

Populate `/opt/chiefvoice/crm-backend-test/.env` from a secure source. Use the backend `.env.production.example` as a variable checklist only. Set at minimum the real domain and CORS origin, database credentials, RabbitMQ credentials, Cognito configuration, storage credentials, encryption/signing keys, and integrations actually used by the deployment. Generate fresh random secrets where required (for example `openssl rand -hex 32`). Never put backend secrets in the frontend environment. Set permissions such as `chmod 600 .env` and ensure the file is excluded from backups/log outputs that are accessible to ordinary users.

Review the effective Compose configuration without printing secret values into tickets or chat:

```sh
cd /opt/chiefvoice/crm-backend-test
./deploy.sh --prod --dry-run
```

## Initial backend deployment

Review the exact commit and check available disk space before building. The initial stack deployment builds all Compose services and starts the dependencies:

```sh
cd /opt/chiefvoice/crm-backend-test
git status --short
git rev-parse HEAD
df -h
./deploy.sh --prod --build --all-services
```

Then verify status and readiness:

```sh
docker compose --env-file .env -f docker-compose.yml -f docker-compose.caddy.yml ps
curl --fail --show-error https://<api-domain>/health
curl --fail --show-error https://<api-domain>/ready
```

The API Compose port must match the script's hard-coded `127.0.0.1:3000/ready` check. If that port is occupied, resolve the conflict before rollout; the script reports `APP_HOST_PORT=3001` as an option but its internal readiness probe currently needs to be adjusted to use that port. Check Caddy certificate issuance, backend logs, scheduler status, MySQL/RabbitMQ health, DNS, and the external firewall before opening the app to users.

## Frontend build and hosting

Set the production Cognito public configuration, redirect URLs, API URL, and `VITE_APP_ENV` in the frontend's production environment file. `VITE_*` values are embedded into browser assets and must contain public configuration only. Then build and run the frontend tests:

```sh
cd /opt/chiefvoice/com-frontend-test
cp .env.production.example .env.production
# Edit .env.production with the production Cognito values and https://<api-domain>.
npm ci
npm test
npm run build
```

The verified project output is `dist/`. The repository does not configure static serving on the backend VM. Prefer the frontend's documented static host and point it at the frontend repository with build command `npm run build` and output directory `dist`. If hosting on this VM is a requirement, provision and secure a static web server separately (for example Nginx), configure SPA route fallback to `index.html`, HTTPS, and deployment/rollback of the `dist/` directory; do not assume the backend's Caddy configuration serves the SPA. Update Cognito allowed callback/sign-out URLs and backend `ALLOWED_ORIGINS` to the exact deployed domains.

## Updating an existing backend

Before changing code or schema, record the deployed commit and make an off-VM database backup if the database is important. The script's backup is local to the VM's git metadata path, so copy it to approved durable storage and verify it is non-empty. A normal no-schema deployment can use:

```sh
cd /opt/chiefvoice/crm-backend-test
git status --short
git rev-parse HEAD > /tmp/chiefvoice-previous-commit
./deploy.sh --prod --pull --build --application-services
```

For a release that includes reviewed migrations, take and verify a backup, then run the gated migration deployment:

```sh
./deploy.sh --prod --pull --build --application-services --backup-db --migrate
```

This command creates a local SQL backup and then applies registered migrations before restarting the application services. Before using it, confirm the dump was copied off-VM and a restore was rehearsed. MySQL DDL may not be transactionally reversible; application rollback does not undo schema/data changes. Use a reviewed forward fix for migration problems, and do not drop tables or manually edit financial state. The deploy script's `--application-services` targets app, scheduler, callback-scheduler, and retention-worker, and does not rebuild Caddy or data services.

After deployment:

```sh
docker compose --env-file .env -f docker-compose.yml -f docker-compose.caddy.yml ps
curl --fail --show-error https://<api-domain>/ready
docker compose --env-file .env -f docker-compose.yml -f docker-compose.caddy.yml logs --tail=200 app scheduler callback-scheduler retention-worker
```

Also verify frontend login, API CORS, representative read/write flows, background jobs, uploads/object storage, and the logs/alerts required by the service. `/ready` only establishes database and queue readiness; it is not a complete end-to-end release check.

## Rollback and recovery

If the new application is unhealthy, stop further rollout and preserve logs. For an application-only rollback with no incompatible migration, check out the recorded previous commit and rebuild/restart the same service set using the repo script (`./deploy.sh --prod --build --application-services`). Confirm Compose and readiness checks before declaring recovery. Store the old and new commit IDs in the incident record. If the frontend was also updated, restore the previous frontend `dist/` artifact or redeploy its prior static-host release.

If a migration ran, do not assume checking out old code reverses it. Follow the migration-specific recovery plan, preserve the SQL backup, and use a reviewed forward fix or a rehearsed database restore with explicit data-loss assessment. Do not restore over live data without the incident owner's approval.

## Subscription lifecycle safety

The deployment process itself must not turn on financial processing or account enforcement. Keep subscription flags unset/false in production until the subscription lifecycle release blockers are resolved, the database migration and tenant classification plan are reviewed, staging integration/recovery tests pass, notification delivery and alerts are supervised, and the release owner explicitly approves the rollout. The upgrade preview is quote-only in the current implementation. See [billing-subscription-lifecycle-operations.md](billing-subscription-lifecycle-operations.md) for the current blockers and exact flag meanings. Do not enable flags by copying sample values or as part of a generic deployment.

## Details needed to tailor this runbook

To turn the placeholders into exact commands, confirm: GCE VM OS and SSH username; VM hostname/static IP and DNS names; whether MySQL is VM-local Compose or an external managed database; repository clone paths and release branch/tag; frontend static-host choice (or whether it must run on this VM); actual secret-management method; and whether this is staging or production. No VM access, SSH, infrastructure changes, or deployment were performed while preparing this guide.
