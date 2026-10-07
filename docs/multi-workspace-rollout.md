# Multi-workspace rollout

## Current release: organization and workspace role enforcement

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
operational tables have additive workspace columns. Workspace provisioning/member management,
remaining provider/callback audits and final schema contraction
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
- Vobiz can recover an active outbound campaign call's workspace after an API
  restart from the exact provider Call ID stored on its workspace-scoped task;
  ambiguous owner matches are rejected before callback processing.
- Meta WhatsApp and Instagram callbacks resolve their channel by provider ID,
  then run conversation, message, and AI-context work in that channel's stored
  workspace. Cross-tenant provider ownership checks are explicit read-only scans.
- Webhooks resolve ownership before running hangup/fallback writes and prewarm.
  Provider-ID aliases cannot combine different workspace owners. Contact phone
  numbers are no longer treated as authoritative call aliases. Per-phone prompt
  and agent caches are partitioned by workspace; hangup requires matching scope.
- New child recording keys include organization/workspace IDs. Historical
  default recording keys are preserved. Signed-URL/storage policy audit remains.
- Recording playback now checks known object keys against the active workspace
  before signing or returning them. The legacy default workspace can resolve
  only root-level `recordings/<file>` keys; child workspaces require their
  organization/workspace path. External provider URLs remain provider-managed.
- Organization retention applies its policy to each workspace sequentially,
  including suspended workspaces, and returns per-workspace plus aggregate counts.
  Fixed missing `.lt()` support in the database adapter.
- Organization backups include every workspace and assignment table, explicit
  workspace metadata and recording ownership. Fixed pool result handling, fail
  on table export errors and clean up temporary ZIP archives.

Syntax/diff checks and the frontend production build are used for this release.
MySQL migrations, live telephony and VM runtime execution are not verified here.
Additional workspace creation and sharing remain disabled.

## Role enforcement release

Permission policy lives in `src/authorization/policy.js`. Feature entitlements
remain a separate check; a feature flag is never an authorization grant.

| Scope | Role | Permissions |
| --- | --- | --- |
| Platform | Super Admin identity | Platform administration and explicit customer support access |
| Organization | Owner / Organization Admin | Organization profile, member directory/management, billing |
| Organization | Billing Admin | Organization metadata and billing; no implicit CRM access |
| Organization | Member | No organization administration |
| Workspace | Workspace Admin | Operational data, calls, deletion, workspace settings, audit |
| Workspace | Manager | Operational read/write/deletion and calls |
| Workspace | Member | Operational read/write and calls; no deletion or settings administration |
| Workspace | Viewer | Operational reads only |

- Every authenticated customer request resolves organization membership and
  active workspace assignment, then passes a central permission boundary. Role
  names in organization rows cannot grant platform authority.
- Existing initial-workspace assignments are explicitly marked as legacy.
  Their effective role follows the current legacy team role so demotions take
  effect immediately. Future explicit workspace roles use `role_source=manual`.
- Migration `2026100704_workspace_role_authority` adds that source marker and an
  organization-member initialization flag. Deleted/revoked assignments are not
  regenerated by subsequent sign-ins. Newly imported legacy memberships can
  receive their initial assignment exactly once. Billing-only legacy grants
  are deactivated.
- Migration `2026100705_workspace_configuration_keys` changes questionnaire
  identity and channel-type uniqueness to include the workspace. Provider
  external IDs remain globally unique so inbound calls still resolve to one
  workspace owner.
- Settings, channels/agents/knowledge administration, operational deletion,
  billing and organization member management use separate permission guards.
  Legacy generic sync from a Member upserts submitted rows without deleting
  omitted records; destructive replacement requires workspace deletion access.
- Team CRUD and bulk import cannot promote or remove privileged organization
  memberships through a less privileged role. Customer organization settings
  cannot overwrite platform-controlled flags, billing values or subscription.
- Auth/session responses contain role scopes and a server permission list.
  Organization metadata and workspace profile responses exclude unrelated
  organization secrets. Billing-only access does not load operational data.
- SSE tickets and browser voice upgrades revalidate access against current DB
  state. Open event streams and browser voice sessions recheck every 30 seconds;
  revocation therefore has a bounded delay for existing connections. Cleanup
  and already-dispatched telephony work can finish; this is not cancellation of
  all queued jobs. Trusted internal-service authentication is separate and its
  workspace scope audit remains in the rollout checklist.
- Frontend navigation, page access, privileged actions and automatic sync use
  server permissions; Viewers receive a read-only notice and cannot submit
  writes through the API client or server. Billing-only users reach the billing
  page without fetching CRM data. Existing screens can still display some
  edit controls, but unauthorized writes are rejected. Initial-workspace legacy
  backend compatibility remains during the Vercel/VM rolling deployment.

Validation: JavaScript syntax, diff checks and Vite production build. The local
frontend has no TypeScript compiler executable. No automated tests were run;
MySQL migration and role behavior need runtime verification on the full stack.
Multiple workspace creation and sharing remain disabled. Role assignment CRUD
and its UI are part of the upcoming workspace management stage.

## Migration rules

- `schema_migrations` records ordered IDs, checksums and completion timestamps.
- The previous schema bootstrap runs once as `2026100700_legacy_baseline`.
- `2026100701_workspace_foundation` adds tables, constraints and default rows.
- `2026100702_operational_workspace_scope` expands operational table scope.
- `2026100703_workspace_settings` adds operational workspace preferences.
- `2026100704_workspace_role_authority` adds assignment provenance/reconciliation state.
- `2026100705_workspace_configuration_keys` moves questionnaire and channel-type uniqueness to workspace scope.
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

1. Finish the data-access audit, remove implicit system scans and contract nullable scope
   columns only after legacy writers have been retired.
2. Confirm private-bucket policy and finish signed-URL/storage policy review,
   remaining provider/callback-service paths,
   durable call ownership and backup pagination/snapshot consistency. Vobiz
   context, workspace voice settings and per-workspace retention are implemented.
3. Confirm the migration and cross-workspace behavior against MySQL and the full
   application stack before allowing independent workspace data.
4. Organization/workspace permission enforcement is implemented. Add explicit
   workspace role assignment CRUD and UI, owner handoff safeguards and audit
   details as part of workspace management. Verify revocation and role boundaries
   against the full stack before enabling additional workspaces.
5. Add workspace provisioning/settings/member management and workspace industry
   configuration to both backend and frontend. Enable additional workspaces only
   after the operational-scope audit is complete.
6. Add explicit same-organization read-sharing grants, expiry/revocation, a
   separate shared list and an allowlist of visible fields.
7. Add restricted editing with versions, mapped copies/transfers, recruitment
   workflows and scaling improvements (outbox/idempotency/pagination).

The additive foundation can coexist with the old application. Once independent
workspace data exists, rollback to an organization-only backend is forbidden.

## Recovering from an occupied VM API port

`Bind for 0.0.0.0:3000 failed: port is already allocated` means another
container or host process owns the published port. It does not indicate a
migration failure. Do not remove database volumes or stop an unidentified
service to reclaim that port.

Set `APP_HOST_PORT=3001` (or another free port) in the deployment environment
file and rerun with `--force-recreate`. The API still listens on port 3000
inside Docker; the bundled Caddy proxy still targets `app:3000`. An external
proxy outside this Compose stack may need its upstream changed to the chosen
host port. Check the existing proxy configuration before changing public
traffic routing. Readiness checks now execute in the actual API container,
so an unrelated service on host port 3000 cannot produce a false success.

The MySQL2 `minIdle` option was unsupported and has been removed; connection
limits and idle timeout remain configured.
