module.exports = {
  id: '2026100724_khata_payment_idempotency',
  steps: [{ sql: `CREATE TABLE IF NOT EXISTS khata_payments (
    id VARCHAR(191) NOT NULL PRIMARY KEY,
    org_id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    customer_id VARCHAR(191) NOT NULL,
    idempotency_key VARCHAR(191) NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    balance_after DECIMAL(14,2) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    UNIQUE KEY uq_khata_payment_idempotency (org_id,workspace_id,idempotency_key),
    KEY idx_khata_payment_customer (org_id,workspace_id,customer_id,created_at),
    CONSTRAINT fk_khata_payment_workspace FOREIGN KEY (org_id,workspace_id) REFERENCES workspaces(org_id,id) ON DELETE CASCADE
  )` }],
};
