module.exports = {
  id: '2026100725_meta_message_deduplication',
  steps: [
    // Meta provider message IDs fit comfortably in VARCHAR(191). The org is
    // the tenant scope; this key also closes duplicate-first-conversation races.
    { sql: `ALTER TABLE messages ADD COLUMN external_message_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL`, ignore: ['ER_DUP_FIELDNAME'] },
    { sql: `ALTER TABLE messages MODIFY COLUMN external_message_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL` },
    { sql: `UPDATE messages SET external_message_id=NULL WHERE external_message_id=''` },
    // Keep every historical message row, while preserving one canonical
    // provider ID so the unique key can be installed without deleting data.
    { sql: `UPDATE messages duplicate_row
      INNER JOIN messages canonical_row
        ON canonical_row.org_id=duplicate_row.org_id
       AND BINARY canonical_row.external_message_id=BINARY duplicate_row.external_message_id
       AND (COALESCE(canonical_row.created_at,'') < COALESCE(duplicate_row.created_at,'')
         OR (COALESCE(canonical_row.created_at,'')=COALESCE(duplicate_row.created_at,'') AND canonical_row.id < duplicate_row.id))
      SET duplicate_row.external_message_id=NULL
      WHERE duplicate_row.external_message_id IS NOT NULL` },
    { sql: `CREATE UNIQUE INDEX uq_messages_provider_external_id ON messages (org_id,external_message_id)`, ignore: ['ER_DUP_KEYNAME'] },
  ],
};
