'use strict';

const {
  CONTRACT_VERSION,
  objectAt,
  id,
  text,
  enumValue,
  positiveInt,
  timestamp,
  amount,
  scope,
  operationContext,
  assertOrgScopeMatches,
  assertSameOrgScopes,
} = require('./validation');

function commandBase(value, keys, required = keys, trustedContext) {
  objectAt(value, 'command', ['schemaVersion', ...keys], ['schemaVersion', ...required]);
  if (positiveInt(value.schemaVersion, 'schemaVersion') !== CONTRACT_VERSION) {
    throw new TypeError(`schemaVersion must be ${CONTRACT_VERSION}.`);
  }
  if (!trustedContext) throw new TypeError('authenticated operation context must be supplied by the server, separately from the command payload.');
  return { schemaVersion: CONTRACT_VERSION, context: operationContext(trustedContext) };
}

function orgId(value) { return id(value, 'orgId'); }

function validatePaymentSubmission(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'purpose', 'expectedAmount', 'paymentReference', 'quoteId', 'invoiceId', 'paymentRequestId', 'receiptKey', 'payerNote'],
    ['orgId', 'purpose', 'expectedAmount', 'paymentReference'], trustedContext);
  const purpose = enumValue(value.purpose, ['subscription', 'topup', 'invoice'], 'purpose');
  const result = {
    ...base,
    orgId: orgId(value.orgId),
    purpose,
    expectedAmount: amount(value.expectedAmount, 'expectedAmount'),
    paymentReference: text(value.paymentReference, 'paymentReference', { max: 160 }),
  };
  if (purpose === 'invoice' && !value.invoiceId) throw new TypeError('invoiceId is required for invoice payments.');
  if (purpose !== 'invoice' && !value.quoteId) throw new TypeError('quoteId is required for subscription and top-up payments.');
  if (value.quoteId !== undefined) result.quoteId = id(value.quoteId, 'quoteId');
  if (value.invoiceId !== undefined) result.invoiceId = id(value.invoiceId, 'invoiceId');
  if (value.paymentRequestId !== undefined) result.paymentRequestId = id(value.paymentRequestId, 'paymentRequestId');
  if (value.receiptKey !== undefined) result.receiptKey = text(value.receiptKey, 'receiptKey', { max: 512 });
  if (value.payerNote !== undefined) result.payerNote = text(value.payerNote, 'payerNote', { max: 2000, min: 0 });
  return Object.freeze(result);
}

function validatePaymentDecision(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'paymentRequestId', 'decision', 'reason', 'receivedAmount', 'expectedVersion'],
    ['orgId', 'paymentRequestId', 'decision', 'expectedVersion'], trustedContext);
  const result = {
    ...base,
    orgId: orgId(value.orgId),
    paymentRequestId: id(value.paymentRequestId, 'paymentRequestId'),
    decision: enumValue(value.decision, ['approve', 'reject', 'request_clarification'], 'decision'),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 }),
  };
  if (value.reason !== undefined) result.reason = text(value.reason, 'reason', { max: 2000, min: 0 });
  if (result.decision !== 'approve' && !result.reason) throw new TypeError('reason is required when a payment is not approved.');
  if (value.receivedAmount !== undefined) result.receivedAmount = amount(value.receivedAmount, 'receivedAmount');
  if (result.decision === 'approve' && !result.receivedAmount) throw new TypeError('receivedAmount is required for an approval.');
  return Object.freeze(result);
}

function validatePeriod(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'periodId', 'kind', 'startAt', 'endAt', 'status', 'subscriptionId', 'termsVersionId', 'expectedVersion'],
    ['orgId', 'periodId', 'kind', 'startAt', 'endAt', 'status', 'expectedVersion'], trustedContext);
  const startAt = timestamp(value.startAt, 'startAt');
  const endAt = timestamp(value.endAt, 'endAt');
  if (Date.parse(endAt) <= Date.parse(startAt)) throw new TypeError('endAt must be after startAt; periods use [startAt, endAt).');
  const result = {
    ...base,
    orgId: orgId(value.orgId),
    periodId: id(value.periodId, 'periodId'),
    kind: enumValue(value.kind, ['subscription', 'postpaid'], 'kind'),
    startAt,
    endAt,
    status: enumValue(value.status, ['scheduled', 'active', 'closed', 'cancelled'], 'status'),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 }),
  };
  if (value.subscriptionId !== undefined) result.subscriptionId = id(value.subscriptionId, 'subscriptionId');
  if (value.termsVersionId !== undefined) result.termsVersionId = id(value.termsVersionId, 'termsVersionId');
  if (result.kind === 'subscription' && !result.subscriptionId) throw new TypeError('subscriptionId is required for subscription periods.');
  return Object.freeze(result);
}

