// Static compatibility contract for the MySQL query-builder shim.
// This test does not require a live MySQL server.
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../src/db/adapters/mysql'), 'utf8');

test('query builder implements repository compatibility operators', () => {
  for (const method of ['eq(', 'neq(', 'is(', 'in(', 'gt(', 'gte(', 'lte(', 'ilike(', 'match(', 'not(', 'filter(', 'or(', 'range(', 'single(', 'maybeSingle(']) {
    expect(src).toContain(method);
  }
});

test('mysql adapter has no PostgreSQL-only SQL operators', () => {
  const executableSrc = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(executableSrc).not.toMatch(/\bRETURNING\b|\bILIKE\b|\bON CONFLICT\b|\bANY\s*\(/);
});

test('mysql adapter exposes the migration-managed workspaces table to its query builder', () => {
  expect(src).toMatch(/workspaces:\s*\{\s*pk:\s*"id"/);
  expect(src).toContain('if (table === "workspaces") continue;');
});
