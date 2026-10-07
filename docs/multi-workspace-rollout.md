# Multi-workspace rollout

## Current release: authorization and additive foundation

Organizations continue to own billing, subscriptions and their member directory.
The new `workspaces` table represents a child operational boundary. Initial
workspace IDs equal their organization IDs so historical data and vector
collections keep their existing identifiers. `workspace_members` stores child
assignments and uses composite foreign keys to reject cross-organization links.

The frontend accepts `workspaceId` and `workspace` from `/api/auth/workspaces`,
retaining compatibility with legacy responses. Requests carry both
`X-Organization-Id` and `X-Workspace-Id`. Each tab retains its own selection;
CRM caches are partitioned by identity, organization and workspace. Workspace
access is checked before permissions and operational data load.

**Additional workspaces and sharing are disabled.** The middleware rejects any
workspace ID other than the organization's initial workspace. Existing
operational tables still use organization scope. This release does not claim
isolation between multiple workspaces within an organization.

## Migration rules

- `schema_migrations` records ordered IDs, checksums and completion timestamps.
- The previous schema bootstrap runs once as `2026100700_legacy_baseline`.
- `2026100701_workspace_foundation` adds tables, constraints and default rows.
- The same connection holds the existing MySQL advisory lock throughout.
- MySQL DDL is not transactional. Migration steps must be retry-safe, and a
  migration is recorded only after every step succeeds.
- Never change an applied migration. Add an ordered migration for future
  changes, including changes to the adapter's table definitions. Editing only
  `TABLES` no longer changes an existing database.
- New organization setup creates its initial workspace and administrator
  assignment inside the organization setup transaction.
- Legacy organization/member import paths are reconciled when listing access.
- Team sync updates retained member rows in place, preserving child assignments.

## Deploy on the existing VM

```bash
cd ~/crm-backend-test && git pull --ff-only origin main && ./deploy.sh --prod --pull --build --application-services --backup-db --migrate --trace
```

This builds the application services sequentially, saves a MySQL dump under
`.git/chiefvoice-db-backups` with owner-only permissions, runs migrations using
the API image, replaces API/scheduler/callback-scheduler/retention-worker, checks
`/ready`, checks selected containers are running and prints recent logs.
Database volumes are retained. A failed dump or migration stops the rollout.
The backup covers MySQL; external recordings/vector data are not included.
Copy backups off the VM using your existing backup process.

For an already deployed commit, builds and restarts are skipped. With
`--migrate`, the existing image still runs its idempotent migration check.
Each service group has its own deployment marker.

Force a rebuild/replacement of all application services:

```bash
./deploy.sh --prod --pull --build --application-services --backup-db --migrate --force-recreate --trace
```

Rebuild/recreate only the API after an API-only change:

```bash
./deploy.sh --prod --pull --build --service app --force-recreate --trace
```

Follow application logs without rebuilding:

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.caddy.yml logs -f --tail=200 app scheduler callback-scheduler retention-worker
```

Readiness covers database schema completion and queue connectivity. Running
worker containers are checked, but this is not an end-to-end test of a call or
scheduled job. The first migration can take longer because it imports the
previous bootstrap. Keep the VM's MySQL configuration and backups available.

## Remaining implementation order

1. Add workspace scope to every operational table, indexes and relationships.
2. Scope all repositories, raw SQL, bulk writes and object-engine queries.
3. Carry validated scope through calls, number routing, AI/vector collections,
   queues, schedulers, retention, storage, SSE and voice tickets.
4. Introduce organization and workspace permissions; enforce assignments and
   active membership on every operation. Billing access does not grant CRM access.
5. Add workspace provisioning/settings/member management and workspace industry
   configuration to both backend and frontend. Enable additional workspaces only
   after the operational-scope audit is complete.
6. Add explicit same-organization read-sharing grants, expiry/revocation, a
   separate shared list and an allowlist of visible fields.
7. Add restricted editing with versions, mapped copies/transfers, recruitment
   workflows and scaling improvements (outbox/idempotency/pagination).

The additive foundation can coexist with the old application. Once independent
workspace data exists, rollback to an organization-only backend is forbidden.