function validateGrantIssue(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'grantId', 'kind', 'sourceType', 'sourceId', 'accountScope', 'amount', 'effectiveAt', 'expiresAt', 'eligibleServices', 'expectedVersion'],
    ['orgId', 'grantId', 'kind', 'sourceType', 'sourceId', 'accountScope', 'amount', 'effectiveAt', 'expiresAt', 'expectedVersion'], trustedContext);
  const result = {
    ...base,
    orgId: orgId(value.orgId),
    grantId: id(value.grantId, 'grantId'),
    kind: enumValue(value.kind, ['subscription', 'topup'], 'kind'),
    sourceType: enumValue(value.sourceType, ['payment', 'migration', 'adjustment', 'promotion'], 'sourceType'),
    sourceId: id(value.sourceId, 'sourceId'),
    accountScope: scope(value.accountScope, 'accountScope'),
    amount: amount(value.amount, 'amount'),
    effectiveAt: timestamp(value.effectiveAt, 'effectiveAt'),
    expiresAt: value.expiresAt === null ? null : timestamp(value.expiresAt, 'expiresAt'),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 }),
  };
  assertOrgScopeMatches(result.accountScope, result.orgId, 'accountScope');
  if (result.accountScope.ownerType !== 'organization') throw new TypeError('new grants must initially belong to the organization admin pool.');
  if (result.kind === 'subscription' && result.expiresAt === null) throw new TypeError('subscription grants require an expiry timestamp.');
  if (result.kind === 'topup' && result.expiresAt !== null) throw new TypeError('top-up grants must not expire.');
  if (value.eligibleServices !== undefined) {
    if (!Array.isArray(value.eligibleServices) || value.eligibleServices.length > 100) throw new TypeError('eligibleServices must be an array of at most 100 service identifiers.');
    result.eligibleServices = Object.freeze([...new Set(value.eligibleServices.map((service, index) => text(service, `eligibleServices[${index}]`, { max: 100 })))]);
  }
  return Object.freeze(result);
}

function validateAllocationRuleSet(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'grantKind', 'ruleVersion', 'rules', 'expectedVersion'],
    ['orgId', 'grantKind', 'ruleVersion', 'rules', 'expectedVersion'], trustedContext);
  if (!Array.isArray(value.rules) || value.rules.length > 1000) throw new TypeError('rules must be an array of at most 1000 workspace rules.');
  const seen = new Set();
  const rules = value.rules.map((rule, index) => {
    const path = `rules[${index}]`;
    objectAt(rule, path, ['workspaceId', 'kind', 'amount', 'basisPoints'], ['workspaceId', 'kind']);
    const workspaceId = id(rule.workspaceId, `${path}.workspaceId`);
    if (seen.has(workspaceId)) throw new TypeError(`${path}.workspaceId duplicates another workspace rule.`);
    seen.add(workspaceId);
    const kind = enumValue(rule.kind, ['fixed', 'percentage'], `${path}.kind`);
    if (kind === 'fixed') {
      if (rule.basisPoints !== undefined || rule.amount === undefined) throw new TypeError(`${path} fixed rules require amount and cannot include basisPoints.`);
      return Object.freeze({ workspaceId, kind, amount: amount(rule.amount, `${path}.amount`) });
    }
    if (rule.amount !== undefined || rule.basisPoints === undefined) throw new TypeError(`${path} percentage rules require basisPoints and cannot include amount.`);
    return Object.freeze({ workspaceId, kind, basisPoints: positiveInt(rule.basisPoints, `${path}.basisPoints`, { min: 0, max: 10000 }) });
  });
  return Object.freeze({
    ...base,
    orgId: orgId(value.orgId),
    grantKind: enumValue(value.grantKind, ['subscription', 'topup'], 'grantKind'),
    ruleVersion: positiveInt(value.ruleVersion, 'ruleVersion'),
    rules: Object.freeze(rules),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 }),
  });
}

