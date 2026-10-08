'use strict';

/**
 * Dependency-free ports for the billing domain.
 *
 * These JSDoc contracts describe boundaries only. Payload and result validation
 * belongs to `contracts/`; persistence adapters own their database details.
 * Repositories receive an opaque transaction context and must never open or
 * commit their own transaction.
 *
 * Shared value shapes:
 * @typedef {{orgId: string, ownerType: 'organization'|'workspace', ownerId: string}} BillingScope
 * @typedef {{asset: string, units: string, scale: number}} BillingAmount
 * @typedef {{orgId: string, operationId: string, requestFingerprint: string, actor: object, correlationId?: string}} OperationContext
 * @typedef {{eventId: string, eventType: string, schemaVersion: number, orgId: string, aggregateType: string, aggregateId: string, aggregateVersion: number, occurredAt: string, correlationId: string, causationId?: string, payload: object}} BillingEvent
 * @typedef {object} TransactionContext Opaque handle created and owned by a transaction runner.
 */

/**
 * @typedef {object} UnitOfWorkPort
 * @property {(args: {orgId: string, operationId: string, requestFingerprint: string, expectedVersions?: object, callback: (tx: TransactionContext, priorResult?: object) => Promise<object>}) => Promise<object>} runFinancial
 * @description Owns the organization financial lock, idempotency result, lock
 * ordering, bounded retry, journal and transactional outbox. It commits or rolls
 * back the callback's complete financial mutation. Never call external providers,
 * SMTP, object storage or other network services inside the callback.
 */

/**
 * @typedef {object} ConsumerRunnerPort
 * @property {(args: {orgId: string, operationId: string, requestFingerprint: string, callback: (tx: TransactionContext) => Promise<object>}) => Promise<object>} runConsumer
 * @description Owns a branded transaction for durable event consumption. It
 * does not enforce financial-account status or persist command results; the
 * consumer inbox marker and all handler database effects must share its tx.
 * External/provider effects must be emitted through a downstream outbox.
 */

/**
 * Repositories are grouped by owned records. Every read or write that participates
 * in a financial command takes the opaque transaction context as its first arg.
 * Read-only reporting belongs to BillingReadStore.
 *
 * @typedef {object} BillingRepositoriesPort
 * @property {PaymentRepositoryPort} payments
 * @property {SubscriptionRepositoryPort} subscriptions
 * @property {CreditRepositoryPort} credits
 * @property {AllocationRepositoryPort} allocations
 * @property {UsageRepositoryPort} usage
 * @property {PostpaidRepositoryPort} postpaid
 * @property {OperationRepositoryPort} operations
 */

/** @typedef {{getForUpdate(tx: TransactionContext, args: object): Promise<object|null>, insert(tx: TransactionContext, record: object): Promise<void>, update(tx: TransactionContext, record: object): Promise<void>, listForOrganization(tx: TransactionContext, args: object): Promise<object[]>}} PaymentRepositoryPort */
/** @typedef {{getForUpdate(tx: TransactionContext, args: object): Promise<object|null>, insert(tx: TransactionContext, record: object): Promise<void>, update(tx: TransactionContext, record: object): Promise<void>, listForOrganization(tx: TransactionContext, args: object): Promise<object[]>}} SubscriptionRepositoryPort */
/** @typedef {{getPositionsForUpdate(tx: TransactionContext, args: object): Promise<object[]>, appendJournal(tx: TransactionContext, journal: object): Promise<void>, applyPositionChanges(tx: TransactionContext, changes: object[]): Promise<void>, insertGrant(tx: TransactionContext, grant: object): Promise<void>}} CreditRepositoryPort */
/** @typedef {{getRules(tx: TransactionContext, args: object): Promise<object|null>, insertRuleVersion(tx: TransactionContext, record: object): Promise<void>, insertRun(tx: TransactionContext, record: object): Promise<void>, getRunForUpdate(tx: TransactionContext, args: object): Promise<object|null>}} AllocationRepositoryPort */
/** @typedef {{insertUsageEvent(tx: TransactionContext, event: object): Promise<void>, getReservationForUpdate(tx: TransactionContext, args: object): Promise<object|null>, saveReservation(tx: TransactionContext, reservation: object): Promise<void>}} UsageRepositoryPort */
/** @typedef {{getExposureForUpdate(tx: TransactionContext, args: object): Promise<object|null>, applyExposure(tx: TransactionContext, change: object): Promise<void>, insertInvoice(tx: TransactionContext, invoice: object): Promise<void>}} PostpaidRepositoryPort */
/** @typedef {{findResult(tx: TransactionContext, operationId: string): Promise<object|null>, saveResult(tx: TransactionContext, operationId: string, fingerprint: string, result: object): Promise<void>}} OperationRepositoryPort */

