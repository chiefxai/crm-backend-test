// Frozen expansion migration. Nullable columns preserve compatibility while
// the API and workers roll out. Application writes now assign explicit scope;
// a later contraction migration must reject remaining legacy NULL values.
const tables = [
  'leads', 'contact_groups', 'workflows', 'campaigns', 'loans', 'call_logs',
  'dialer_tasks', 'inbound_call_logs', 'virtual_numbers', 'org_agents',
  'question_flows', 'calls', 'lead_responses', 'enquiries', 'customers',
  'catalog_items', 'orders', 'questionnaires', 'objects', 'object_fields',
  'object_stages', 'object_records', 'channels', 'conversations', 'messages',
  'workflow_runs', 'dnc_entries', 'knowledge_documents', 'knowledge_chunks', 'audit_log',
];
module.exports = {
  id: '2026100702_operational_workspace_scope',
  steps: [
    { sql: `INSERT INTO workspaces (id,org_id,name,industry,status,is_default,created_at)
      SELECT id,id,COALESCE(NULLIF(workspace_name,''),name,'Default workspace'),COALESCE(NULLIF(industry,''),'lending'),
      CASE WHEN status='Suspended' THEN 'Suspended' ELSE 'Active' END,1,COALESCE(created_at,?) FROM organizations
      ON DUPLICATE KEY UPDATE id=workspaces.id`, now: true },
    ...tables.flatMap(table => [
    { sql: `ALTER TABLE \`${table}\` ADD COLUMN workspace_id VARCHAR(191) NULL`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `UPDATE \`${table}\` SET workspace_id=org_id WHERE workspace_id IS NULL AND org_id IS NOT NULL` },
    { sql: `CREATE INDEX idx_${table}_workspace ON \`${table}\` (org_id,workspace_id)`, ignore: ['ER_DUP_KEYNAME'] },
    { sql: `ALTER TABLE \`${table}\` ADD CONSTRAINT fk_${table}_workspace FOREIGN KEY (org_id,workspace_id) REFERENCES workspaces(org_id,id) ON DELETE CASCADE`, ignore: ['ER_FK_DUP_NAME'] },
    ]),
  ],
};
