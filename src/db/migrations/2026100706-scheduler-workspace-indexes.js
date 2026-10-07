// Support cross-workspace callback and auto-dial scheduler scans without
// repeatedly walking unrelated operational rows.
module.exports = {
  id: '2026100706_scheduler_workspace_indexes',
  steps: [
    { sql: 'CREATE INDEX idx_call_logs_retry_due_id ON call_logs (retry_status,next_retry_at,id,status)', ignore: ['ER_DUP_KEYNAME'] },
    { sql: 'CREATE INDEX idx_dialer_tasks_auto_enabled ON dialer_tasks (auto_dial_enabled,next_dial_at,id)', ignore: ['ER_DUP_KEYNAME'] },
  ],
};
