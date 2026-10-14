'use strict';
const { getPool } = require('../../db/pool');
const mailer = require('../../email/mailer');
const { getLogger } = require('../../observability/logger');
const log = getLogger('notifications.smtp');
let working = false;

async function flush({ pool = getPool(), limit = 20 } = {}) {
  if (working) return { processed: 0, busy: true };
  working = true;
  let processed = 0;
  try {
    const { rows } = await pool.query(
      "SELECT d.id,d.recipient_email,d.attempts,n.title,n.message,n.action_path FROM app_notification_email_deliveries d " +
      "JOIN app_notifications n ON n.id=d.notification_id JOIN app_notification_preferences p " +
      "ON p.user_id=d.user_id AND p.audience=n.audience AND p.event_key=n.event_key AND p.channel='email' AND p.enabled=1 " +
      "WHERE ((d.status='pending' AND d.next_attempt_at<=UTC_TIMESTAMP(6)) " +
      "OR (d.status='sending' AND d.updated_at<DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 5 MINUTE))) " +
      "ORDER BY d.next_attempt_at ASC LIMIT ?", [Math.max(1,Math.min(100,limit))]);
    for (const row of rows) {
      const claim = await pool.query(
        "UPDATE app_notification_email_deliveries SET status='sending',updated_at=UTC_TIMESTAMP(6) WHERE id=? " +
        "AND ((status='pending' AND next_attempt_at<=UTC_TIMESTAMP(6)) OR (status='sending' AND updated_at<DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 5 MINUTE)))", [row.id]);
      if (!claim.affectedRows) continue;
      const base = String(process.env.APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/,'');
      const destination = row.action_path && base ? '\n\nOpen: ' + base + row.action_path : '';
      let result;
      try { result = await mailer.sendMailResult({ to: row.recipient_email, subject: row.title, text: row.message + destination }); }
      catch (error) { result = { status: 'failed',errorCode: String(error?.code || 'SMTP_ERROR'),retryable: true }; }
      if (result.status === 'submitted') {
        await pool.query("UPDATE app_notification_email_deliveries SET status='sent',attempts=attempts+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?", [row.id]);
      } else {
        const attempts = Number(row.attempts)+1;
        const retry = result.status === 'skipped_unconfigured' || (result.retryable && attempts < 5);
        const seconds = result.status === 'skipped_unconfigured' ? 1800 : Math.min(3600,30*2**attempts);
        await pool.query("UPDATE app_notification_email_deliveries SET status=?,attempts=?,next_attempt_at=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL ? SECOND),updated_at=UTC_TIMESTAMP(6) WHERE id=?",
          [retry?'pending':'failed',attempts,seconds,row.id]);
        if (result.status !== 'skipped_unconfigured') log.warn('Notification SMTP delivery deferred or failed',{code:result.errorCode});
      }
      processed++;
    }
    return { processed };
  } finally { working=false; }
}
function startWorker() {
  const timer = setInterval(() => flush().catch(error=>log.error('Notification SMTP worker error',error)),60000);
  timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = { flush, startWorker };