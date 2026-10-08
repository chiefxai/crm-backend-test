'use strict';

const crypto = require('node:crypto');
const { assertTransactionContext } = require('../../../kernel/transactionContext');
const { validateId } = require('../../../kernel/scope');
const { BillingDomainError, DOMAIN_ERROR_CODES } = require('../../../contracts/errors');

function rowsOf(value) { const rows = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value; return Array.isArray(rows) ? rows : rows?.rows || []; }
function affected(value) { const result = Array.isArray(value) && value.length === 2 && !Array.isArray(value[0]) ? value[0] : value; return Number(result?.affectedRows ?? result?.rowCount ?? 0); }
function parseJson(value, label) { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch (cause) { throw new BillingDomainError(DOMAIN_ERROR_CODES.RETRYABLE_STORAGE, `${label} contains invalid JSON.`, { retryable: true, details: { cause: cause.message } }); } }
function assertOrg(tx, orgId) { assertTransactionContext(tx); validateId(orgId, 'orgId'); if (tx.metadata?.orgId !== orgId) throw new TypeError('Notification organization must match the transaction organization.'); }
function normalizeEmail(value) { const email = String(value || '').trim().toLowerCase(); if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'A valid notification email address is required.'); return email; }
function idempotencyKey(value) { return `notification:${crypto.createHash('sha256').update(String(value)).digest('hex')}`; }

