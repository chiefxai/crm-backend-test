'use strict';

const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');
const { validateAmount } = require('../../../kernel/amount');

const MAX_ID_LENGTH = 191;
const MAX_SIGNED_UNITS = 9223372036854775807n;

function fail(code, message, details) {
  throw new BillingDomainError(code, message, { details });
}
function requiredText(value, name, max = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}
function safeUnits(value, name, { positive = false, nonzero = false } = {}) {
  if (typeof value !== 'string' || !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value)) {
    fail(DOMAIN_ERROR_CODES.INVALID_AMOUNT, `${name} must be a canonical integer string.`);
  }
  const units = BigInt(value);
  if (units < -MAX_SIGNED_UNITS - 1n || units > MAX_SIGNED_UNITS) fail(DOMAIN_ERROR_CODES.AMOUNT_OVERFLOW, `${name} exceeds signed 64-bit range.`);
  if (positive && units <= 0n) fail(DOMAIN_ERROR_CODES.INVALID_AMOUNT, `${name} must be positive.`);
  if (nonzero && units === 0n) fail(DOMAIN_ERROR_CODES.INVALID_AMOUNT, `${name} must be nonzero.`);
  return units;
}
function validateAsset(asset) {
  if (typeof asset !== 'string' || !/^[A-Z][A-Z0-9._:-]{0,31}$/.test(asset)) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'asset must be a supported uppercase identifier.');
  return asset;
}
function validateScale(scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'scale must be an integer from 0 through 18.');
  return scale;
}
function rows(result) {
  if (!result || !Array.isArray(result.rows)) fail(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, 'Billing SQL adapter returned an invalid query result.');
  return result.rows;
}
function affected(result) {
  const count = result && (result.affectedRows ?? result.rowCount);
  return Number(count ?? 0);
}
function duplicate(error) { return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062 || error?.code === '23505'; }
function sameLines(existing, normalized) {
  const expected = normalized.map((x) => `${x.accountId}|${x.grantId || ''}|${x.amountUnits}|${x.asset}|${x.scale}|${x.entryType}`).sort();
  const actual = existing.map((x) => `${x.account_id}|${x.grant_id || ''}|${String(x.amount_units)}|${x.asset}|${Number(x.scale)}|${x.entry_type}`).sort();
  return expected.length === actual.length && expected.every((line, index) => line === actual[index]);
}

