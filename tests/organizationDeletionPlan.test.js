'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { planOrganizationDeletion } = require('../src/db/organizationDeletionPlan');

describe('foreign-key-safe organization deletion', () => {
  const legacy = ['org_members','workspaces','organization_billing_accounts',
    'billing_payment_requests','billing_credit_grants','billing_credit_positions'];

  test('deletes tenant children before their foreign-key parents regardless of legacy preference', () => {
    const tables = ['organizations', ...legacy, 'org_cost_archive', 'organization_cloud_projects'];
    const references = [
      { child_table:'billing_credit_positions',parent_table:'billing_credit_grants' },
      { child_table:'billing_credit_grants',parent_table:'billing_payment_requests' },
      { child_table:'billing_payment_requests',parent_table:'organization_billing_accounts' },
      { child_table:'organization_billing_accounts',parent_table:'organizations' },
      { child_table:'workspace_members',parent_table:'org_members' },
      { child_table:'billing_credit_positions',parent_table:'billing_credit_grants' },
    ];
    tables.push('workspace_members');
    const result = planOrganizationDeletion(tables,references,legacy);
    const before=(child,parent) => expect(result.indexOf(child)).toBeLessThan(result.indexOf(parent));
    before('billing_credit_positions','billing_credit_grants');
    before('billing_credit_grants','billing_payment_requests');
    before('billing_payment_requests','organization_billing_accounts');
    before('workspace_members','org_members');
    expect(result).not.toContain('organizations');
    expect(result).not.toContain('org_cost_archive');
    expect(result).not.toContain('organization_cloud_projects');
    expect(result).toHaveLength(new Set(tables).size - 3);
  });

  test('handles later migrations and composite foreign keys', () => {
    const references = [
      ['billing_payment_fulfillments','billing_payment_requests'],
      ['billing_payment_decisions','billing_payment_requests'],
      ['billing_payment_requests','billing_quotes'],
      ['billing_quote_lines','billing_quotes'],
      ['billing_workspace_addon_cycles','billing_workspace_addons'],
      ['billing_workspace_addon_cycles','billing_invoices'],
      ['billing_workspace_addons','organization_billing_accounts'],
      ['billing_workspace_addons','workspaces'],
      ['billing_workspace_addons','org_members'],
      ['billing_journal_lines','billing_journals'],
      ['billing_journal_lines','billing_credit_accounts'],
      ['billing_credit_positions','billing_credit_accounts'],
      ['billing_credit_positions','billing_credit_grants'],
      ['billing_allocation_runs','billing_credit_grants'],
      ['billing_allocation_runs','billing_allocation_rule_versions'],
      ['billing_usage_events','billing_periods'],
      ['billing_credit_grants','billing_periods'],
      ['billing_credit_grants','billing_payment_requests'],
      ['billing_credit_accounts','workspaces'],
      ['billing_periods','organization_billing_accounts'],
    ];
    const tables=[...new Set(references.flat())];
    const plan=planOrganizationDeletion(tables,
      references.map(([child_table,parent_table])=>({child_table,parent_table})),
      [...tables].reverse());
    for(const [child,parent] of references) {
      expect(plan.indexOf(child)).toBeLessThan(plan.indexOf(parent));
    }
    expect(plan).toHaveLength(tables.length);
  });

  test('preserves legacy ordering for unrelated CRM tables', () => {
    expect(planOrganizationDeletion(['leads','calls','messages'],[],['messages','calls','leads']))
      .toEqual(['messages','calls','leads']);
    expect(planOrganizationDeletion(['z_extra','a_extra','leads'],[],['leads']))
      .toEqual(['leads','a_extra','z_extra']);
  });

  test('fails closed for cycles instead of disabling foreign keys', () => {
    const run=()=>planOrganizationDeletion(['billing_a','billing_b'],[
      {child_table:'billing_a',parent_table:'billing_b'},
      {child_table:'billing_b',parent_table:'billing_a'},
    ]);
    expect(run).toThrow(/circular foreign-key dependency/);
    try { run(); } catch(error) { expect(error.statusCode).toBe(409); }
  });

  test('rejects unsafe schema identifiers', () => {
    expect(() => planOrganizationDeletion(['orders;DROP TABLE organizations'],[])).toThrow(/identifier/);
    expect(() => planOrganizationDeletion(['orders'],[{child_table:'orders',parent_table:'leads;DROP'}])).toThrow(/identifier/);
  });

  test('retains the archive, transaction and cloud-project guard in the deletion routine', () => {
    const source=fs.readFileSync(path.join(__dirname,'../src/db/repository.js'),'utf8');
    const fn=source.slice(source.indexOf('async function deleteOrganizationData('),
      source.indexOf('async function listCostArchive('));
    expect(fn).toContain('await client.query("BEGIN")');
    expect(fn).toContain('INSERT INTO');
    expect(fn).toContain('org_cost_archive');
    expect(fn).toContain('planOrganizationDeletion(existing, foreignKeys || [], preferredOrder)');
    expect(fn).toContain('await client.query("COMMIT")');
    expect(fn).toContain('await client.query("ROLLBACK")');
    expect(fn).not.toContain('DELETE FROM '+String.fromCharCode(96)+'organization_cloud_projects');
    expect(fn.indexOf('INSERT INTO')).toBeLessThan(fn.indexOf('planOrganizationDeletion('));
    expect(fn.indexOf('planOrganizationDeletion(')).toBeLessThan(fn.indexOf('DELETE FROM '+String.fromCharCode(96)+'organizations'));
  });

  test('releases platform-owned inventory and removes organization-owned connector rows in FK-safe order', () => {
    const source=fs.readFileSync(path.join(__dirname,'../src/db/repository.js'),'utf8');
    const fn=source.slice(source.indexOf('async function deleteOrganizationData('),
      source.indexOf('async function listCostArchive('));
    const releasePlatformNumbers=fn.indexOf("a.owner_type='platform'");
    const deleteAssignments=fn.indexOf('for (const table of ordered)');
    const deleteOrgInventory=fn.indexOf('DELETE FROM telephony_phone_numbers');
    const deleteOrgConnectors=fn.indexOf('DELETE FROM telephony_connector_accounts WHERE owner_type');
    const deleteOrganization=fn.indexOf('DELETE FROM `organizations`');
    expect(releasePlatformNumbers).toBeGreaterThan(-1);
    expect(releasePlatformNumbers).toBeLessThan(deleteAssignments);
    expect(deleteAssignments).toBeLessThan(deleteOrgInventory);
    expect(deleteOrgInventory).toBeLessThan(deleteOrgConnectors);
    expect(deleteOrgConnectors).toBeLessThan(deleteOrganization);
    expect(fn).toContain('hasTelephonyAssignments = existing.includes("telephony_number_assignments")');
  });
});
