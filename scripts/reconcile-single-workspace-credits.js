'use strict';

const crypto = require('node:crypto');
const { getPool } = require('../src/db/pool');
const { createMysqlUnitOfWork } = require('../src/billing/adapters/mysql/unitOfWork');
const operationStore = require('../src/billing/adapters/mysql/commandOperationRepository');
const { createMysqlCreditRepository } = require('../src/billing/modules/credits/repositories/mysqlCreditRepository');
const { createAutomaticCreditAllocationService, automaticAllocationsEnabled } = require('../src/billing/automaticCreditAllocationService');
const { readManualAllocationOverview } = require('../src/billing/manualAllocationReadModel');
const { createSingleWorkspaceCreditReconciliation } = require('../src/billing/singleWorkspaceCreditReconciliation');

function argumentsOf(argv) {
  const result = { dryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--org-id' && argv[index + 1]) result.orgId = argv[++index];
    else if (argv[index] === '--execute') result.dryRun = false;
    else throw new TypeError(`Unknown or incomplete argument: ${argv[index]}`);
  }
  if (!result.orgId) throw new TypeError('Usage: node scripts/reconcile-single-workspace-credits.js --org-id <organization-id> [--execute]');
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const input = argumentsOf(argv);
  const pool = getPool();
  const idSource = { newId: prefix => `${prefix}-${crypto.randomUUID()}` };
  const clock = { now: () => new Date().toISOString() };
  const creditRepository = createMysqlCreditRepository({ idSource, clock });
  const service = createSingleWorkspaceCreditReconciliation({
    readSnapshot: (orgId, { now }) => readManualAllocationOverview(orgId, { pool, now }),
    unitOfWork: createMysqlUnitOfWork({ pool, operationStore, idSource, clock }),
    automaticAllocationService: createAutomaticCreditAllocationService({ creditRepository, clock }),
    isEnabled: orgId => automaticAllocationsEnabled(orgId),
  });
  const result = await service.reconcile({ ...input, now: clock.now() });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { argumentsOf, main };
