'use strict';

// Extend durable notification deliveries to also represent private template
// messages (for example a contact verification link) without storing secrets
// in the in-app notification feed.
module.exports = {
  id: '2026100720_billing_email_delivery',
  steps: [
    { sql: `ALTER TABLE billing_notification_deliveries
      MODIFY notification_id VARCHAR(191) NULL,
      MODIFY recipient_id VARCHAR(191) NULL,
      ADD COLUMN template_key VARCHAR(96) NULL AFTER channel,
      ADD COLUMN recipient_email VARCHAR(320) NULL AFTER template_key,
      ADD COLUMN payload_json JSON NULL AFTER recipient_email,
      ADD COLUMN recipient_name VARCHAR(255) NULL AFTER payload_json,
      ADD COLUMN submitted_at DATETIME(6) NULL AFTER provider_message_id,
      ADD KEY idx_billing_delivery_email_claim (channel,status,available_at,id)` },
  ],
};