function validateAllocationRun(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'grantId', 'grantKind', 'runKey', 'ruleVersion', 'periodId'],
    ['orgId', 'grantId', 'grantKind', 'runKey'], trustedContext);
  const result = {
    ...base, orgId: orgId(value.orgId), grantId: id(value.grantId, 'grantId'),
    grantKind: enumValue(value.grantKind, ['subscription', 'topup'], 'grantKind'),
    runKey: id(value.runKey, 'runKey'),
  };
  if (value.ruleVersion !== undefined) result.ruleVersion = positiveInt(value.ruleVersion, 'ruleVersion');
  if (value.periodId !== undefined) result.periodId = id(value.periodId, 'periodId');
  return Object.freeze(result);
}

function validateAllocationRunOperation(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'runId', 'expectedVersion'],
    ['orgId', 'runId'], trustedContext);
  const result = { ...base, orgId: orgId(value.orgId), runId: id(value.runId, 'runId') };
  if (value.expectedVersion !== undefined) result.expectedVersion = positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 });
  return Object.freeze(result);
}

function validateCreditTransfer(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'grantId', 'fromScope', 'toScope', 'amount', 'expectedPositionVersion'],
    ['orgId', 'grantId', 'fromScope', 'toScope', 'amount', 'expectedPositionVersion'], trustedContext);
  const fromScope = scope(value.fromScope, 'fromScope');
  const toScope = scope(value.toScope, 'toScope');
  assertOrgScopeMatches(fromScope, value.orgId, 'fromScope');
  assertOrgScopeMatches(toScope, value.orgId, 'toScope');
  assertSameOrgScopes(fromScope, toScope);
  if (fromScope.ownerId === toScope.ownerId && fromScope.ownerType === toScope.ownerType) throw new TypeError('fromScope and toScope must identify different accounts.');
  return Object.freeze({
    ...base,
    orgId: orgId(value.orgId),
    grantId: id(value.grantId, 'grantId'),
    fromScope,
    toScope,
    amount: amount(value.amount, 'amount'),
    expectedPositionVersion: positiveInt(value.expectedPositionVersion, 'expectedPositionVersion', { min: 0 }),
  });
}

function validateUsageFundingRequest(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'scope', 'usageOperationId', 'sourceRevision', 'service', 'estimatedAmount', 'pricingSnapshot', 'validUntil', 'policyVersion', 'expectedWorkspaceVersion'],
    ['orgId', 'scope', 'usageOperationId', 'service', 'estimatedAmount', 'pricingSnapshot', 'validUntil', 'policyVersion'], trustedContext);
  const requestedScope = scope(value.scope);
  if (requestedScope.ownerType !== 'workspace') throw new TypeError('usage funding must target a workspace scope.');
  assertOrgScopeMatches(requestedScope, value.orgId);
  const result = {
    ...base,
    orgId: orgId(value.orgId),
    scope: requestedScope,
    usageOperationId: id(value.usageOperationId, 'usageOperationId'),
    service: text(value.service, 'service', { max: 100 }),
    estimatedAmount: amount(value.estimatedAmount, 'estimatedAmount'),
    pricingSnapshot: validateUsagePricingSnapshot(value.pricingSnapshot, value.estimatedAmount),
    validUntil: timestamp(value.validUntil, 'validUntil'),
    policyVersion: positiveInt(value.policyVersion, 'policyVersion'),
  };
  if (value.expectedWorkspaceVersion !== undefined) result.expectedWorkspaceVersion = positiveInt(value.expectedWorkspaceVersion, 'expectedWorkspaceVersion', { min: 0 });
  if (value.sourceRevision !== undefined) result.sourceRevision = text(value.sourceRevision, 'sourceRevision', { max: 96 });
  return Object.freeze(result);
}