/**
 * Verifies external payment evidence. Manual verification must be passed an
 * already-authorized reviewer decision; gateway adapters must verify signatures
 * and provider event identity before returning normalized evidence. Verification
 * is outside the financial transaction. Fulfillment resolves the approved quote.
 * @typedef {object} PaymentVerifierPort
 * @property {(evidence: object) => Promise<{provider: string, sourceEventId: string, verified: boolean, reference: string, receivedAmount: BillingAmount, occurredAt: string, metadata?: object}>} verify
 */

/**
 * Provider integration boundary for metering and call control. Methods may make
 * external calls and therefore must run outside UnitOfWork callbacks. Implementors
 * must make operations idempotent using the supplied operation identity.
 * @typedef {object} UsageAdapterPort
 * @property {(request: object) => Promise<object>} authorize
 * @property {(request: object) => Promise<object>} extend
 * @property {(request: object) => Promise<object>} release
 * @property {(request: object) => Promise<object>} stop
 * @property {(providerEvent: object) => Promise<object>} normalizeMeasuredEvent
 */

/** @typedef {object} RatingPolicyPort @property {(measuredEvent: object, purchasedRateSnapshot: object) => object} rate */
/** @typedef {object} EntitlementPolicyPort @property {(scope: BillingScope, purchasedTerms: object, capability: string, inventoryVersion: string) => {allowed: boolean, reason?: string, policyVersion?: string}} evaluate */

/**
 * Funding source mutations participate in the caller's transaction. This port
 * does not contact a payment gateway and cannot mint value from provider evidence.
 * @typedef {object} FundingSourcePort
 * @property {(context: object) => boolean} supports
 * @property {(tx: TransactionContext, request: object) => Promise<object>} plan
 * @property {(tx: TransactionContext, request: object) => Promise<object>} reserve
 * @property {(tx: TransactionContext, request: object) => Promise<object>} settle
 * @property {(tx: TransactionContext, request: object) => Promise<object>} release
 */

/** @typedef {object} AllocationPolicyPort @property {(grant: object, rules: object, eligibleOwners: object[]) => object} preview */
/** @typedef {object} CalendarPolicyPort @property {(args: {anchor: string, timezone: string, interval: object, previousEnd?: string, now: string}) => {start: string, end: string, anchorDay?: number}} resolveNextPeriod */
/** @typedef {object} ClockPort @property {() => string} now */
/** @typedef {object} IdSourcePort @property {(kind?: string) => string} newId */

/**
 * Appends events in the same database transaction as their financial mutation.
 * External delivery is handled by a worker after commit.
 * @typedef {object} OutboxStorePort
 * @property {(tx: TransactionContext, event: BillingEvent) => Promise<void>} append
 */

/**
 * Claims durable work with expiring leases and fencing tokens. A stale claimant
 * must not be able to acknowledge, retry or overwrite a newer claim.
 * @typedef {object} JobClaimerPort
 * @property {(args: {workerId: string, limit: number, now: string, leaseSeconds: number, types?: string[]}) => Promise<object[]>} claimDue
 * @property {(claim: object, args: {now: string, leaseSeconds: number}) => Promise<object>} renew
 * @property {(claim: object, result?: object) => Promise<void>} acknowledge
 * @property {(claim: object, args: {availableAt: string, errorCode: string, message?: string}) => Promise<void>} retry
 * @property {(claim: object, args: {errorCode: string, message?: string}) => Promise<void>} deadLetter
 */

/** @typedef {object} NotificationChannelPort @property {(message: object, stableDeliveryId: string) => Promise<{status: 'accepted'|'skipped'|'retryable'|'permanent_failure', providerMessageId?: string, errorCode?: string}>} deliver */

