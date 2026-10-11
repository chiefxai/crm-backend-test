'use strict';

const crypto = require('node:crypto');
const { getPublicAppUrl } = require('../../../email/appUrl');
const { decryptPayload } = require('./payloadCodec');

function stableKey(event) { return `billing-email:${crypto.createHash('sha256').update(String(event.eventId || `${event.orgId}:${event.eventType}:${event.aggregateId}`)).digest('hex')}`; }
function link(path) { return new URL(path, getPublicAppUrl()).toString(); }

function createBillingEmailEventHandlers({ notificationRepository, deliveryRepository, clock } = {}) {
  if (typeof notificationRepository?.createNotification !== 'function') throw new TypeError('Billing email handlers require notificationRepository.createNotification().');
  if (typeof deliveryRepository?.enqueuePrivate !== 'function') throw new TypeError('Billing email handlers require deliveryRepository.enqueuePrivate().');
  if (typeof clock?.now !== 'function') throw new TypeError('Billing email handlers require clock.now().');

  async function handleContactVerification(tx, event) {
    const data = event.payload || {};
    const protectedPayload = data.encryptedVerificationPayload;
    if (!protectedPayload) throw Object.assign(new Error('Contact verification event has no protected payload.'), { code: 'VERIFICATION_PAYLOAD_MISSING' });
    const secret = decryptPayload(typeof protectedPayload === 'string' ? JSON.parse(protectedPayload) : protectedPayload);
    await deliveryRepository.enqueuePrivate(tx, { orgId: event.orgId, email: secret.email, templateKey: 'billing.contact_verification.v1',
      payload: { verificationUrl: link(`/settings/billing?verifyContact=${encodeURIComponent(secret.verificationToken)}&orgId=${encodeURIComponent(event.orgId)}`),
        expiresAt: secret.expiresAt, orgName: event.orgName || event.orgId }, deliveryKey: stableKey(event), now: clock.now() });
    return { status: 'queued' };
  }

  async function handleRenewalDue(tx, event) {
    const data = event.payload || {}; const now = clock.now(); const pending = data.pendingRenewalStatus === 'pending_verification';
    const needsInformation = data.pendingRenewalStatus === 'needs_information';
    const title = needsInformation ? 'Renewal payment needs information' : pending ? 'Renewal payment awaiting verification' : 'Subscription renewal due soon';
    const message = needsInformation ? 'Update the renewal payment information before the current subscription period ends.'
      : pending ? 'The renewal payment is awaiting manual review. Your current period remains active until its recorded end date.'
        : 'Review the next subscription period and arrange payment before the recorded expiry date.';
    return notificationRepository.createNotification(tx, { orgId: event.orgId, now, templateKey: 'billing.renewal_reminder.v1', notification: {
      notificationKey: `renewal-reminder:${event.aggregateId}`, eventKey: 'subscription.renewal_due', scopeType: 'organization', scopeOwnerId: event.orgId,
      title, message, actionPath: '/settings/billing', occurredAt: data.reminderAt || event.occurredAt,
      payload: { orgName: event.orgName || event.orgId, periodId: data.periodId, periodEndsAt: data.periodEndsAt,
        reminderAt: data.reminderAt, amount: data.amount, currency: data.amount?.currency || 'INR', paymentUrl: link('/settings/billing'),
        pendingVerification: pending, needsInformation, pendingRenewalRequestId: data.pendingRenewalRequestId || null,
        pendingRenewalStatus: data.pendingRenewalStatus || null, termsVersion: data.termsVersion ?? null },
    } });
  }

  async function handlePaymentConfirmed(tx, event) {
    const data = event.payload || {}; const amount = data.receivedAmount || data.expectedAmount || null; const now = clock.now();
    const purpose = data.purpose || 'payment';
    return notificationRepository.createNotification(tx, { orgId: event.orgId, now, templateKey: 'billing.payment_confirmed.v1', notification: {
      notificationKey: `payment-approved:${data.paymentRequestId || event.aggregateId}`, eventKey: 'payment.approved', scopeType: 'organization', scopeOwnerId: event.orgId,
      title: 'Payment approved', message: purpose === 'subscription' ? 'Your subscription payment was approved.'
        : purpose === 'topup' ? 'Your top-up payment was approved and credits were added to the admin pool.' : 'Your invoice payment was approved.',
      actionPath: '/settings/billing', occurredAt: event.occurredAt,
      payload: { orgName: event.orgName || event.orgId, purpose, amount, currency: amount?.currency || 'INR', funding: data.funding || {},
        status: data.status || data.creditState || null, paymentRequestId: data.paymentRequestId || event.aggregateId,
        paymentUrl: link('/settings/billing') },
    } });
  }

  async function handlePeriodActivated(tx, event) {
    const data = event.payload || {}; const now = clock.now();
    return notificationRepository.createNotification(tx, { orgId: event.orgId, now, templateKey: 'billing.subscription_active.v1', notification: {
      notificationKey: `subscription-active:${data.periodId || event.aggregateId}`, eventKey: 'subscription.period_activated',
      scopeType: 'organization', scopeOwnerId: event.orgId, title: 'Subscription active',
      message: 'Your approved subscription period is active and its included usage credits are available.',
      actionPath: '/settings/billing', occurredAt: event.occurredAt,
      payload: { periodId: data.periodId || event.aggregateId, paymentRequestId: data.paymentRequestId || null },
    } });
  }

  async function handleAccessRestricted(tx, event) {
    const data = event.payload || {}; const now = clock.now();
    return notificationRepository.createNotification(tx, { orgId: event.orgId, now, templateKey: 'billing.subscription_suspended.v1', notification: {
      notificationKey: `subscription-suspended:${event.aggregateVersion || event.eventId}`, eventKey: 'subscription.access_restricted',
      scopeType: 'organization', scopeOwnerId: event.orgId, title: 'Subscription access suspended',
      message: 'The subscription billing deadline passed. Arrange payment or contact the platform team to restore access.',
      actionPath: '/settings/billing', occurredAt: event.occurredAt,
      payload: { restrictionDeadline: data.restrictionDeadline || null, cause: data.cause || 'subscription_expired' },
    } });
  }

  async function handleGraceOutcome(tx, event) {
    const data = event.payload || {}; const now = clock.now();
    const requested = event.eventType === 'SubscriptionGraceRequested.v1';
    const approved = event.eventType === 'SubscriptionGraceApproved.v1' || data.decision === 'approve';
    const title = requested ? 'Grace time request submitted' : approved ? 'Grace time approved' : 'Grace time request denied';
    const message = requested ? 'Your request for additional billing grace time was submitted to the platform team.'
      : approved ? 'The platform team approved additional time to resolve subscription billing.'
        : 'The platform team denied the request for additional billing grace time.';
    return notificationRepository.createNotification(tx, { orgId: event.orgId, now, templateKey: requested ? 'billing.grace_requested.v1' : 'billing.grace_decided.v1', notification: {
      notificationKey: `subscription-grace:${data.graceRequestId || event.aggregateId}:${requested ? 'requested' : data.decision}`,
      eventKey: requested ? 'subscription.grace_requested' : approved ? 'subscription.grace_approved' : 'subscription.grace_denied',
      scopeType: 'organization', scopeOwnerId: event.orgId, title, message, actionPath: '/settings/billing', occurredAt: event.occurredAt,
      payload: { graceRequestId: data.graceRequestId || event.aggregateId, periodId: data.periodId || null,
        requestedUntil: data.requestedUntil || null, grantedUntil: data.grantedUntil || null, reason: data.reason || null },
    } });
  }

  return Object.freeze({ handleContactVerification, handleRenewalDue, handlePaymentConfirmed,
    handlePeriodActivated, handleAccessRestricted, handleGraceOutcome });
}

module.exports = { createBillingEmailEventHandlers, stableKey };
