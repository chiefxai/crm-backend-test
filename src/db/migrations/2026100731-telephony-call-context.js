'use strict';

module.exports = {
  id: '2026100731_telephony_call_context',
  steps: [
    { sql: 'ALTER TABLE telephony_call_routes ADD COLUMN call_context_json JSON NULL', ignore: ['ER_DUP_FIELDNAME'] },
  ],
};
