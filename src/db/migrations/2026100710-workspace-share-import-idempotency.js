module.exports = {
  id: '2026100710_workspace_share_import_idempotency',
  steps: [
    // Preserve existing imports as globally idempotent for their source record.
    // New imports use their mapping hash, allowing deliberate remapping later.
    { sql: 'ALTER TABLE workspace_share_imports ADD COLUMN mapping_fingerprint CHAR(64) NULL', ignore: ['ER_DUP_FIELDNAME'] },
    { sql: "UPDATE workspace_share_imports SET mapping_fingerprint=REPEAT('0',64) WHERE mapping_fingerprint IS NULL" },
    { sql: 'ALTER TABLE workspace_share_imports MODIFY mapping_fingerprint CHAR(64) NOT NULL' },
    // The old unique index begins with grant_id and is also the FK's supporting
    // index, so release that FK before replacing the index.
    { sql: 'ALTER TABLE workspace_share_imports DROP FOREIGN KEY fk_workspace_share_import_grant', ignore: ['ER_CANT_DROP_FIELD_OR_KEY'] },
    { sql: 'ALTER TABLE workspace_share_imports DROP INDEX uq_workspace_share_import_source', ignore: ['ER_CANT_DROP_FIELD_OR_KEY'] },
    { sql: 'CREATE UNIQUE INDEX uq_workspace_share_import_source ON workspace_share_imports (grant_id,source_fingerprint,mapping_fingerprint)', ignore: ['ER_DUP_KEYNAME'] },
    { sql: 'ALTER TABLE workspace_share_imports DROP FOREIGN KEY fk_workspace_share_import_record', ignore: ['ER_CANT_DROP_FIELD_OR_KEY'] },
    { sql: 'ALTER TABLE workspace_share_imports ADD CONSTRAINT fk_workspace_share_import_grant FOREIGN KEY (grant_id) REFERENCES workspace_share_grants(id) ON DELETE RESTRICT', ignore: ['ER_FK_DUP_NAME'] },
  ],
};
