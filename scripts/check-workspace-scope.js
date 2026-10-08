#!/usr/bin/env node
// Static consistency guard for the operational scope inventory. This does not
// connect to MySQL; live schema verification remains a deployment prerequisite.
const fs = require('node:fs');
const path = require('node:path');
const { WORKSPACE_TABLES } = require('../src/workspaces/tables');
const migration = require('../src/db/migrations/2026100702-operational-workspace-scope');
const billingMigration = require('../src/db/migrations/2026100711-workspace-billing');

const migrationTables = new Set([...migration.steps, ...billingMigration.steps].flatMap(step => {
  const match = step.sql.match(/^ALTER TABLE `([a-z0-9_]+)` ADD COLUMN workspace_id/m);
  // Billing reservations carry attribution for cap enforcement but remain
  // organization-owned; only the usage/cost ledger tables become scoped.
  return match && WORKSPACE_TABLES.has(match[1]) ? [match[1]] : [];
}));
const mismatches = [];
for (const table of WORKSPACE_TABLES) if (!migrationTables.has(table)) mismatches.push(`Scope table missing workspace_id migration: ${table}`);
for (const table of migrationTables) if (!WORKSPACE_TABLES.has(table)) mismatches.push(`Migrated table missing runtime workspace scope: ${table}`);

const adapterPath = path.join(__dirname, '../src/db/adapters/mysql.js');
const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const adapterTables = new Set([...adapterSource.matchAll(/^  ([a-z0-9_]+): \{/gm)].map(match => match[1]));
for (const table of WORKSPACE_TABLES) if (!adapterTables.has(table)) mismatches.push(`Scope table missing MySQL adapter metadata: ${table}`);

if (mismatches.length) {
  console.error('Workspace scope inventory check failed:');
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}
console.log(`Workspace scope inventory is consistent (${WORKSPACE_TABLES.size} operational tables).`);
