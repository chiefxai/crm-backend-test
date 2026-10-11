'use strict';

// MySQL enforces the explicit RESTRICT foreign keys created by the billing and
// workspace migrations. Delete child rows before parent rows, rather than
// assuming the legacy CRM table list covers all future migrations.
//
// This is only a *plan*. Deletion, archival and the organization row removal
// remain in a single transaction in db/repository.js.

const RETAINED_TABLES = new Set([
  'organizations',
  'org_cost_archive',          // mandatory immutable final billing snapshot
  'organization_cloud_projects', // GCP projects are retained, not destroyed
]);

function requireSqlIdentifier(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error('Unexpected table identifier in organization-deletion metadata');
  }
  return name;
}

/**
 * @param {string[]} tables tenant tables containing org_id
 * @param {{child_table:string,parent_table:string}[]} references MySQL FK metadata
 * @param {string[]} preferredOrder legacy tie-break order (not an FK override)
 * @returns {string[]} child-first deletion plan
 */
function planOrganizationDeletion(tables, references, preferredOrder = []) {
  const candidates = new Set();
  for (const table of tables || []) {
    requireSqlIdentifier(table);
    if (!RETAINED_TABLES.has(table)) candidates.add(table);
  }
  const priority = new Map(preferredOrder.map((table, index) => [table, index]));
  const compare = (a, b) => (priority.get(a) ?? Number.MAX_SAFE_INTEGER)
    - (priority.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b);
  // For child -> parent, parent is only ready after *every* child is deleted.
  const parentsByChild = new Map([...candidates].map(table => [table, new Set()]));
  const incomingChildren = new Map([...candidates].map(table => [table, 0]));
  for (const reference of references || []) {
    const child = requireSqlIdentifier(reference.child_table);
    const parent = requireSqlIdentifier(reference.parent_table);
    if (!candidates.has(child) || !candidates.has(parent) || child === parent) continue;
    const parents = parentsByChild.get(child);
    if (parents.has(parent)) continue; // composite foreign-key columns
    parents.add(parent);
    incomingChildren.set(parent, incomingChildren.get(parent) + 1);
  }
  const ready = [...candidates].filter(table => incomingChildren.get(table) === 0).sort(compare);
  const ordered = [];
  while (ready.length) {
    const child = ready.shift();
    ordered.push(child);
    for (const parent of parentsByChild.get(child)) {
      const remaining = incomingChildren.get(parent) - 1;
      incomingChildren.set(parent, remaining);
      if (remaining === 0) {
        ready.push(parent);
        ready.sort(compare);
      }
    }
  }
  if (ordered.length !== candidates.size) {
    const cycle = [...candidates].filter(table => incomingChildren.get(table) > 0).sort(compare);
    const error = new Error(`Organization deletion blocked by a circular foreign-key dependency: ${cycle.join(', ')}`);
    error.statusCode = 409;
    throw error; // Never disable FOREIGN_KEY_CHECKS or silently skip tenant tables.
  }
  return ordered;
}

module.exports = { planOrganizationDeletion, RETAINED_TABLES, requireSqlIdentifier };
