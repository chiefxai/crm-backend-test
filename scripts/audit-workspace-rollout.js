"use strict";

// Read-only VM audit for the multi-workspace database foundation. It reports
// structural/data-integrity counts only; it does not change rows or flags.
require("dotenv").config();

const { pool, closePool } = require("../src/db/pool");
const { WORKSPACE_TABLES } = require("../src/workspaces/tables");

const REQUIRED_MIGRATIONS = [
  "2026100701_workspace_foundation",
  "2026100702_operational_workspace_scope",
  "2026100703_workspace_settings",
  "2026100704_workspace_role_authority",
  "2026100705_workspace_configuration_keys",
  "2026100706_scheduler_workspace_indexes",
  "2026100707_workspace_sharing",
  "2026100708_workspace_share_proposals",
  "2026100709_workspace_share_imports",
  "2026100710_workspace_share_import_idempotency",
];

function countValue(rows) {
  return Number(rows?.[0]?.count || 0);
}

async function run() {
  const client = await pool.connect();
  let failed = false;
  let transactionOpen = false;
  try {
    await client.query("START TRANSACTION READ ONLY");
    transactionOpen = true;

    const { rows: migrationRows } = await client.query(
      "SELECT id FROM schema_migrations WHERE id IN (" + REQUIRED_MIGRATIONS.map(() => "?").join(",") + ")",
      REQUIRED_MIGRATIONS
    );
    const applied = new Set(migrationRows.map((row) => row.id));
    const missing = REQUIRED_MIGRATIONS.filter((id) => !applied.has(id));
    console.log(`Workspace migrations: ${applied.size}/${REQUIRED_MIGRATIONS.length} applied`);
    if (missing.length) {
      failed = true;
      console.error(`Missing migrations: ${missing.join(", ")}`);
    }

    const { rows: badDefaults } = await client.query(`
      SELECT o.id
        FROM organizations o
        LEFT JOIN workspaces w ON w.org_id=o.id
       GROUP BY o.id
      HAVING SUM(CASE WHEN w.is_default=1 THEN 1 ELSE 0 END)<>1
          OR MAX(CASE WHEN w.id=o.id AND w.is_default=1 THEN 1 ELSE 0 END)<>1
       LIMIT 20
    `);
    console.log(`Organizations with an invalid default workspace: ${badDefaults.length}`);
    if (badDefaults.length) {
      failed = true;
      console.error(`Sample organization IDs: ${badDefaults.map((row) => row.id).join(", ")}`);
    }

    let invalidReferences = 0;
    let legacyNullRows = 0;
    for (const table of [...WORKSPACE_TABLES].sort()) {
      if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe workspace table name: ${table}`);
      const { rows: invalidRows } = await client.query(`
        SELECT COUNT(*) AS count
          FROM \`${table}\` t
          LEFT JOIN workspaces w ON w.org_id=t.org_id AND w.id=t.workspace_id
         WHERE t.workspace_id IS NOT NULL AND w.id IS NULL
      `);
      const { rows: nullRows } = await client.query(
        `SELECT COUNT(*) AS count FROM \`${table}\` WHERE workspace_id IS NULL`
      );
      const invalid = countValue(invalidRows);
      const legacy = countValue(nullRows);
      invalidReferences += invalid;
      legacyNullRows += legacy;
      if (invalid) console.error(`${table}: ${invalid} row(s) reference a missing workspace`);
      if (legacy) console.log(`${table}: ${legacy} legacy row(s) have NULL workspace_id`);
    }
    console.log(`Operational rows referencing a missing workspace: ${invalidReferences}`);
    console.log(`Operational rows with NULL workspace_id: ${legacyNullRows}`);
    if (invalidReferences) failed = true;

    console.log(`Multi-workspace gate: ${process.env.MULTI_WORKSPACE_ENABLED === "true" ? "ON" : "OFF"}`);
    console.log(`Isolation verification gate: ${process.env.WORKSPACE_ISOLATION_VERIFIED === "true" ? "ON" : "OFF"}`);
    console.log(`Workspace sharing gate: ${process.env.WORKSPACE_SHARING_ENABLED === "true" ? "ON" : "OFF"}`);

    await client.query("ROLLBACK");
    transactionOpen = false;
    if (failed) process.exitCode = 1;
    else console.log("Read-only workspace foundation audit passed.");
  } finally {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch (_) {}
    }
    client.release();
    await closePool();
  }
}

run().catch((error) => {
  console.error(`Workspace foundation audit failed: ${error.message}`);
  process.exitCode = 1;
  closePool().catch(() => {});
});