function validateUsagePricingSnapshot(value, amountValue) {
  objectAt(value, 'pricingSnapshot', ['schemaVersion', 'operationId', 'kind', 'estimated', 'rateVersion', 'ratedAmount', 'rateSnapshot'],
    ['schemaVersion', 'kind', 'estimated', 'rateVersion', 'ratedAmount', 'rateSnapshot']);
  if (positiveInt(value.schemaVersion, 'pricingSnapshot.schemaVersion') !== 1) throw new TypeError('pricingSnapshot.schemaVersion must be 1.');
  if (value.kind !== 'credit_rate' || value.estimated !== false) throw new TypeError('pricingSnapshot must identify a non-estimated credit_rate.');
  const rateVersion = id(value.rateVersion, 'pricingSnapshot.rateVersion');
  const ratedAmount = amount(value.ratedAmount, 'pricingSnapshot.ratedAmount');
  const requestedAmount = amount(amountValue, 'estimatedAmount');
  if (ratedAmount.asset !== requestedAmount.asset || ratedAmount.scale !== requestedAmount.scale || ratedAmount.units !== requestedAmount.units) {
    throw new TypeError('pricingSnapshot.ratedAmount must exactly match estimatedAmount.');
  }
  if (!value.rateSnapshot || typeof value.rateSnapshot !== 'object' || Array.isArray(value.rateSnapshot)) throw new TypeError('pricingSnapshot.rateSnapshot must be an object.');
  if (value.operationId !== undefined) id(value.operationId, 'pricingSnapshot.operationId');
  let encoded;
  try { encoded = JSON.stringify(value); } catch (_) { throw new TypeError('pricingSnapshot must be JSON serializable.'); }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new TypeError('pricingSnapshot must be JSON serializable and no larger than 64 KiB.');
  return Object.freeze(JSON.parse(encoded));
}

function validateUsageReservationExtension(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'workspaceId', 'reservationId', 'additionalAmount', 'pricingSnapshot', 'validUntil', 'expectedVersion'],
    ['orgId', 'workspaceId', 'reservationId', 'additionalAmount', 'pricingSnapshot', 'validUntil', 'expectedVersion'], trustedContext);
  const additionalAmount = amount(value.additionalAmount, 'additionalAmount');
  return Object.freeze({
    ...base,
    orgId: orgId(value.orgId),
    workspaceId: id(value.workspaceId, 'workspaceId'),
    reservationId: id(value.reservationId, 'reservationId'),
    additionalAmount,
    pricingSnapshot: validateUsagePricingSnapshot(value.pricingSnapshot, additionalAmount),
    validUntil: timestamp(value.validUntil, 'validUntil'),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 1 }),
  });
}

function validateUsageReservationRelease(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'workspaceId', 'reservationId', 'expectedVersion'],
    ['orgId', 'workspaceId', 'reservationId', 'expectedVersion'], trustedContext);
  return Object.freeze({
    ...base,
    orgId: orgId(value.orgId),
    workspaceId: id(value.workspaceId, 'workspaceId'),
    reservationId: id(value.reservationId, 'reservationId'),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 1 }),
  });
}

function validateUsageFundingPlan(value) {
  objectAt(value, 'fundingPlan', ['schemaVersion', 'orgId', 'reservationId', 'usageOperationId', 'policyVersion', 'lines'],
    ['schemaVersion', 'orgId', 'reservationId', 'usageOperationId', 'policyVersion', 'lines']);
  if (positiveInt(value.schemaVersion, 'schemaVersion') !== CONTRACT_VERSION) throw new TypeError(`schemaVersion must be ${CONTRACT_VERSION}.`);
  if (!Array.isArray(value.lines) || value.lines.length > 100) throw new TypeError('lines must contain at most 100 funding lines.');
  const lines = value.lines.map((line, index) => {
    const path = `fundingPlan.lines[${index}]`;
    objectAt(line, path, ['sourceType', 'sourceId', 'amount', 'expiresAt'], ['sourceType', 'sourceId', 'amount']);
    const result = {
      sourceType: enumValue(line.sourceType, ['subscription_credit', 'topup_credit', 'postpaid'], `${path}.sourceType`),
      sourceId: id(line.sourceId, `${path}.sourceId`),
      amount: amount(line.amount, `${path}.amount`),
    };
    if (line.expiresAt !== undefined && line.expiresAt !== null) result.expiresAt = timestamp(line.expiresAt, `${path}.expiresAt`);
    if (result.sourceType === 'postpaid' && line.expiresAt) throw new TypeError(`${path} postpaid lines cannot have a credit expiry.`);
    if (result.sourceType === 'subscription_credit' && !result.expiresAt) throw new TypeError(`${path} subscription credit lines require expiresAt.`);
    if (result.sourceType === 'topup_credit' && result.expiresAt) throw new TypeError(`${path} top-up credit lines cannot expire.`);
    return Object.freeze(result);
  });
  return Object.freeze({
    schemaVersion: CONTRACT_VERSION,
    orgId: orgId(value.orgId),
    reservationId: id(value.reservationId, 'reservationId'),
    usageOperationId: id(value.usageOperationId, 'usageOperationId'),
    policyVersion: positiveInt(value.policyVersion, 'policyVersion'),
    lines: Object.freeze(lines),
  });
}

