'use strict';

module.exports = {
  id: '2026100730_telephony_call_route_fallback_idempotency',
  steps: [
    { sql: 'ALTER TABLE telephony_call_routes ADD COLUMN fallback_call_log_id VARCHAR(191) NULL', ignore: ['ER_DUP_FIELDNAME'] },
  ],
};
