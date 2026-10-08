// Operational data boundaries. Billing and the organization member directory
// remain organization-owned. Add new tables through a NEW schema migration.
const WORKSPACE_TABLES = new Set([
  'leads', 'contact_groups', 'workflows', 'campaigns', 'loans', 'call_logs',
  'dialer_tasks', 'inbound_call_logs', 'virtual_numbers', 'org_agents',
  'question_flows', 'calls', 'lead_responses', 'enquiries', 'customers',
  'catalog_items', 'orders', 'questionnaires', 'objects', 'object_fields',
  'object_stages', 'object_records', 'channels', 'conversations', 'messages',
  'workflow_runs', 'dnc_entries', 'knowledge_documents', 'knowledge_chunks', 'audit_log',
  'ai_session_usage', 'call_billing_records',
]);

// Billing uses dedicated repositories and is intentionally outside the generic
// workspace entity adapter above. Plans are platform-owned; all other listed
// records are organization-owned. These rules describe the extra workspace
// filter required for a workspace billing projection. `column` means direct
// workspace ownership and `via` requires the named join path; org-level rows
// remain available only through organization-authorized billing queries.
const BILLING_PLATFORM_TABLES = new Set(['billing_plans', 'billing_plan_versions']);
const BILLING_ORG_TABLES = new Set([
  'organization_billing_accounts',
  'organization_billing_terms', 'billing_periods', 'billing_quotes',
  'billing_quote_lines', 'billing_payment_requests', 'billing_payment_proof_versions', 'billing_payment_decisions',
  'billing_payment_fulfillments', 'billing_credit_grants', 'billing_credit_accounts',
  'billing_credit_positions', 'billing_journals', 'billing_journal_lines',
  'billing_allocation_rule_versions', 'billing_allocation_runs', 'billing_usage_events',
  'billing_command_operations', 'billing_outbox', 'billing_consumer_inbox',
  'billing_reservations', 'billing_reservation_lines', 'billing_postpaid_accounts',
  'billing_postpaid_period_totals', 'billing_postpaid_journals', 'billing_invoices',
  'billing_invoice_lines', 'billing_invoice_payments', 'billing_notification_policies',
  'billing_contacts', 'billing_alert_states', 'billing_notifications',
  'billing_notification_recipients', 'billing_notification_deliveries',
]);
const BILLING_TABLES = new Set([...BILLING_PLATFORM_TABLES, ...BILLING_ORG_TABLES]);

const BILLING_WORKSPACE_READ_RULES = Object.freeze({
  billing_credit_accounts: Object.freeze({ via: 'account_type=workspace AND owner_id=workspace_id' }),
  billing_credit_positions: Object.freeze({ via: 'billing_credit_accounts.id=account_id' }),
  billing_journal_lines: Object.freeze({ via: 'billing_credit_accounts.id=account_id' }),
  billing_usage_events: Object.freeze({ column: 'workspace_id' }),
  billing_reservations: Object.freeze({ column: 'workspace_id' }),
  billing_reservation_lines: Object.freeze({ via: 'billing_reservations.id=reservation_id' }),
  billing_postpaid_accounts: Object.freeze({ via: 'scope_type=workspace AND scope_owner_id=workspace_id' }),
  billing_postpaid_period_totals: Object.freeze({ via: 'scope_type=workspace AND scope_owner_id=workspace_id' }),
  billing_postpaid_journals: Object.freeze({ column: 'workspace_id' }),
  billing_invoice_lines: Object.freeze({ column: 'workspace_id' }),
  billing_notification_policies: Object.freeze({ via: 'scope_type=workspace AND scope_owner_id=workspace_id' }),
  billing_alert_states: Object.freeze({ via: 'scope_type=workspace AND scope_owner_id=workspace_id' }),
  billing_notifications: Object.freeze({ via: 'scope_type=workspace AND scope_owner_id=workspace_id' }),
});

module.exports = { WORKSPACE_TABLES, BILLING_TABLES, BILLING_PLATFORM_TABLES, BILLING_ORG_TABLES, BILLING_WORKSPACE_READ_RULES };