function createMysqlNotificationRepository({ idSource, clock } = {}) {
  if (typeof idSource?.newId !== 'function' || typeof clock?.now !== 'function') throw new TypeError('Notification repository requires ID source and clock.');

  async function getContactForUpdate(tx, { orgId, contactId }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(`SELECT id,org_id,user_id,email,display_name,status,verification_token_hash,verification_expires_at,
        verified_at,disabled_at,notification_preferences_json,created_by,created_at,updated_at
      FROM billing_contacts WHERE org_id=? AND id=? FOR UPDATE`, [orgId, validateId(contactId, 'contactId')]))[0];
    return row ? mapContact(row) : null;
  }

  async function createContact(tx, { orgId, email, displayName, verificationTokenHash, verificationExpiresAt, preferences, createdBy }) {
    assertOrg(tx, orgId); const id = idSource.newId('billing-contact'); const now = clock.now();
    await tx.query(`INSERT INTO billing_contacts (id,org_id,email,display_name,status,verification_token_hash,verification_expires_at,
        notification_preferences_json,created_by,created_at,updated_at)
      VALUES (?,?,?,?,'pending_verification',?,?,?,?,?,?)`, [id, orgId, normalizeEmail(email), displayName || null,
      verificationTokenHash, verificationExpiresAt, JSON.stringify(preferences || {}), createdBy || null, now, now]);
    return getContactForUpdate(tx, { orgId, contactId: id });
  }

  async function findContactByVerificationHash(tx, { orgId, tokenHash }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(`SELECT id,org_id,user_id,email,display_name,status,verification_token_hash,verification_expires_at,
        verified_at,disabled_at,notification_preferences_json,created_by,created_at,updated_at
      FROM billing_contacts WHERE org_id=? AND verification_token_hash=? FOR UPDATE`, [orgId, tokenHash]))[0];
    return row ? mapContact(row) : null;
  }

  async function markContactVerified(tx, { orgId, contactId, now }) {
    assertOrg(tx, orgId);
    const result = await tx.query(`UPDATE billing_contacts SET status='verified',verification_token_hash=NULL,
        verification_expires_at=NULL,verified_at=?,updated_at=? WHERE org_id=? AND id=? AND status='pending_verification'`,
    [now, now, orgId, contactId]);
    return affected(result) === 1;
  }

  async function disableContact(tx, { orgId, contactId, now }) {
    assertOrg(tx, orgId);
    const result = await tx.query(`UPDATE billing_contacts SET status='disabled',verification_token_hash=NULL,
        verification_expires_at=NULL,disabled_at=?,updated_at=? WHERE org_id=? AND id=? AND status<>'disabled'`,
    [now, now, orgId, contactId]);
    return affected(result) === 1;
  }

  async function listContacts(tx, { orgId }) {
    assertOrg(tx, orgId);
    return rowsOf(await tx.query(`SELECT id,org_id,user_id,email,display_name,status,verified_at,disabled_at,
        notification_preferences_json,created_by,created_at,updated_at FROM billing_contacts WHERE org_id=? ORDER BY created_at,id`, [orgId])).map(mapContact);
  }

  async function getPolicyForUpdate(tx, { orgId, scopeType, scopeOwnerId, eventKey }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(`SELECT id,org_id,scope_type,scope_owner_id,event_key,amount_threshold_units,
        percentage_threshold_bps,recovery_amount_units,recovery_percentage_bps,cooldown_seconds,enabled,policy_json,version,updated_by
      FROM billing_notification_policies WHERE org_id=? AND scope_type=? AND scope_owner_id=? AND event_key=? FOR UPDATE`,
    [orgId, scopeType, scopeOwnerId, eventKey]))[0];
    return row ? mapPolicy(row) : null;
  }

  async function listPoliciesForUpdate(tx, { orgId, scopeType, scopeOwnerId, eventKey }) {
    assertOrg(tx, orgId);
    const params = [orgId]; let filters = '';
    if (scopeType) { filters += ' AND scope_type=?'; params.push(scopeType); }
    if (scopeOwnerId) { filters += ' AND scope_owner_id=?'; params.push(scopeOwnerId); }
    if (eventKey) { filters += ' AND event_key=?'; params.push(eventKey); }
    return rowsOf(await tx.query(`SELECT id,org_id,scope_type,scope_owner_id,event_key,amount_threshold_units,
        percentage_threshold_bps,recovery_amount_units,recovery_percentage_bps,cooldown_seconds,enabled,policy_json,version,updated_by
      FROM billing_notification_policies WHERE org_id=?${filters} ORDER BY scope_type,scope_owner_id,event_key FOR UPDATE`, params)).map(mapPolicy);
  }

  async function savePolicy(tx, { orgId, policy, expectedVersion, actorId, now }) {
    assertOrg(tx, orgId);
    await assertValidScope(tx, orgId, policy.scopeType, policy.scopeOwnerId);
    const prior = await getPolicyForUpdate(tx, { orgId, scopeType: policy.scopeType, scopeOwnerId: policy.scopeOwnerId, eventKey: policy.eventKey });
    if (prior && Number(prior.version) !== Number(expectedVersion)) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Notification policy version is stale.', { details: { expectedVersion, actualVersion: prior.version } });
    if (!prior && Number(expectedVersion || 0) !== 0) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Notification policy does not exist at the expected version.');
    const id = prior?.id || idSource.newId('billing-notification-policy');
    if (prior) {
      const result = await tx.query(`UPDATE billing_notification_policies SET amount_threshold_units=?,percentage_threshold_bps=?,
          recovery_amount_units=?,recovery_percentage_bps=?,cooldown_seconds=?,enabled=?,policy_json=?,updated_by=?,updated_at=?,version=version+1
        WHERE org_id=? AND id=? AND version=?`, [policy.amountThresholdUnits, policy.percentageThresholdBps,
        policy.recoveryAmountUnits, policy.recoveryPercentageBps, policy.cooldownSeconds, policy.enabled ? 1 : 0,
        JSON.stringify(policy.preferences || {}), actorId || null, now, orgId, id, prior.version]);
      if (affected(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Notification policy changed concurrently.');
    } else {
      await tx.query(`INSERT INTO billing_notification_policies (id,org_id,scope_type,scope_owner_id,event_key,amount_threshold_units,
          percentage_threshold_bps,recovery_amount_units,recovery_percentage_bps,cooldown_seconds,enabled,policy_json,version,updated_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,1,?,?,?)`, [id, orgId, policy.scopeType, policy.scopeOwnerId, policy.eventKey,
        policy.amountThresholdUnits, policy.percentageThresholdBps, policy.recoveryAmountUnits, policy.recoveryPercentageBps,
        policy.cooldownSeconds, policy.enabled ? 1 : 0, JSON.stringify(policy.preferences || {}), actorId || null, now, now]);
    }
    return getPolicyForUpdate(tx, { orgId, scopeType: policy.scopeType, scopeOwnerId: policy.scopeOwnerId, eventKey: policy.eventKey });
  }

  async function getAlertStateForUpdate(tx, { orgId, scopeType, scopeOwnerId, eventKey, thresholdKey }) {
    assertOrg(tx, orgId);
    const row = rowsOf(await tx.query(`SELECT id,org_id,policy_id,scope_type,scope_owner_id,event_key,threshold_key,state,
        last_observed_units,last_observed_limit_units,crossing_sequence,crossed_at,recovered_at,next_eligible_at,version,updated_at
      FROM billing_alert_states WHERE org_id=? AND scope_type=? AND scope_owner_id=? AND event_key=? AND threshold_key=? FOR UPDATE`,
    [orgId, scopeType, scopeOwnerId, eventKey, thresholdKey]))[0];
    return row ? mapAlertState(row) : null;
  }

  async function saveAlertState(tx, { orgId, policyId, scopeType, scopeOwnerId, eventKey, thresholdKey, state,
    observedUnits, limitUnits, crossingSequence, crossedAt, recoveredAt, nextEligibleAt, expectedVersion = 0, now }) {
    assertOrg(tx, orgId);
    const prior = await getAlertStateForUpdate(tx, { orgId, scopeType, scopeOwnerId, eventKey, thresholdKey });
    if ((prior?.version || 0) !== Number(expectedVersion)) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Notification alert state changed concurrently.');
    const id = prior?.id || idSource.newId('billing-alert-state');
    if (prior) {
      const result = await tx.query(`UPDATE billing_alert_states SET policy_id=?,state=?,last_observed_units=?,last_observed_limit_units=?,
          crossing_sequence=?,crossed_at=?,recovered_at=?,next_eligible_at=?,updated_at=?,version=version+1
        WHERE org_id=? AND id=? AND version=?`, [policyId || null, state, observedUnits, limitUnits, crossingSequence,
        crossedAt, recoveredAt, nextEligibleAt, now, orgId, id, prior.version]);
      if (affected(result) !== 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.VERSION_CONFLICT, 'Notification alert state changed concurrently.');
    } else {
      await tx.query(`INSERT INTO billing_alert_states (id,org_id,policy_id,scope_type,scope_owner_id,event_key,threshold_key,state,
          last_observed_units,last_observed_limit_units,crossing_sequence,crossed_at,recovered_at,next_eligible_at,version,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`, [id, orgId, policyId || null, scopeType, scopeOwnerId, eventKey, thresholdKey,
        state, observedUnits, limitUnits, crossingSequence, crossedAt, recoveredAt, nextEligibleAt, now]);
    }
    return getAlertStateForUpdate(tx, { orgId, scopeType, scopeOwnerId, eventKey, thresholdKey });
  }

  async function createNotification(tx, { orgId, notification, recipients, templateKey = 'billing.notification.v1', now }) {
    assertOrg(tx, orgId);
    const existing = rowsOf(await tx.query(`SELECT id,notification_key,event_key,scope_type,scope_owner_id,title,message,payload_json,action_path,occurred_at
      FROM billing_notifications WHERE org_id=? AND notification_key=? FOR UPDATE`, [orgId, notification.notificationKey]))[0];
    if (existing) return Object.freeze({ ...mapNotification(existing), duplicate: true });
    const id = idSource.newId('billing-notification');
    await tx.query(`INSERT INTO billing_notifications (id,org_id,notification_key,event_key,scope_type,scope_owner_id,title,message,payload_json,action_path,occurred_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, orgId, notification.notificationKey, notification.eventKey, notification.scopeType,
      notification.scopeOwnerId || null, notification.title, notification.message, JSON.stringify(notification.payload || {}),
      notification.actionPath || null, notification.occurredAt || now, now]);
    const targets = recipients || await resolveRecipients(tx, { orgId, scopeType: notification.scopeType, scopeOwnerId: notification.scopeOwnerId, eventKey: notification.eventKey });
    for (const target of targets) {
      const recipientId = idSource.newId('billing-notification-recipient');
      await tx.query(`INSERT INTO billing_notification_recipients (id,org_id,notification_id,recipient_type,recipient_key,user_id,contact_id,email_snapshot,verification_state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [recipientId, orgId, id, target.type, target.key, target.userId || null,
        target.contactId || null, target.email || null, target.verificationState, now]);
      if (target.email && target.verificationState !== 'pending_verification') {
        await enqueueNotificationDelivery(tx, { orgId, notificationId: id, recipientId, email: target.email,
          templateKey, notification, now });
      }
    }
    return Object.freeze({ id, ...notification, recipients: targets.length, duplicate: false });
  }

  async function enqueueNotificationDelivery(tx, { orgId, notificationId = null, recipientId = null, email, displayName = null,
    templateKey, payload = null, deliveryKey, now }) {
    assertOrg(tx, orgId);
    const stableKey = deliveryKey || idempotencyKey(`${notificationId || 'private'}:${recipientId || email}:${templateKey}`);
    const id = `email-${crypto.createHash('sha256').update(`${orgId}:${stableKey}`).digest('hex').slice(0, 40)}`;
    await tx.query(`INSERT INTO billing_notification_deliveries (id,org_id,notification_id,recipient_id,channel,template_key,
        recipient_email,recipient_name,payload_json,delivery_key,status,available_at,created_at,updated_at)
      VALUES (?,?,?,?,'email',?,?,?,?,?,'pending',?,?,?)
      ON DUPLICATE KEY UPDATE delivery_key=VALUES(delivery_key)`, [id, orgId, notificationId, recipientId,
      templateKey, email, displayName, payload == null ? null : JSON.stringify(payload), stableKey, now, now, now]);
    return stableKey;
  }

  async function resolveRecipients(tx, { orgId, scopeType, scopeOwnerId, eventKey }) {
    assertOrg(tx, orgId);
    await assertValidScope(tx, orgId, scopeType, scopeOwnerId);
    const recipients = new Map();
    const orgAdmins = rowsOf(await tx.query(`SELECT id,user_id,email FROM org_members WHERE org_id=? AND status='Active'
      AND role IN ('Owner','Organization Admin','Super Admin','Billing Admin') AND user_id IS NOT NULL`, [orgId]));
    for (const row of orgAdmins) recipients.set(`user:${row.user_id}`, { type: 'user', key: `user:${row.user_id}`, userId: row.user_id, email: row.email, verificationState: 'not_applicable' });
    if (scopeType === 'workspace') {
      const workspaceAdmins = rowsOf(await tx.query(`SELECT m.id,m.user_id,m.email FROM workspace_members wm
        JOIN org_members m ON m.org_id=wm.org_id AND m.id=wm.member_id
        WHERE wm.org_id=? AND wm.workspace_id=? AND wm.status='Active' AND wm.role='Workspace Admin'
          AND m.status='Active' AND m.user_id IS NOT NULL`, [orgId, scopeOwnerId]));
      for (const row of workspaceAdmins) recipients.set(`user:${row.user_id}`, { type: 'user', key: `user:${row.user_id}`, userId: row.user_id, email: row.email, verificationState: 'not_applicable' });
    }
    const contacts = rowsOf(await tx.query(`SELECT id,email,notification_preferences_json FROM billing_contacts
      WHERE org_id=? AND status='verified' AND verified_at IS NOT NULL`, [orgId]));
    for (const row of contacts) {
      const prefs = parseJson(row.notification_preferences_json, 'Billing contact preferences');
      const eventPrefs = prefs.events;
      if (eventPrefs && eventPrefs[eventKey] === false) continue;
      recipients.set(`contact:${row.id}`, { type: 'contact', key: `contact:${row.id}`, contactId: row.id, email: row.email, verificationState: 'verified' });
    }
    return [...recipients.values()];
  }

  async function listForUser(tx, { orgId, userId, limit = 50, before }) {
    assertOrg(tx, orgId); validateId(userId, 'userId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'limit must be between 1 and 100.');
    const params = [orgId, userId]; const cursor = before ? ' AND (n.occurred_at<? OR (n.occurred_at=? AND n.id<?))' : '';
    if (before) params.push(before.occurredAt, before.occurredAt, validateId(before.id, 'before.id'));
    params.push(limit);
    return rowsOf(await tx.query(`SELECT n.id,n.notification_key,n.event_key,n.scope_type,n.scope_owner_id,n.title,n.message,n.payload_json,
        n.action_path,n.occurred_at,r.read_at FROM billing_notification_recipients r
        JOIN billing_notifications n ON n.org_id=r.org_id AND n.id=r.notification_id
        WHERE r.org_id=? AND r.user_id=?${cursor} ORDER BY n.occurred_at DESC,n.id DESC LIMIT ?`, params)).map((row) => ({ ...mapNotification(row), readAt: row.read_at || null }));
  }

  async function markRead(tx, { orgId, userId, notificationId, now }) {
    assertOrg(tx, orgId); validateId(userId, 'userId'); validateId(notificationId, 'notificationId');
    const result = await tx.query(`UPDATE billing_notification_recipients SET read_at=COALESCE(read_at,?)
      WHERE org_id=? AND notification_id=? AND user_id=?`, [now, orgId, notificationId, userId]);
    if (affected(result) < 1) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Notification was not found for this user.');
    return true;
  }

  async function markAllRead(tx, { orgId, userId, now, scopeType, scopeOwnerId }) {
    assertOrg(tx, orgId); validateId(userId, 'userId');
    const params = [now, orgId, userId];
    let scopeSql = '';
    if (scopeType && scopeOwnerId) { scopeSql = ' AND n.scope_type=? AND n.scope_owner_id=?'; params.push(scopeType, scopeOwnerId); }
    const result = await tx.query(`UPDATE billing_notification_recipients r JOIN billing_notifications n
      ON n.org_id=r.org_id AND n.id=r.notification_id SET r.read_at=COALESCE(r.read_at,?)
      WHERE r.org_id=? AND r.user_id=? AND r.read_at IS NULL${scopeSql}`, params);
    return affected(result);
  }

  async function assertValidScope(tx, orgId, scopeType, scopeOwnerId) {
    if (scopeType === 'organization') {
      if (scopeOwnerId !== orgId) throw new BillingDomainError(DOMAIN_ERROR_CODES.FORBIDDEN, 'Organization notification scope must use the organization ID.');
      return;
    }
    if (scopeType !== 'workspace') throw new BillingDomainError(DOMAIN_ERROR_CODES.INVALID_CONTRACT, 'Notification scope must be organization or workspace.');
    const workspace = rowsOf(await tx.query('SELECT id FROM workspaces WHERE org_id=? AND id=? AND status IN (\'Active\',\'active\') FOR UPDATE', [orgId, validateId(scopeOwnerId, 'scopeOwnerId')]))[0];
    if (!workspace) throw new BillingDomainError(DOMAIN_ERROR_CODES.NOT_FOUND, 'Notification workspace scope was not found in this organization.');
  }

  return Object.freeze({ getContactForUpdate, createContact, findContactByVerificationHash, markContactVerified,
    disableContact, listContacts, getPolicyForUpdate, listPoliciesForUpdate, savePolicy, getAlertStateForUpdate,
    saveAlertState, createNotification, enqueueNotificationDelivery, resolveRecipients, listForUser, markRead, markAllRead });
}

function mapContact(row) {
  return Object.freeze({ id: row.id, orgId: row.org_id, userId: row.user_id || null, email: row.email, displayName: row.display_name || null,
    status: row.status, verificationExpiresAt: row.verification_expires_at || null,
    verifiedAt: row.verified_at || null, disabledAt: row.disabled_at || null,
    preferences: parseJson(row.notification_preferences_json, 'Billing contact preferences'), createdBy: row.created_by || null,
    createdAt: row.created_at, updatedAt: row.updated_at });
}
function mapPolicy(row) {
  const preferences = parseJson(row.policy_json, 'Notification policy');
  return Object.freeze({ id: row.id, orgId: row.org_id, scopeType: row.scope_type, scopeOwnerId: row.scope_owner_id,
    eventKey: row.event_key, amountThresholdUnits: row.amount_threshold_units == null ? null : String(row.amount_threshold_units),
    percentageThresholdBps: row.percentage_threshold_bps == null ? null : Number(row.percentage_threshold_bps),
    recoveryAmountUnits: row.recovery_amount_units == null ? null : String(row.recovery_amount_units),
    recoveryPercentageBps: row.recovery_percentage_bps == null ? null : Number(row.recovery_percentage_bps),
    cooldownSeconds: Number(row.cooldown_seconds), enabled: Number(row.enabled) === 1, preferences, version: Number(row.version), updatedBy: row.updated_by || null });
}
function mapAlertState(row) {
  return Object.freeze({ id: row.id, orgId: row.org_id, policyId: row.policy_id || null, scopeType: row.scope_type,
    scopeOwnerId: row.scope_owner_id, eventKey: row.event_key, thresholdKey: row.threshold_key, state: row.state,
    lastObservedUnits: row.last_observed_units == null ? null : String(row.last_observed_units),
    lastObservedLimitUnits: row.last_observed_limit_units == null ? null : String(row.last_observed_limit_units),
    crossingSequence: Number(row.crossing_sequence), crossedAt: row.crossed_at || null, recoveredAt: row.recovered_at || null,
    nextEligibleAt: row.next_eligible_at || null, version: Number(row.version), updatedAt: row.updated_at });
}
function mapNotification(row) {
  return Object.freeze({ id: row.id, notificationKey: row.notification_key, eventKey: row.event_key, scopeType: row.scope_type,
    scopeOwnerId: row.scope_owner_id || null, title: row.title, message: row.message, payload: parseJson(row.payload_json, 'Notification payload'),
    actionPath: row.action_path || null, occurredAt: row.occurred_at });
}

module.exports = { createMysqlNotificationRepository, mapContact, mapPolicy, mapAlertState, mapNotification, normalizeEmail, idempotencyKey };
