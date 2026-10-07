// Ordered, additive migrations. DDL commits implicitly in MySQL; every step
// must be safe to retry after process failure before the journal write.
const crypto = require('crypto');
const migrations = [{
  id: '2026100701_workspace_foundation',
  steps: [
    { sql: `CREATE TABLE IF NOT EXISTS workspaces (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      org_id VARCHAR(191) NOT NULL,
      name VARCHAR(255) NOT NULL,
      industry VARCHAR(100) NOT NULL,
      branch_name VARCHAR(255) NULL,
      status VARCHAR(100) NOT NULL DEFAULT 'Active',
      is_default TINYINT NOT NULL DEFAULT 0,
      created_at VARCHAR(40) NOT NULL,
      UNIQUE KEY uq_workspaces_org_id (org_id,id),
      KEY idx_workspaces_org_status (org_id,status),
      CONSTRAINT fk_workspaces_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
    )` },
    { sql: `ALTER TABLE org_members ADD UNIQUE KEY uq_org_members_org_id (org_id,id)`, ignore: ['ER_DUP_KEYNAME'] },
    { sql: `CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id VARCHAR(191) NOT NULL,
      org_id VARCHAR(191) NOT NULL,
      member_id VARCHAR(191) NOT NULL,
      role VARCHAR(100) NOT NULL,
      status VARCHAR(100) NOT NULL DEFAULT 'Active',
      created_at VARCHAR(40) NOT NULL,
      PRIMARY KEY (workspace_id,member_id),
      KEY idx_workspace_members_org_member (org_id,member_id,workspace_id),
      CONSTRAINT fk_workspace_members_workspace FOREIGN KEY (org_id,workspace_id) REFERENCES workspaces(org_id,id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_members_org_member FOREIGN KEY (org_id,member_id) REFERENCES org_members(org_id,id) ON DELETE CASCADE
    )` },
    // Reuse the former organization boundary ID for the initial workspace.
    // Existing vector collections/storage paths remain valid during expansion.
    { sql: `INSERT INTO workspaces (id,org_id,name,industry,status,is_default,created_at)
      SELECT id,id,COALESCE(NULLIF(workspace_name,''),name,'Default workspace'),COALESCE(NULLIF(industry,''),'lending'),
      CASE WHEN status = 'Suspended' THEN 'Suspended' ELSE 'Active' END,1,COALESCE(created_at,?) FROM organizations
      ON DUPLICATE KEY UPDATE id=workspaces.id`, now: true },
    { sql: `INSERT INTO workspace_members (workspace_id,org_id,member_id,role,status,created_at)
      SELECT m.org_id,m.org_id,m.id,CASE WHEN m.role IN ('Organization Admin','Super Admin') THEN 'Workspace Admin'
      WHEN m.role = 'Manager' THEN 'Manager' WHEN m.role = 'Viewer' THEN 'Viewer' ELSE 'Member' END,
      COALESCE(NULLIF(m.status,''),'Active'),COALESCE(m.created_at,?) FROM org_members m
      INNER JOIN workspaces w ON w.org_id=m.org_id AND w.id=m.org_id
      ON DUPLICATE KEY UPDATE member_id=workspace_members.member_id`, now: true },
  ],
}, require("./2026100702-operational-workspace-scope"), require("./2026100703-workspace-settings"), require("./2026100704-workspace-role-authority"), require("./2026100705-workspace-configuration-keys"), require("./2026100706-scheduler-workspace-indexes"), require("./2026100707-workspace-sharing"), require("./2026100708-workspace-share-proposals"), require("./2026100709-workspace-share-imports"), require("./2026100710-workspace-share-import-idempotency")];

async function ensureJournal(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(191) NOT NULL PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at VARCHAR(40) NOT NULL
  )`);
}
async function runVersionedMigrations(client) {
  for (const migration of migrations) {
    const checksum = crypto.createHash('sha256').update(JSON.stringify(migration.steps)).digest('hex');
    const { rows } = await client.query('SELECT checksum FROM schema_migrations WHERE id=?', [migration.id]);
    if (rows.length) {
      if (rows[0].checksum !== checksum) throw new Error(`Applied migration ${migration.id} has changed; add a new migration instead`);
      continue;
    }
    for (const step of migration.steps) {
      try { await client.query(step.sql, step.now ? [new Date().toISOString()] : []); }
      catch (error) { if (!step.ignore?.includes(error.code)) throw error; }
    }
    await client.query('INSERT INTO schema_migrations (id,checksum,applied_at) VALUES (?,?,?)', [migration.id, checksum, new Date().toISOString()]);
  }
}
module.exports = { ensureJournal, runVersionedMigrations };
