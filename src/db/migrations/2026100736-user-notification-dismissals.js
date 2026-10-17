'use strict';
// Keep notification clearing private to each user; never delete shared events.
module.exports = {
  id: '2026100736_user_notification_dismissals',
  steps: [
    { sql: `CREATE TABLE IF NOT EXISTS app_notification_dismissals (
      notification_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      dismissed_at DATETIME(6) NOT NULL,
      PRIMARY KEY (notification_id,user_id),
      KEY idx_app_notification_dismissals_user (user_id,dismissed_at),
      CONSTRAINT fk_app_notification_dismissals_event FOREIGN KEY (notification_id) REFERENCES app_notifications(id) ON DELETE CASCADE
    )` },
  ],
};
