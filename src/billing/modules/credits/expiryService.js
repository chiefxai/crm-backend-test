'use strict';

const crypto = require('node:crypto');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../contracts/errors');
const { validateId } = require('../../kernel/scope');
const { planExpire } = require('./domain');

function fingerprint(value) { return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function operationId(orgId, grantId, accountId) {
  return `expire-${crypto.createHash('sha256').update(`${orgId}\0${grantId}\0${accountId}`).digest('hex').slice(0, 40)}`;
}

/** Processes one grant position per transaction so grants spread across many
 * workspaces never require an unbounded expiry transaction. */
function createCreditExpiryService({ unitOfWork, creditRepository, clock } = {}) {
  if (typeof unitOfWork?.runLifecycle !== 'function') throw new TypeError('Credit expiry requires trusted UnitOfWork.runLifecycle().');
  for (const method of ['getGrantForUpdate', 'getPositionForUpdate', 'ensureAccount', 'applyJournal']) {
    if (typeof creditRepository?.[method] !== 'function') throw new TypeError(`Credit repository requires ${method}().`);
  }
  if (typeof clock?.now !== 'function') throw new TypeError('Credit expiry requires a clock.');

  async function expireGrantPosition({ orgId, grantId, accountId, now = clock.now() } = {}) {
    validateId(orgId, 'orgId'); validateId(grantId, 'grantId'); validateId(accountId, 'accountId');
    const opId = operationId(orgId, grantId, accountId);
    return unitOfWork.runLifecycle({
      orgId, operationId: opId,
      requestFingerprint: fingerprint({ orgId, grantId, accountId, action: 'expire_credit_position_v1' }),
      callback: async (tx) => {
        const grant = await creditRepository.getGrantForUpdate(tx, { orgId, grantId });
        if (!grant) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit grant does not exist.');
        if (!grant.expiresAt || Date.parse(now) < Date.parse(grant.expiresAt)
          || !['active', 'expired'].includes(grant.status)) {
          throw new BillingDomainError(DOMAIN_ERROR_CODES.GRANT_NOT_AVAILABLE, 'Credit grant is not due for expiry.');
        }
        const position = await creditRepository.getPositionForUpdate(tx, { orgId, grantId, accountId });
        if (!position) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Credit position does not exist.');
        const clearing = await creditRepository.ensureAccount(tx, {
          orgId, accountType: 'organization', ownerId: orgId, asset: grant.amount.asset,
          scale: grant.amount.scale, accountPurpose: 'expiry_clearing', now,
        });
        const plan = planExpire({
          orgId, operationId: opId, grant, position, expiryClearingAccountId: clearing.id,
          actor: { type: 'system', id: 'billing-lifecycle' }, now,
          reason: `Expire subscription grant ${grantId}`,
        });
        if (plan.journal || plan.grantPatch) {
          const journal = plan.journal || {
            orgId, operationId: opId, operationType: 'credit_expire',
            sourceType: 'credit_grant', sourceId: grantId, actorType: 'system', actorId: 'billing-lifecycle',
            reason: `Mark expired grant ${grantId} while held funds resolve`, now, entries: [],
          };
          await creditRepository.applyJournal(tx, { ...journal, positionDeltas: plan.positionDeltas, grantPatch: plan.grantPatch });
        }
        const expiredUnits = plan.journal
          ? (BigInt(plan.journal.entries.find((entry) => entry.entryType === 'credit_expiry')?.amountUnits || '0') * -1n).toString()
          : '0';
        const heldUnits = plan.heldForResolution ? BigInt(position.amount.units) : BigInt(position.reservedUnits);
        return Object.freeze({
          grantId, accountId, status: plan.grantPatch?.status || grant.status,
          expiredUnits, heldUnits: heldUnits.toString(), heldForResolution: Boolean(plan.heldForResolution),
        });
      },
    });
  }

  return Object.freeze({ expireGrantPosition });
}

module.exports = { createCreditExpiryService, expiryOperationId: operationId };