/** MySQL credit persistence. All mutating methods require an active branded UoW transaction. */
function createMysqlCreditRepository({ idSource, clock }) {
  if (!idSource || typeof idSource.newId !== 'function') throw new TypeError('Credit repository requires idSource.newId().');
  if (!clock || typeof clock.now !== 'function') throw new TypeError('Credit repository requires clock.now().');

  async function ensureAccount(tx, input) {
    assertTransactionContext(tx);
    const orgId = requiredText(input.orgId, 'orgId');
    const accountType = input.accountType;
    if (!['organization', 'workspace'].includes(accountType)) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'accountType must be organization or workspace.');
    const ownerId = requiredText(input.ownerId, 'ownerId');
    const asset = validateAsset(input.asset);
    const scale = validateScale(input.scale);
    const accountPurpose = input.accountPurpose == null ? 'pool' : requiredText(input.accountPurpose, 'accountPurpose', 32);
    const workspaceId = input.workspaceId == null ? null : requiredText(input.workspaceId, 'workspaceId');
    if (accountType === 'organization' && (ownerId !== orgId || workspaceId !== null)) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Organization account must be owned by its organization and have no workspace.');
    if (accountType === 'workspace' && (ownerId !== workspaceId || workspaceId === null)) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Workspace account ownerId must equal workspaceId.');
    const existing = rows(await tx.query(
      `SELECT id,org_id,account_type,owner_id,workspace_id,account_purpose,asset,scale,status,version FROM billing_credit_accounts
       WHERE org_id=? AND account_type=? AND owner_id=? AND account_purpose=? AND asset=? AND scale=? FOR UPDATE`,
      [orgId, accountType, ownerId, accountPurpose, asset, scale],
    ))[0];
    if (existing) {
      if ((existing.workspace_id ?? null) !== workspaceId) fail(DOMAIN_ERROR_CODES.CONFLICT, 'Credit account already exists with a different workspace scope.');
      return accountFromRow(existing);
    }
    const id = requiredText(idSource.newId('billing-credit-account'), 'accountId');
    const now = input.now || clock.now();
    try {
      await tx.query(`INSERT INTO billing_credit_accounts (id,org_id,account_type,owner_id,workspace_id,account_purpose,asset,scale,status,version,created_at)
        VALUES (?,?,?,?,?,?,?,?,'active',0,?)`, [id, orgId, accountType, ownerId, workspaceId, accountPurpose, asset, scale, now]);
    } catch (error) {
      if (!duplicate(error)) throw error;
      const concurrent = rows(await tx.query(
        `SELECT id,org_id,account_type,owner_id,workspace_id,account_purpose,asset,scale,status,version FROM billing_credit_accounts
         WHERE org_id=? AND account_type=? AND owner_id=? AND account_purpose=? AND asset=? AND scale=? FOR UPDATE`, [orgId, accountType, ownerId, accountPurpose, asset, scale],
      ))[0];
      if (!concurrent || (concurrent.workspace_id ?? null) !== workspaceId) throw error;
      return accountFromRow(concurrent);
    }
    return { id, orgId, accountType, ownerId, workspaceId, accountPurpose, asset, scale, status: 'active', version: 0 };
  }

  async function createGrant(tx, input) {
    assertTransactionContext(tx);
    const { grant } = input;
    if (!grant || typeof grant !== 'object') fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'grant is required.');
    const orgId = requiredText(input.orgId, 'orgId');
    const id = requiredText(grant.id || idSource.newId('billing-credit-grant'), 'grant.id');
    const grantKind = requiredText(grant.grantKind || grant.kind, 'grant.grantKind', 32);
    const sourceType = requiredText(grant.sourceType, 'grant.sourceType', 48);
    const sourceId = requiredText(grant.sourceId, 'grant.sourceId');
    const sourceEventKey = requiredText(grant.sourceEventKey, 'grant.sourceEventKey');
    const amount = validateAmount(grant.amount);
    safeUnits(amount.units, 'grant.amount.units', { positive: true });
    const effectiveAt = requiredText(grant.effectiveAt, 'grant.effectiveAt', 64);
    const expiresAt = grant.expiresAt ?? null;
    if (expiresAt !== null && (typeof expiresAt !== 'string' || Date.parse(expiresAt) <= Date.parse(effectiveAt))) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'grant.expiresAt must be later than effectiveAt.');
    const periodId = grant.periodId == null ? null : requiredText(grant.periodId, 'grant.periodId');
    const paymentRequestId = grant.paymentRequestId == null ? null : requiredText(grant.paymentRequestId, 'grant.paymentRequestId');
    const now = input.now || clock.now();
    try {
      await tx.query(`INSERT INTO billing_credit_grants
        (id,org_id,grant_kind,source_type,source_id,source_event_key,period_id,payment_request_id,status,amount_units,asset,scale,effective_at,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?, 'active',?,?,?,?,?,?)`,
      [id, orgId, grantKind, sourceType, sourceId, sourceEventKey, periodId, paymentRequestId, amount.units, amount.asset, amount.scale, effectiveAt, expiresAt, now]);
    } catch (error) {
      if (!duplicate(error)) throw error;
      const prior = rows(await tx.query(`SELECT id,org_id,grant_kind,source_type,source_id,source_event_key,period_id,payment_request_id,status,amount_units,asset,scale,effective_at,expires_at
        FROM billing_credit_grants WHERE org_id=? AND source_type=? AND source_id=? AND source_event_key=? FOR UPDATE`,
      [orgId, sourceType, sourceId, sourceEventKey]))[0];
      if (prior && grantRowMatches(prior, { id, orgId, grantKind, sourceType, sourceId, sourceEventKey, periodId, paymentRequestId, amount, effectiveAt, expiresAt })) return grantFromRow(prior);
      fail(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Credit grant source event already funded with different terms.', { orgId, sourceType, sourceId, sourceEventKey });
    }
    return { id, orgId, grantKind, sourceType, sourceId, sourceEventKey, periodId, paymentRequestId, status: 'active', amount, effectiveAt, expiresAt };
  }

  async function applyJournal(tx, command) {
    assertTransactionContext(tx);
    const normalized = normalizeCommand(command, clock.now());
    const existingJournal = rows(await tx.query(`SELECT id,operation_type,source_type,source_id,actor_type,actor_id,reason FROM billing_journals
      WHERE org_id=? AND operation_id=? FOR UPDATE`, [normalized.orgId, normalized.operationId]))[0];
    if (existingJournal) {
      const priorLines = rows(await tx.query(`SELECT account_id,grant_id,amount_units,asset,scale,entry_type FROM billing_journal_lines
        WHERE org_id=? AND journal_id=? ORDER BY line_number FOR UPDATE`, [normalized.orgId, existingJournal.id]));
      const metadataMatches = existingJournal.operation_type === normalized.operationType
        && (existingJournal.source_type ?? null) === normalized.sourceType
        && (existingJournal.source_id ?? null) === normalized.sourceId
        && existingJournal.actor_type === normalized.actorType
        && (existingJournal.actor_id ?? null) === normalized.actorId
        && (existingJournal.reason ?? null) === normalized.reason;
      if (!metadataMatches || !sameLines(priorLines, normalized.entries)) fail(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Journal operation id was already used for different credit movements.', { orgId: normalized.orgId, operationId: normalized.operationId });
      try {
        await validateEntryReferences(tx, normalized.orgId, normalized.entries, normalized.positionDeltas, normalized.grantPatch);
      } catch (error) {
        fail(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'Journal operation id was replayed with different position or grant changes.',
          { orgId: normalized.orgId, operationId: normalized.operationId, cause: error.code || error.message });
      }
      return { journalId: existingJournal.id, created: false, lines: normalized.entries };
    }

    await validateEntryReferences(tx, normalized.orgId, normalized.entries, normalized.positionDeltas, normalized.grantPatch);
    const journalId = requiredText(idSource.newId('billing-journal'), 'journalId');
    await tx.query(`INSERT INTO billing_journals
      (id,org_id,operation_id,operation_type,source_type,source_id,actor_type,actor_id,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [journalId, normalized.orgId, normalized.operationId, normalized.operationType,
      normalized.sourceType, normalized.sourceId, normalized.actorType, normalized.actorId, normalized.reason, normalized.now]);

    for (let index = 0; index < normalized.entries.length; index += 1) {
      const entry = normalized.entries[index];
      await tx.query(`INSERT INTO billing_journal_lines
        (id,org_id,journal_id,line_number,account_id,grant_id,entry_type,amount_units,asset,scale,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [requiredText(idSource.newId('billing-journal-line'), 'journalLineId'), normalized.orgId,
        journalId, index + 1, entry.accountId, entry.grantId, entry.entryType, entry.amountUnits, entry.asset, entry.scale, normalized.now]);
    }
    for (const delta of normalized.positionDeltas) {
      await updatePosition(tx, { ...delta, orgId: normalized.orgId, now: normalized.now, positionId: idSource.newId('billing-credit-position') });
    }
    if (normalized.grantPatch) {
      const result = await tx.query(`UPDATE billing_credit_grants SET status=? WHERE org_id=? AND id=? AND status=?`,
        [normalized.grantPatch.status, normalized.orgId, normalized.grantPatch.grantId, normalized.grantPatch.expectedStatus]);
      const changed = affected(result);
      if (changed !== 1 && !(changed === 0 && normalized.grantPatch.status === normalized.grantPatch.expectedStatus)) {
        fail(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Credit grant status changed concurrently.', normalized.grantPatch);
      }
    }
    return { journalId, created: true, lines: normalized.entries };
  }

  async function getPosition(tx, { orgId, grantId, accountId }) {
    assertTransactionContext(tx);
    const row = rows(await tx.query(`SELECT id,org_id,grant_id,account_id,asset,scale,balance_units,reserved_units,version
      FROM billing_credit_positions WHERE org_id=? AND grant_id=? AND account_id=?`,
    [requiredText(orgId, 'orgId'), requiredText(grantId, 'grantId'), requiredText(accountId, 'accountId')]))[0];
    return positionFromRow(row);
  }

  async function getPositionForUpdate(tx, { orgId, grantId, accountId }) {
    assertTransactionContext(tx);
    const row = rows(await tx.query(`SELECT p.id,p.org_id,p.grant_id,p.account_id,p.asset,p.scale,p.balance_units,p.reserved_units,p.version,
        a.account_type,a.owner_id,a.workspace_id,a.status AS account_status,a.account_purpose
      FROM billing_credit_positions p
      JOIN billing_credit_accounts a ON a.org_id=p.org_id AND a.id=p.account_id
      WHERE p.org_id=? AND p.grant_id=? AND p.account_id=? FOR UPDATE`,
    [requiredText(orgId, 'orgId'), requiredText(grantId, 'grantId'), requiredText(accountId, 'accountId')]))[0];
    if (!row) return null;
    return Object.freeze({
      ...positionFromRow(row),
      scope: Object.freeze({ orgId: row.org_id, ownerType: row.account_type, ownerId: row.owner_id }),
      accountStatus: row.account_status,
      accountPurpose: row.account_purpose || 'pool',
    });
  }

  async function getGrantForUpdate(tx, { orgId, grantId }) {
    assertTransactionContext(tx);
    const row = rows(await tx.query(`SELECT id,org_id,grant_kind,source_type,source_id,source_event_key,period_id,payment_request_id,
        status,amount_units,asset,scale,effective_at,expires_at
    FROM billing_credit_grants WHERE org_id=? AND id=? FOR UPDATE`,
    [requiredText(orgId, 'orgId'), requiredText(grantId, 'grantId')]))[0];
    return row ? grantFromRow(row) : null;
  }

  async function setReserved(tx, { orgId, grantId, accountId, deltaUnits, expectedVersion }) {
    assertTransactionContext(tx);
    const normalizedOrg = requiredText(orgId, 'orgId');
    const row = rows(await tx.query(`SELECT id,balance_units,reserved_units,version FROM billing_credit_positions
      WHERE org_id=? AND grant_id=? AND account_id=? FOR UPDATE`, [normalizedOrg, requiredText(grantId, 'grantId'), requiredText(accountId, 'accountId')]))[0];
    if (!row) fail(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit position was not found.');
    if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) fail(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Credit position changed concurrently.');
    const delta = safeUnits(deltaUnits, 'deltaUnits', { nonzero: true });
    const reserved = BigInt(row.reserved_units) + delta;
    const balance = BigInt(row.balance_units);
    if (reserved < 0n || reserved > balance) fail(DOMAIN_ERROR_CODES.INSUFFICIENT_CREDITS, 'Reserved units must remain between zero and the position balance.');
    const result = await tx.query(`UPDATE billing_credit_positions SET reserved_units=?,version=version+1,updated_at=? WHERE org_id=? AND id=? AND version=?`,
      [reserved.toString(), clock.now(), normalizedOrg, row.id, row.version]);
    if (affected(result) !== 1) fail(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Credit position changed concurrently.');
    return { orgId: normalizedOrg, grantId, accountId, balanceUnits: String(balance), reservedUnits: String(reserved), version: Number(row.version) + 1 };
  }

  return Object.freeze({ ensureAccount, createGrant, applyJournal, getPosition, getPositionForUpdate, getGrantForUpdate, setReserved });
}

function accountFromRow(row) {
  return { id: row.id, orgId: row.org_id, accountType: row.account_type, ownerId: row.owner_id, workspaceId: row.workspace_id ?? null, accountPurpose: row.account_purpose || 'pool',
    asset: row.asset, scale: Number(row.scale), status: row.status, version: Number(row.version) };
}
function grantFromRow(row) {
  return { id: row.id, orgId: row.org_id, grantKind: row.grant_kind, sourceType: row.source_type, sourceId: row.source_id,
    sourceEventKey: row.source_event_key, periodId: row.period_id ?? null, paymentRequestId: row.payment_request_id ?? null,
    status: row.status, amount: { asset: row.asset, units: String(row.amount_units), scale: Number(row.scale) }, effectiveAt: row.effective_at, expiresAt: row.expires_at ?? null };
}
function positionFromRow(row) {
  if (!row) return null;
  return { id: row.id, orgId: row.org_id, grantId: row.grant_id, accountId: row.account_id, amount: { asset: row.asset, units: String(row.balance_units), scale: Number(row.scale) },
    reservedUnits: String(row.reserved_units), version: Number(row.version) };
}
function grantRowMatches(row, input) {
  return row.id === input.id && row.org_id === input.orgId && row.grant_kind === input.grantKind && row.source_type === input.sourceType
    && row.source_id === input.sourceId && row.source_event_key === input.sourceEventKey && (row.period_id ?? null) === input.periodId
    && (row.payment_request_id ?? null) === input.paymentRequestId && String(row.amount_units) === input.amount.units && row.asset === input.amount.asset
    && Number(row.scale) === input.amount.scale && new Date(row.effective_at).getTime() === new Date(input.effectiveAt).getTime()
    && (row.expires_at == null ? null : new Date(row.expires_at).getTime()) === (input.expiresAt == null ? null : new Date(input.expiresAt).getTime());
}
function normalizeCommand(command, defaultNow) {
  if (!command || typeof command !== 'object') fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Journal command is required.');
  const orgId = requiredText(command.orgId, 'orgId');
  const operationId = requiredText(command.operationId, 'operationId');
  const operationType = requiredText(command.operationType, 'operationType', 48);
  if (!Array.isArray(command.entries) || (command.entries.length < 2 && !(command.entries.length === 0 && command.grantPatch))) {
    fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Journal must contain balanced lines, except a grant status only update which may be empty.');
  }
  const entries = command.entries.map((entry, i) => {
    const asset = validateAsset(entry.asset); const scale = validateScale(entry.scale);
    const amountUnits = safeUnits(entry.amountUnits, `entries[${i}].amountUnits`, { nonzero: true }).toString();
    return { accountId: requiredText(entry.accountId, `entries[${i}].accountId`), grantId: entry.grantId == null ? null : requiredText(entry.grantId, `entries[${i}].grantId`),
      amountUnits, asset, scale, entryType: requiredText(entry.entryType, `entries[${i}].entryType`, 32) };
  });
  const sums = new Map();
  const grantTotals = new Map();
  for (const entry of entries) {
    const key = `${entry.grantId || 'clearing'}|${entry.asset}|${entry.scale}`;
    sums.set(key, (sums.get(key) || 0n) + BigInt(entry.amountUnits));
    const aggregateKey = `${entry.asset}|${entry.scale}`;
    grantTotals.set(aggregateKey, (grantTotals.get(aggregateKey) || 0n) + BigInt(entry.amountUnits));
  }
  for (const [key, sum] of sums) if (sum !== 0n) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Journal lines must balance per grant, asset, and scale.', { key, totalUnits: sum.toString() });
  for (const [key, sum] of grantTotals) if (sum !== 0n) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Journal lines must balance per asset and scale.', { key, totalUnits: sum.toString() });
  const positionDeltas = (command.positionDeltas || []).map((delta, i) => {
    if (!delta || typeof delta !== 'object') fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `positionDeltas[${i}] must be an object.`);
    const balanceDeltaUnits = safeUnits(delta.balanceDeltaUnits ?? '0', `positionDeltas[${i}].balanceDeltaUnits`).toString();
    const reservedDeltaUnits = safeUnits(delta.reservedDeltaUnits ?? '0', `positionDeltas[${i}].reservedDeltaUnits`).toString();
    if (balanceDeltaUnits === '0' && reservedDeltaUnits === '0') fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, `positionDeltas[${i}] must change a balance or reservation.`);
    return { accountId: requiredText(delta.accountId, `positionDeltas[${i}].accountId`), grantId: requiredText(delta.grantId, `positionDeltas[${i}].grantId`),
      balanceDeltaUnits, reservedDeltaUnits, asset: delta.asset === undefined ? null : validateAsset(delta.asset), scale: delta.scale === undefined ? null : validateScale(delta.scale) };
  });
  const grantPatch = command.grantPatch == null ? null : (() => {
    const patch = command.grantPatch;
    if (!['active', 'expired', 'revoked', 'reversed'].includes(patch.status) || !['active', 'expired', 'revoked', 'reversed'].includes(patch.expectedStatus)) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'grantPatch statuses are invalid.');
    return { grantId: requiredText(patch.grantId, 'grantPatch.grantId'), status: patch.status, expectedStatus: patch.expectedStatus };
  })();
  return { orgId, operationId, operationType, sourceType: command.sourceType == null ? null : requiredText(command.sourceType, 'sourceType', 48),
    sourceId: command.sourceId == null ? null : requiredText(command.sourceId, 'sourceId'), actorType: command.actorType || 'system',
    actorId: command.actorId == null ? null : requiredText(command.actorId, 'actorId'), reason: command.reason == null ? null : requiredText(command.reason, 'reason', 1000),
    now: command.now || defaultNow, entries, positionDeltas, grantPatch };
}
async function validateEntryReferences(tx, orgId, entries, positionDeltas = [], grantPatch = null) {
  const accounts = [...new Set([...entries.map((entry) => entry.accountId), ...positionDeltas.map((delta) => delta.accountId)])];
  const accountRows = new Map();
  for (const accountId of accounts) {
    const row = rows(await tx.query(`SELECT id,asset,scale,status,account_purpose FROM billing_credit_accounts WHERE org_id=? AND id=? FOR UPDATE`, [orgId, accountId]))[0];
    if (!row) fail(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit account was not found.', { orgId, accountId });
    accountRows.set(accountId, row);
    const relevant = [...entries.filter((entry) => entry.accountId === accountId), ...positionDeltas.filter((delta) => delta.accountId === accountId && delta.asset != null)];
    if (row.status !== 'active') fail(DOMAIN_ERROR_CODES.CONFLICT, 'Credit account is not active.', { accountId, status: row.status });
    for (const entry of relevant) if (row.asset !== entry.asset || Number(row.scale) !== entry.scale) fail(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Journal line amount does not match its credit account asset and scale.', { accountId });
  }
  const grantRows = new Map();
  const grants = [...new Set([...entries.map((entry) => entry.grantId), ...positionDeltas.map((delta) => delta.grantId), grantPatch?.grantId].filter(Boolean))];
  for (const grantId of grants) {
    const row = rows(await tx.query(`SELECT id,asset,scale,status,effective_at,expires_at FROM billing_credit_grants WHERE org_id=? AND id=? FOR UPDATE`, [orgId, grantId]))[0];
    if (!row) fail(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit grant was not found.', { orgId, grantId });
    grantRows.set(grantId, row);
    for (const delta of positionDeltas.filter((item) => item.grantId === grantId)) {
      if (delta.asset == null) delta.asset = row.asset;
      if (delta.scale == null) delta.scale = Number(row.scale);
    }
    const relevant = [...entries.filter((entry) => entry.grantId === grantId), ...positionDeltas.filter((delta) => delta.grantId === grantId)];
    for (const entry of relevant) if (row.asset !== entry.asset || Number(row.scale) !== entry.scale) fail(DOMAIN_ERROR_CODES.MIXED_ASSET, 'Journal line amount does not match its grant asset and scale.', { grantId });
  }
  if (grantPatch && grantRows.get(grantPatch.grantId)?.status !== grantPatch.expectedStatus) {
    fail(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Credit grant status no longer matches the expected status.', grantPatch);
  }
  const lineTotals = new Map();
  for (const entry of entries) {
    const key = `${entry.grantId || ''}|${entry.accountId}`;
    lineTotals.set(key, (lineTotals.get(key) || 0n) + BigInt(entry.amountUnits));
  }
  const positionTotals = new Map();
  for (const delta of positionDeltas) {
    const key = `${delta.grantId}|${delta.accountId}`;
    positionTotals.set(key, (positionTotals.get(key) || 0n) + BigInt(delta.balanceDeltaUnits));
  }
  for (const [accountId, account] of accountRows) {
    if (String(account.account_purpose || 'pool').endsWith('_clearing')) continue;
    const grantsForAccount = new Set([...lineTotals.keys(), ...positionTotals.keys()]
      .filter((key) => key.endsWith(`|${accountId}`)));
    for (const key of grantsForAccount) {
      const journalDelta = lineTotals.get(key) || 0n;
      const positionDelta = positionTotals.get(key) || 0n;
      if (journalDelta !== positionDelta) fail(DOMAIN_ERROR_CODES.INVALID_CONTRACT,
        'Position balance deltas must match journal net movement for non-clearing accounts.',
        { accountId, grantId: key.slice(0, key.lastIndexOf('|')) || null, journalDelta: journalDelta.toString(), positionDelta: positionDelta.toString() });
    }
  }
}
async function updatePosition(tx, entry) {
  if (!entry.grantId) return;
  const existing = rows(await tx.query(`SELECT id,balance_units,reserved_units,version FROM billing_credit_positions
    WHERE org_id=? AND grant_id=? AND account_id=? FOR UPDATE`, [entry.orgId, entry.grantId, entry.accountId]))[0];
  const delta = BigInt(entry.balanceDeltaUnits ?? entry.amountUnits ?? '0');
  const reservedDelta = BigInt(entry.reservedDeltaUnits ?? '0');
  if (delta === 0n && reservedDelta === 0n) return;
  if (!existing) {
    if (delta < 0n || reservedDelta < 0n || reservedDelta > delta) fail(DOMAIN_ERROR_CODES.INSUFFICIENT_CREDITS, 'Credit position would have an invalid balance or reservation.', { grantId: entry.grantId, accountId: entry.accountId });
    const positionId = requiredText(entry.positionId, 'positionId');
    await tx.query(`INSERT INTO billing_credit_positions (id,org_id,grant_id,account_id,asset,scale,balance_units,reserved_units,version,updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,?)`, [positionId, entry.orgId, entry.grantId, entry.accountId, entry.asset, entry.scale, delta.toString(), reservedDelta.toString(), entry.now]);
    return;
  }
  const balance = BigInt(existing.balance_units);
  const reserved = BigInt(existing.reserved_units);
  const next = balance + delta;
  const nextReserved = reserved + reservedDelta;
  if (next < 0n || nextReserved < 0n || nextReserved > next) fail(DOMAIN_ERROR_CODES.INSUFFICIENT_CREDITS, 'Credit movement would produce an invalid balance or reservation.', { grantId: entry.grantId, accountId: entry.accountId });
  if (next > MAX_SIGNED_UNITS) fail(DOMAIN_ERROR_CODES.AMOUNT_OVERFLOW, 'Credit position exceeds signed 64-bit range.');
  const result = await tx.query(`UPDATE billing_credit_positions SET balance_units=?,reserved_units=?,version=version+1,updated_at=? WHERE org_id=? AND id=? AND version=?`,
    [next.toString(), nextReserved.toString(), entry.now, entry.orgId, existing.id, existing.version]);
  if (affected(result) !== 1) fail(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Credit position changed concurrently.');
}

module.exports = { createMysqlCreditRepository };
