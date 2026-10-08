'use strict';

const crypto = require('node:crypto');
const { normalizeEmail } = require('./repositories/mysqlNotificationRepository');
const { normalizePolicy, evaluateAlert, notificationKey } = require('./domain');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');

function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function opContext(context) {
  if (!context || typeof context.operationId !== 'string' || typeof context.requestFingerprint !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(context.requestFingerprint) || !context.actor || typeof context.actor.id !== 'string') {
    throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Trusted operation context is required.');
  }
  return context;
}
function requiredFunction(fn, name) { if (typeof fn !== 'function') throw new TypeError(`${name} is required.`); }

function createNotificationService({ unitOfWork, repository, outbox, idSource, clock, authorizeContact,
  authorizePolicy, authorizeRead, authorizeObservation, encryptVerificationPayload, verificationTtlSeconds = 86400 } = {}) {
  if (typeof unitOfWork?.runFinancial !== 'function') throw new TypeError('Notification service requires UnitOfWork.runFinancial().');
  for (const method of ['createContact', 'findContactByVerificationHash', 'markContactVerified', 'disableContact', 'listContacts',
    'savePolicy', 'listPoliciesForUpdate', 'getAlertStateForUpdate', 'saveAlertState', 'createNotification', 'resolveRecipients', 'listForUser', 'markRead', 'markAllRead']) {
    if (typeof repository?.[method] !== 'function') throw new TypeError(`Notification repository requires ${method}().`);
  }
  if (typeof outbox?.enqueue !== 'function') throw new TypeError('Notification service requires a transactional outbox for contact verification.');
  if (typeof encryptVerificationPayload !== 'function') throw new TypeError('Notification service requires an encrypted verification-payload codec.');
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Notification service requires ID source and clock.');
  for (const [fn, name] of [[authorizeContact, 'authorizeContact'], [authorizePolicy, 'authorizePolicy'],
    [authorizeRead, 'authorizeRead'], [authorizeObservation, 'authorizeObservation']]) requiredFunction(fn, name);
  if (!Number.isSafeInteger(verificationTtlSeconds) || verificationTtlSeconds < 300 || verificationTtlSeconds > 30 * 86400) throw new TypeError('verificationTtlSeconds must be from 300 to 2592000.');

  async function addContact({ orgId, email, displayName = null, preferences = {}, trustedContext } = {}) {
    const context = opContext(trustedContext); email = normalizeEmail(email);
    if (await authorizeContact({ actor: context.actor, orgId, action: 'contact.add' }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor cannot manage billing contacts.');
    const request = { orgId, email, displayName, preferences };
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = clock.now(); const expiresAt = new Date(Date.parse(now) + verificationTtlSeconds * 1000).toISOString();
    const operationFingerprint = fingerprint(request);
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId, requestFingerprint: operationFingerprint,
      expectedVersions: context.expectedVersions, callback: async (tx) => {
        const contact = await repository.createContact(tx, { orgId, email, displayName, verificationTokenHash: tokenHash,
          verificationExpiresAt: expiresAt, preferences, createdBy: context.actor.id });
        await outbox.enqueue(tx, { events: [{ eventId: idSource.newId('billing-event'), eventType: 'BillingContactVerificationRequested.v1',
          schemaVersion: 1, operationId: context.operationId, orgId, aggregateType: 'BillingContact', aggregateId: contact.id,
          aggregateVersion: 1, occurredAt: now, correlationId: context.correlationId || context.operationId,
          causationId: context.causationId, payload: { contactId: contact.id,
            encryptedVerificationPayload: encryptVerificationPayload({ email, verificationToken: token, expiresAt }), expiresAt } }] });
        return Object.freeze({ contact, verification: 'pending' });
      },
    });
  }

  async function verifyContact({ orgId, token, trustedContext } = {}) {
    const context = opContext(trustedContext);
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Verification token is invalid.');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const now = clock.now(); const operationFingerprint = fingerprint({ orgId, tokenHash });
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId, requestFingerprint: operationFingerprint,
      expectedVersions: context.expectedVersions, callback: async (tx) => {
        const contact = await repository.findContactByVerificationHash(tx, { orgId, tokenHash });
        if (!contact || contact.status !== 'pending_verification' || !contact.verificationExpiresAt || Date.parse(contact.verificationExpiresAt) <= Date.parse(now)) {
          throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Contact verification link is invalid or expired.');
        }
        await repository.markContactVerified(tx, { orgId, contactId: contact.id, now });
        return Object.freeze({ contactId: contact.id, status: 'verified' });
      },
    });
  }

  async function removeContact({ orgId, contactId, trustedContext } = {}) {
    const context = opContext(trustedContext);
    if (await authorizeContact({ actor: context.actor, orgId, action: 'contact.remove', contactId }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor cannot manage billing contacts.');
    const now = clock.now();
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId, requestFingerprint: fingerprint({ orgId, contactId, action: 'remove_contact' }),
      expectedVersions: context.expectedVersions, callback: async (tx) => {
        const changed = await repository.disableContact(tx, { orgId, contactId, now });
        return Object.freeze({ contactId, status: changed ? 'disabled' : 'unchanged' });
      },
    });
  }

  async function listContacts({ orgId, trustedContext } = {}) {
    const context = opContext(trustedContext);
    if (await authorizeContact({ actor: context.actor, orgId, action: 'contact.read' }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor cannot read billing contacts.');
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId,
      requestFingerprint: fingerprint({ orgId, action: 'list_contacts' }), callback: (tx) => repository.listContacts(tx, { orgId }) });
  }

  async function listPolicies({ orgId, scopeType, scopeOwnerId, eventKey, trustedContext } = {}) {
    const context = opContext(trustedContext);
    if (await authorizePolicy({ actor: context.actor, orgId, policy: { scopeType, scopeOwnerId, eventKey }, action: 'policy.read' }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor cannot read billing notification policies.');
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId,
      requestFingerprint: fingerprint({ orgId, scopeType: scopeType || null, scopeOwnerId: scopeOwnerId || null, eventKey: eventKey || null, action: 'list_policies' }),
      callback: (tx) => repository.listPoliciesForUpdate(tx, { orgId, scopeType, scopeOwnerId, eventKey }),
    });
  }

  async function setPolicy({ orgId, policy: input, expectedVersion = 0, trustedContext } = {}) {
    const context = opContext(trustedContext); const policy = normalizePolicy(input);
    if (await authorizePolicy({ actor: context.actor, orgId, policy, action: 'policy.write' }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor cannot manage billing notification policies.');
    const now = clock.now();
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId,
      requestFingerprint: fingerprint({ orgId, policy, expectedVersion }),
      expectedVersions: context.expectedVersions, callback: (tx) => repository.savePolicy(tx, { orgId, policy, expectedVersion,
        actorId: context.actor.id, now }),
    });
  }

  async function observe({ orgId, scopeType, scopeOwnerId, eventKey, thresholdKey, observedUnits, limitUnits = null,
    title, message, payload = {}, actionPath = null, trustedContext } = {}) {
    const context = opContext(trustedContext);
    const observation = { orgId, scopeType, scopeOwnerId, eventKey, thresholdKey, observedUnits: String(observedUnits),
      limitUnits: limitUnits == null ? null : String(limitUnits), title, message, payload, actionPath };
    if (await authorizeObservation({ actor: context.actor, orgId, scopeType, scopeOwnerId, eventKey }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor cannot publish this billing observation.');
    if (typeof thresholdKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(thresholdKey)) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'thresholdKey is invalid.');
    if (typeof title !== 'string' || !title.trim() || title.length > 255 || typeof message !== 'string' || !message.trim() || message.length > 4000) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Notification title and message are required and must fit their storage limits.');
    const now = clock.now(); const operationFingerprint = fingerprint(observation);
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId, requestFingerprint: operationFingerprint,
      expectedVersions: context.expectedVersions, callback: async (tx) => {
        const policies = await repository.listPoliciesForUpdate(tx, { orgId, scopeType, scopeOwnerId, eventKey });
        const transitions = [];
        for (const policy of policies) {
          const stateKey = thresholdKey;
          const prior = await repository.getAlertStateForUpdate(tx, { orgId, scopeType, scopeOwnerId, eventKey, thresholdKey: stateKey });
          const transition = evaluateAlert({ policy, state: prior, observedUnits, limitUnits, now });
          if (transition.action === 'none') {
            if (!prior || prior.lastObservedUnits !== transition.observedUnits || prior.lastObservedLimitUnits !== transition.limitUnits) {
              await repository.saveAlertState(tx, { orgId, policyId: policy.id, scopeType, scopeOwnerId, eventKey,
                thresholdKey: stateKey, state: prior?.state || 'clear', observedUnits: transition.observedUnits,
                limitUnits: transition.limitUnits, crossingSequence: prior?.crossingSequence || 0, crossedAt: prior?.crossedAt || null,
                recoveredAt: prior?.recoveredAt || null, nextEligibleAt: prior?.nextEligibleAt || null,
                expectedVersion: prior?.version || 0, now });
            }
            continue;
          }
          const seq = transition.action === 'trigger' ? (prior?.crossingSequence || 0) + 1 : (prior?.crossingSequence || 0);
          const nextEligibleAt = transition.action === 'trigger'
            ? new Date(Date.parse(now) + policy.cooldownSeconds * 1000).toISOString()
            : prior?.nextEligibleAt || null;
          await repository.saveAlertState(tx, { orgId, policyId: policy.id, scopeType, scopeOwnerId, eventKey,
            thresholdKey: stateKey, state: transition.nextState, observedUnits: transition.observedUnits,
            limitUnits: transition.limitUnits, crossingSequence: seq,
            crossedAt: transition.action === 'trigger' ? now : prior?.crossedAt || null,
            recoveredAt: transition.action === 'recover' ? now : null, nextEligibleAt,
            expectedVersion: prior?.version || 0, now });
          const key = notificationKey({ orgId, scopeType, scopeOwnerId, eventKey,
            thresholdKey: `${stateKey}:${transition.action}`, crossingSequence: seq });
          const text = transition.action === 'trigger' ? message : `${message} The threshold has recovered.`;
          const notification = await repository.createNotification(tx, { orgId, now, notification: {
            notificationKey: key, eventKey, scopeType, scopeOwnerId, title,
            message: text, actionPath, occurredAt: now,
            payload: { ...payload, transition: transition.action, thresholdKey: stateKey,
              observedUnits: transition.observedUnits, limitUnits: transition.limitUnits,
              crossingSequence: seq, thresholdReached: transition.thresholdReached || null },
          } });
          transitions.push(Object.freeze({ action: transition.action, policyId: policy.id, notification }));
        }
        return Object.freeze({ transitions: Object.freeze(transitions) });
      },
    });
  }

  async function listForUser({ orgId, userId, before, limit = 50, trustedContext } = {}) {
    const context = opContext(trustedContext);
    if (await authorizeRead({ actor: context.actor, orgId, userId, action: 'notifications.read' }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor cannot read this billing notification feed.');
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId, requestFingerprint: context.requestFingerprint,
      callback: (tx) => repository.listForUser(tx, { orgId, userId, before, limit }),
    });
  }

  async function markRead({ orgId, userId, notificationId, all = false, scopeType, scopeOwnerId, trustedContext } = {}) {
    const context = opContext(trustedContext);
    if (await authorizeRead({ actor: context.actor, orgId, userId, action: 'notifications.mark_read' }) !== true) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Actor cannot update this billing notification feed.');
    if ((scopeType === undefined) !== (scopeOwnerId === undefined)) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'scopeType and scopeOwnerId must be supplied together.');
    const now = clock.now();
    return unitOfWork.runFinancial({ orgId, operationId: context.operationId, requestFingerprint: fingerprint({ orgId, userId, notificationId: notificationId || null, all, scopeType: scopeType || null, scopeOwnerId: scopeOwnerId || null }),
      expectedVersions: context.expectedVersions, callback: (tx) => all
        ? repository.markAllRead(tx, { orgId, userId, now, scopeType, scopeOwnerId })
        : repository.markRead(tx, { orgId, userId, notificationId, now }),
    });
  }

  return Object.freeze({ addContact, verifyContact, removeContact, listContacts, listPolicies, setPolicy, observe, listForUser, markRead });
}

module.exports = { createNotificationService, notificationFingerprint: fingerprint };
