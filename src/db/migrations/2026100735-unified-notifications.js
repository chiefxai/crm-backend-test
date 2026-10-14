'use strict';
// Separate product notifications from transport logs and the specialized billing outbox.
module.exports = {
  id: '2026100735_unified_notifications',
  steps: [
    { sql: `CREATE TABLE IF NOT EXISTS app_notifications (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      dedupe_key VARCHAR(191) NOT NULL,
      audience VARCHAR(20) NOT NULL,
      org_id VARCHAR(191) NULL,
      workspace_id VARCHAR(191) NULL,
      event_key VARCHAR(100) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      action_path VARCHAR(512) NULL,
      occurred_at DATETIME(6) NOT NULL,
      created_at DATETIME(6) NOT NULL,
      UNIQUE KEY uq_app_notification_dedupe (dedupe_key),
      KEY idx_app_notifications_platform (audience,occurred_at,id),
      KEY idx_app_notifications_org (org_id,audience,occurred_at,id),
      KEY idx_app_notifications_workspace (workspace_id,occurred_at,id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS app_notification_reads (
      notification_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      read_at DATETIME(6) NOT NULL,
      PRIMARY KEY (notification_id,user_id),
      CONSTRAINT fk_app_notification_reads_event FOREIGN KEY (notification_id) REFERENCES app_notifications(id) ON DELETE CASCADE
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS app_notification_preferences (
      user_id VARCHAR(191) NOT NULL,
      audience VARCHAR(20) NOT NULL,
      event_key VARCHAR(100) NOT NULL,
      channel VARCHAR(20) NOT NULL,
      enabled TINYINT(1) NOT NULL,
      updated_at DATETIME(6) NOT NULL,
      PRIMARY KEY (user_id,audience,event_key,channel)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS app_notification_email_deliveries (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      notification_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      recipient_email VARCHAR(320) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at DATETIME(6) NOT NULL,
      updated_at DATETIME(6) NOT NULL,
      UNIQUE KEY uq_app_notification_email_recipient (notification_id,user_id),
      KEY idx_app_notification_email_due (status,next_attempt_at),
      CONSTRAINT fk_app_notification_email_event FOREIGN KEY (notification_id) REFERENCES app_notifications(id) ON DELETE CASCADE
    )` }
  ],
};