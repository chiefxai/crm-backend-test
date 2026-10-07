// Operational data boundaries. Billing and the organization member directory
// remain organization-owned. Add new tables through a NEW schema migration.
const WORKSPACE_TABLES = new Set([
  'leads', 'contact_groups', 'workflows', 'campaigns', 'loans', 'call_logs',
  'dialer_tasks', 'inbound_call_logs', 'virtual_numbers', 'org_agents',
  'question_flows', 'calls', 'lead_responses', 'enquiries', 'customers',
  'catalog_items', 'orders', 'questionnaires', 'objects', 'object_fields',
  'object_stages', 'object_records', 'channels', 'conversations', 'messages',
  'workflow_runs', 'dnc_entries', 'knowledge_documents', 'knowledge_chunks', 'audit_log',
]);
module.exports = { WORKSPACE_TABLES };