function validatePostpaidPolicy(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'workspaceId', 'policy', 'cyclePeriodId', 'expectedVersion'],
    ['orgId', 'workspaceId', 'policy', 'expectedVersion'], trustedContext);
  objectAt(value.policy, 'policy', ['mode', 'cycleLimit'], ['mode']);
  const mode = enumValue(value.policy.mode, ['disabled', 'limited', 'unlimited'], 'policy.mode');
  let policy;
  if (mode === 'disabled') {
    if (value.policy.cycleLimit !== undefined) throw new TypeError('disabled postpaid policy must not include cycleLimit.');
    policy = Object.freeze({ mode });
  } else if (mode === 'unlimited') {
    if (value.policy.cycleLimit !== undefined) throw new TypeError('unlimited postpaid policy must not include cycleLimit.');
    policy = Object.freeze({ mode });
  } else {
    if (value.policy.cycleLimit === undefined) throw new TypeError('limited postpaid policy requires cycleLimit; zero is a valid limit.');
    policy = Object.freeze({ mode, cycleLimit: amount(value.policy.cycleLimit, 'policy.cycleLimit') });
  }
  const result = {
    ...base,
    schemaVersion: CONTRACT_VERSION,
    orgId: orgId(value.orgId),
    workspaceId: id(value.workspaceId, 'workspaceId'),
    policy,
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 0 }),
  };
  if (value.cyclePeriodId !== undefined) result.cyclePeriodId = id(value.cyclePeriodId, 'cyclePeriodId');
  return Object.freeze(result);
}

function validateFundingModeChange(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'fallbackMode', 'expectedVersion'],
    ['orgId', 'fallbackMode', 'expectedVersion'], trustedContext);
  return Object.freeze({ ...base, orgId: orgId(value.orgId),
    fallbackMode: enumValue(value.fallbackMode, ['prepaid', 'postpaid'], 'fallbackMode'),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 1 }) });
}

function validateUsageSettlement(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'workspaceId', 'reservationId', 'usageEventId', 'expectedVersion', 'finalize'],
    ['orgId', 'workspaceId', 'reservationId', 'usageEventId', 'expectedVersion'], trustedContext);
  if (value.finalize !== undefined && typeof value.finalize !== 'boolean') throw new TypeError('finalize must be a boolean.');
  return Object.freeze({ ...base, orgId: orgId(value.orgId), workspaceId: id(value.workspaceId, 'workspaceId'),
    reservationId: id(value.reservationId, 'reservationId'), usageEventId: id(value.usageEventId, 'usageEventId'),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 1 }), finalize: value.finalize === true });
}

function validateInvoiceClose(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'periodId', 'invoiceNumber', 'dueAt'], ['orgId', 'periodId', 'invoiceNumber', 'dueAt'], trustedContext);
  return Object.freeze({ ...base, orgId: orgId(value.orgId), periodId: id(value.periodId, 'periodId'),
    invoiceNumber: text(value.invoiceNumber, 'invoiceNumber', { max: 96 }), dueAt: timestamp(value.dueAt, 'dueAt') });
}

function validateCreditNote(value, trustedContext) {
  const base = commandBase(value, ['orgId', 'invoiceId', 'invoiceLineId', 'amount', 'reason', 'expectedVersion'],
    ['orgId', 'invoiceId', 'amount', 'reason', 'expectedVersion'], trustedContext);
  return Object.freeze({ ...base, orgId: orgId(value.orgId), invoiceId: id(value.invoiceId, 'invoiceId'),
    invoiceLineId: value.invoiceLineId === undefined ? null : id(value.invoiceLineId, 'invoiceLineId'),
    amount: amount(value.amount, 'amount'), reason: text(value.reason, 'reason', { max: 2000 }),
    expectedVersion: positiveInt(value.expectedVersion, 'expectedVersion', { min: 1 }) });
}

module.exports = {
  validatePaymentSubmission,
  validatePaymentDecision,
  validatePeriod,
  validateGrantIssue,
  validateAllocationRuleSet,
  validateAllocationRun,
  validateAllocationRunOperation,
  validateCreditTransfer,
  validateUsageFundingRequest,
  validateUsageReservationExtension,
  validateUsageReservationRelease,
  validateUsageFundingPlan,
  validatePostpaidPolicy,
  validateFundingModeChange,
  validateUsageSettlement,
  validateInvoiceClose,
  validateCreditNote,
};