/**
 * Cursor-based, organization/workspace-scoped projections. This port is for
 * display and reporting only; its results never authorize financial mutations.
 * @typedef {object} BillingReadStorePort
 * @property {(scope: BillingScope, args: {cursor?: string, limit: number}) => Promise<{items: object[], nextCursor?: string, asOf?: string, version?: number}>} getOverview
 * @property {(scope: BillingScope, args: {cursor?: string, limit: number, filters?: object}) => Promise<{items: object[], nextCursor?: string, asOf?: string, version?: number}>} listLedger
 * @property {(scope: BillingScope, args: {cursor?: string, limit: number, filters?: object}) => Promise<{items: object[], nextCursor?: string, asOf?: string, version?: number}>} listUsage
 * @property {(scope: BillingScope, args: {cursor?: string, limit: number, filters?: object}) => Promise<{items: object[], nextCursor?: string, asOf?: string, version?: number}>} listInvoices
 */

const PORT_METHODS = Object.freeze({
  UnitOfWork: ['runFinancial'],
  ConsumerRunner: ['runConsumer'],
  PaymentRepository: ['getForUpdate', 'insert', 'update', 'listForOrganization'],
  SubscriptionRepository: ['getForUpdate', 'insert', 'update', 'listForOrganization'],
  CreditRepository: ['getPositionsForUpdate', 'appendJournal', 'applyPositionChanges', 'insertGrant'],
  AllocationRepository: ['getRules', 'insertRuleVersion', 'insertRun', 'getRunForUpdate'],
  UsageRepository: ['insertUsageEvent', 'getReservationForUpdate', 'saveReservation'],
  PostpaidRepository: ['getExposureForUpdate', 'applyExposure', 'insertInvoice'],
  OperationRepository: ['findResult', 'saveResult'],
  PaymentVerifier: ['verify'],
  UsageAdapter: ['authorize', 'extend', 'release', 'stop', 'normalizeMeasuredEvent'],
  RatingPolicy: ['rate'],
  EntitlementPolicy: ['evaluate'],
  FundingSource: ['supports', 'plan', 'reserve', 'settle', 'release'],
  AllocationPolicy: ['preview'],
  CalendarPolicy: ['resolveNextPeriod'],
  Clock: ['now'],
  IdSource: ['newId'],
  OutboxStore: ['append'],
  JobClaimer: ['claimDue', 'renew', 'acknowledge', 'retry', 'deadLetter'],
  NotificationChannel: ['deliver'],
  BillingReadStore: ['getOverview', 'listLedger', 'listUsage', 'listInvoices'],
});

/**
 * Validate only that an adapter implements the named port methods. This does not
 * validate DTOs, policies, persistence state, or financial invariants.
 * @param {string} portName
 * @param {object} implementation
 * @returns {object} the same implementation, for composition-time use
 */
function assertPort(portName, implementation) {
  const required = PORT_METHODS[portName];
  if (!required) throw new TypeError(`Unknown billing port: ${portName}`);
  if (!implementation || (typeof implementation !== 'object' && typeof implementation !== 'function')) {
    throw new TypeError(`Billing ${portName} implementation must be an object`);
  }
  const missing = required.filter((method) => typeof implementation[method] !== 'function');
  if (missing.length) throw new TypeError(`Billing ${portName} is missing methods: ${missing.join(', ')}`);
  return implementation;
}

/**
 * Ensure repositories are called with a transaction token from UnitOfWork.
 * The token stays opaque here so MySQL and any future adapter can define it.
 * @param {unknown} tx
 * @returns {object}
 */
function requireTransactionContext(tx) {
  if (!tx || (typeof tx !== 'object' && typeof tx !== 'function')) {
    throw new TypeError('Billing repository operation requires a transaction-runner context');
  }
  return tx;
}

/**
 * @param {object} ports
 * @returns {object} validated adapters, preserving caller keys
 */
function validatePortSet(ports) {
  if (!ports || typeof ports !== 'object' || Array.isArray(ports)) {
    throw new TypeError('Billing ports must be supplied as an object');
  }
  for (const [name, implementation] of Object.entries(ports)) assertPort(name, implementation);
  return ports;
}

module.exports = {
  PORT_METHODS,
  assertPort,
  requireTransactionContext,
  validatePortSet,
};
