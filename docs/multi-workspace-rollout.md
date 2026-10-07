# Multi-workspace rollout

## Current release: operational scope, Vobiz lifecycle and workspace settings

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
workspace ID other than the organization's initial workspace. The API/query builder now applies organization and workspace scope, and the
operational tables have additive workspace columns. Role enforcement,
provisioning, remaining provider/callback audits and final schema contraction
remain unfinished. This release does not enable multiple workspaces per organization.

## Implemented in the isolation release

- Migration `2026100702_operational_workspace_scope` adds `workspace_id`, a
  composite scope index and a same-organization workspace foreign key to 30
  operational tables; existing rows are backfilled into the initial workspace.
- Nullable fields support mixed-version rollout. A NULL scope can be read only
  as the organization's initial workspace; it is never a child-workspace fallback.
- Authenticated requests establish an immutable asynchronous workspace context.
  Query builders capture this context before awaiting tokens/database readiness.
- Operational inserts assign scope; updates cannot reassign ownership. Upserts
  and bulk contact/number writes cannot steal another workspace's primary key.
- Bulk deletes, contact joins, campaign deletion impact/cleanup, loan reads,
  scheduled callbacks and retry claims include workspace predicates.
- Object fields, stages and records inherit scope. Record patch/delete also
  checks the requested object, closing the previous sibling-object mismatch.
- Relationship validation covers loans, workflows, number/agent links and agent
  knowledge selections. Bulk historical links may retain deleted targets but
  cannot point at an ID currently owned by another workspace.
- Queue envelopes persist workspace context across adapters/processes. Scanned
  task/retry rows retain their workspace before claims and enqueueing.
- SSE and browser voice tickets bind workspace IDs; SSE broadcasts filter both
  organization and workspace. Browser socket callbacks explicitly restore scope.
- Knowledge vector collections use `kb_<workspaceId>`; initial workspaces keep
  their old `kb_<orgId>` collections and organization-owned embedding credentials.
- Telephone ownership lookup rejects ambiguous owners. Legacy provider callers
  cannot route child-workspace numbers before the full lifecycle conversion.
- The frontend confirms session/response scope and rejects events from another
  workspace. Older backends remain compatible for initial workspaces only.

Billing, the wallet, member directory and platform configuration remain
organization-owned. System reads for global ownership validation are explicit
and cannot turn into unscoped writes. Trusted organization-wide maintenance
paths still need review before enabling independent workspaces.

Validation for this release: JavaScript syntax checks, diff checks and frontend
production build. No MySQL migration or end-to-end VM execution was performed.

## Implemented in the lifecycle/settings release

- Migration `2026100703_workspace_settings` adds workspace settings JSON.
  Voice configuration is read/written in the active workspace. Only the initial
  workspace can fall back to historical organization voice settings.
- `/api/settings/workspace` separates operational profile preferences from
  organization subscriptions, wallet and retention. The frontend uses this
  endpoint and falls back to the old route only for an initial workspace when
  the VM has not been upgraded yet. Industry/pipeline/persona reads use workspace
  metadata. Only profile fields are accepted by the workspace update endpoint.
- Vobiz signed media tokens include workspace ownership. Upgrade checks confirm
  the workspace and organization remain active before opening a media session.
  Socket and Gemini SDK callbacks and registered finalizers restore their scope.
- Webhooks resolve ownership before running hangup/fallback writes and prewarm.
  Provider-ID aliases cannot combine different workspace owners. Contact phone
  numbers are no longer treated as authoritative call aliases. Per-phone prompt
  and agent caches are partitioned by workspace; hangup requires matching scope.
- New child recording keys include organization/workspace IDs. Historical
  default recording keys are preserved. Signed-URL/storage policy audit remains.
- Organization retention applies its policy to each workspace sequentially,
  including suspended workspaces, and returns per-workspace plus aggregate counts.
  Fixed missing `.lt()` support in the database adapter.
- Organization backups include every workspace and assignment table, explicit
  workspace metadata and recording ownership. Fixed pool result handling, fail
  on table export errors and clean up temporary ZIP archives.

Syntax/diff checks and the frontend production build are used for this release.
MySQL migrations, live telephony and VM runtime execution are not verified here.
Additional workspace creation and sharing remain disabled.

## Migration rules

- `schema_migrations` records ordered IDs, checksums and completion timestamps.
- The previous schema bootstrap runs once as `2026100700_legacy_baseline`.
- `2026100701_workspace_foundation` adds tables, constraints and default rows.
- `2026100702_operational_workspace_scope` expands operational table scope.
- `2026100703_workspace_settings` adds operational workspace preferences.
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

1. Finish the data-access audit, remove implicit system scans, migrate
   questionnaire/channel uniqueness to workspace keys and contract nullable scope
   columns only after legacy writers have been retired.
2. Finish signed-URL/storage policies, remaining provider/callback-service paths,
   durable call ownership and backup pagination/snapshot consistency. Vobiz
   context, workspace voice settings and per-workspace retention are implemented.
3. Confirm the migration and cross-workspace behavior against MySQL and the full
   application stack before allowing independent workspace data.
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
