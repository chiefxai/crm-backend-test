'use strict';

const crypto = require('node:crypto');
const { encryptPayload } = require('./payloadCodec');

function rowsOf(value) { return Array.isArray(value) && Array.isArray(value[0]) ? value[0] : Array.isArray(value) ? value : value?.rows || []; }
function affected(value) { const result = Array.isArray(value) && value.length === 2 ? value[0] : value; return Number(result?.affectedRows ?? result?.rowCount ?? 0); }
function json(value) { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { throw new Error('Email delivery payload is invalid JSON.'); } }
function stableKey(value) { return `email:${crypto.createHash('sha256').update(value).digest('hex')}`; }

function createMysqlEmailDeliveryRepository({ pool, clock, leaseSeconds = 120, maxAttempts = 8 } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Email delivery repository requires a MySQL pool.');
  if (typeof clock?.now !== 'function') throw new TypeError('Email delivery repository requires a clock.');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || !Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('Email delivery lease and attempt limits are invalid.');

  async function enqueuePrivate(tx, { orgId, email, displayName, templateKey, payload, deliveryKey, now }) {
    const key = deliveryKey || stableKey(`${orgId}:${email}:${templateKey}:${JSON.stringify(payload)}`);
    const id = `email-${crypto.createHash('sha256').update(`${orgId}:${key}`).digest('hex').slice(0, 40)}`;
    const encrypted = encryptPayload(payload);
    await tx.query(`INSERT INTO billing_notification_deliveries (id,org_id,channel,template_key,recipient_email,recipient_name,payload_json,
        delivery_key,status,available_at,created_at,updated_at)
      VALUES (?,?,'email',?,?,?,?,?,'pending',?,?,?) ON DUPLICATE KEY UPDATE delivery_key=VALUES(delivery_key)`,
    [id, orgId, templateKey, email, displayName || null, encrypted, key, now || clock.now(), now || clock.now(), now || clock.now()]);
    return key;
  }

  async function claim({ workerId, now = clock.now() } = {}) {
    const connection = await pool.connect(); let started = false;
    try {
      await connection.query('START TRANSACTION'); started = true;
      const row = rowsOf(await connection.query(`SELECT d.id,d.org_id,d.notification_id,d.recipient_id,d.template_key,d.recipient_email,d.recipient_name,d.payload_json,
          d.delivery_key,d.attempts,d.fencing_token,n.title,n.message,n.payload_json AS notification_payload,n.action_path,r.email_snapshot
        FROM billing_notification_deliveries d
        LEFT JOIN billing_notifications n ON n.org_id=d.org_id AND n.id=d.notification_id
        LEFT JOIN billing_notification_recipients r ON r.org_id=d.org_id AND r.id=d.recipient_id
        WHERE d.channel='email' AND ((d.status='pending' AND d.available_at<=?) OR (d.status='leased' AND d.lease_expires_at<=?))
        ORDER BY d.available_at,d.id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now, now]))[0];
      if (!row) { await connection.query('COMMIT'); started = false; return null; }
      const token = crypto.randomUUID(); const fencing = Number(row.fencing_token) + 1; const expiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
      const changed = await connection.query(`UPDATE billing_notification_deliveries SET status='leased',attempts=attempts+1,lease_owner=?,lease_token=?,
          fencing_token=?,lease_expires_at=?,updated_at=? WHERE id=? AND org_id=?`, [workerId, token, fencing, expiresAt, now, row.id, row.org_id]);
      if (affected(changed) !== 1) throw new Error('Could not acquire email delivery lease.');
      await connection.query('COMMIT'); started = false;
      const privatePayload = row.payload_json ? json(row.payload_json) : null;
      return Object.freeze({ id: row.id, orgId: row.org_id, notificationId: row.notification_id, recipientId: row.recipient_id,
        email: row.recipient_email || row.email_snapshot, displayName: row.recipient_name || null, templateKey: row.template_key || 'billing.notification.v1',
        payload: privatePayload,
        notification: row.notification_id ? { title: row.title, message: row.message, payload: json(row.notification_payload), actionPath: row.action_path } : null,
        attempts: Number(row.attempts) + 1, fencingToken: fencing, leaseToken: token, leaseOwner: workerId });
    } catch (error) {
      if (started) { try { await connection.query('ROLLBACK'); } catch {} }
      throw error;
    } finally { connection.release(); }
  }

  async function settle(delivery, result) {
    const connection = await pool.connect(); let started = false; const now = clock.now();
    try {
      await connection.query('START TRANSACTION'); started = true;
      const current = rowsOf(await connection.query(`SELECT attempts FROM billing_notification_deliveries WHERE id=? AND org_id=? AND status='leased'
        AND lease_owner=? AND lease_token=? AND fencing_token=? FOR UPDATE`, [delivery.id, delivery.orgId, delivery.leaseOwner, delivery.leaseToken, delivery.fencingToken]))[0];
      if (!current) { await connection.query('ROLLBACK'); started = false; return { status: 'lease_lost' }; }
      let status; let availableAt = now; let errorCode = result.errorCode || null; let submittedAt = null; let providerId = null;
      if (result.status === 'submitted') { status = 'submitted'; providerId = result.providerMessageId || null; submittedAt = now; errorCode = null; }
      else if (result.status === 'skipped_unconfigured') { status = 'skipped'; errorCode = 'SMTP_UNCONFIGURED'; }
      else if (result.retryable && Number(current.attempts) < maxAttempts) {
        status = 'pending'; const seconds = Math.min(3600, 15 * (2 ** Math.min(Number(current.attempts) - 1, 8)));
        availableAt = new Date(Date.parse(now) + seconds * 1000).toISOString();
      } else status = 'dead_letter';
      await connection.query(`UPDATE billing_notification_deliveries SET status=?,available_at=?,provider_message_id=?,submitted_at=?,last_error_code=?,
          last_error_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND org_id=? AND fencing_token=?`,
      [status, availableAt, providerId, submittedAt, errorCode, errorCode ? now : null, now, delivery.id, delivery.orgId, delivery.fencingToken]);
      await connection.query('COMMIT'); started = false; return { status };
    } catch (error) { if (started) { try { await connection.query('ROLLBACK'); } catch {} } throw error; }
    finally { connection.release(); }
  }

  return Object.freeze({ enqueuePrivate, claim, settle });
}

module.exports = { createMysqlEmailDeliveryRepository, stableKey };
