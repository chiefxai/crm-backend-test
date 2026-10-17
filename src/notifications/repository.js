'use strict';
const crypto = require('node:crypto');
const { getPool } = require('../db/pool');
const { eventFor, catalogFor, CHANNELS } = require('./catalog');

// All queries are scoped by an authenticated audience. Never accept audience,
// organization, or user identifiers from an untrusted API request body.
function createRepository(pool = getPool()) {
  async function rememberUser({ userId, email, audience }) {
    if (!email) return;
    await pool.query('INSERT INTO app_notification_users (user_id,audience,email,last_seen_at) VALUES (?,?,?,UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE email=VALUES(email),last_seen_at=VALUES(last_seen_at)',
      [userId, audience, email.toLowerCase()]);
  }
  async function create(input) {
    const spec = eventFor(input.eventKey, input.audience);
    if (!spec) throw new TypeError('Unknown notification event or audience.');
    if (input.audience === 'organization' && !input.orgId) throw new TypeError('Organization notification requires orgId.');
    if (!input.dedupeKey || !input.title || !input.message) throw new TypeError('Notification key, title and message are required.');
    if (input.title.length > 255 || input.message.length > 4000) throw new TypeError('Notification text exceeds supported length.');
    if (input.actionPath && (!/^\/(?!\/)/.test(input.actionPath) || input.actionPath.length > 512)) throw new TypeError('Action must be an internal path.');
    const id = crypto.randomUUID();
    const dedupeKey = crypto.createHash('sha256').update([input.audience,input.orgId || '',input.eventKey,input.dedupeKey].join('|')).digest('hex');
    const result = await pool.query(
      'INSERT IGNORE INTO app_notifications (id,dedupe_key,audience,org_id,workspace_id,event_key,title,message,action_path,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))',
      [id,dedupeKey,input.audience,input.orgId || null,input.workspaceId || null,input.eventKey,input.title,input.message,input.actionPath || null]);
    return result.affectedRows ? { id, created: true } : { created: false };
  }
  function filter({ audience, orgId, workspaceId }) {
    if (audience === 'platform') return { sql: "n.audience='platform'", args: [] };
    if (!orgId || !workspaceId) throw new TypeError('Active organization and workspace required.');
    return { sql: "(n.audience='organization' AND n.org_id=? AND (n.workspace_id IS NULL OR n.workspace_id=?))",
      args: [orgId,workspaceId] };
  }
  async function list({ audience, orgId, workspaceId, userId, limit = 50 }) {
    const selected = filter({ audience, orgId, workspaceId });
    const { rows } = await pool.query(
      'SELECT n.id,n.event_key,n.title,n.message,n.action_path,n.occurred_at,n.org_id,n.workspace_id,r.read_at FROM app_notifications n ' +
      'LEFT JOIN app_notification_reads r ON r.notification_id=n.id AND r.user_id=? ' +
      'LEFT JOIN app_notification_dismissals d ON d.notification_id=n.id AND d.user_id=? ' +
      "LEFT JOIN app_notification_preferences p ON p.user_id=? AND p.audience=? AND p.event_key=n.event_key AND p.channel='browser' " +
      'WHERE ' + selected.sql + ' AND d.notification_id IS NULL AND (p.enabled IS NULL OR p.enabled=1) ORDER BY n.occurred_at DESC,n.id DESC LIMIT ?',
      [userId,userId,userId,audience,...selected.args,Math.min(100,Math.max(1,Number(limit)||50))]);
    return rows.map(row => ({
      id: row.id, eventKey: row.event_key, title: row.title, message: row.message,
      actionPath: row.action_path, occurredAt: row.occurred_at, readAt: row.read_at || null,
      scopeType: row.workspace_id ? 'workspace' : row.org_id ? 'organization' : 'platform',
      scopeOwnerId: row.workspace_id || row.org_id || null,
    }));
  }
  async function markRead({ audience, orgId, workspaceId, userId, id = null }) {
    const selected = filter({ audience, orgId, workspaceId });
    const identity = id ? ' AND n.id=?' : '';
    const { affectedRows } = await pool.query(
      'INSERT IGNORE INTO app_notification_reads (notification_id,user_id,read_at) SELECT n.id,?,UTC_TIMESTAMP(6) FROM app_notifications n WHERE ' + selected.sql + identity,
      [userId,...selected.args,...(id ? [id] : [])]);
    return { updated: affectedRows };
  }
  async function clear({ audience, orgId, workspaceId, userId }) {
    const selected = filter({ audience, orgId, workspaceId });
    const { affectedRows } = await pool.query(
      'INSERT IGNORE INTO app_notification_dismissals (notification_id,user_id,dismissed_at) ' +
      'SELECT n.id,?,UTC_TIMESTAMP(6) FROM app_notifications n WHERE ' + selected.sql,
      [userId,...selected.args]);
    return { cleared: affectedRows };
  }
  async function preferences({ audience, userId }) {
    const rows = (await pool.query('SELECT event_key,channel,enabled FROM app_notification_preferences WHERE user_id=? AND audience=?', [userId,audience])).rows;
    const result = catalogFor(audience);
    for (const event of result) {
      for (const channel of CHANNELS) {
        const saved = rows.find(row => row.event_key === event.key && row.channel === channel);
        if (saved) event.defaults[channel] = Boolean(saved.enabled);
      }
    }
    return result;
  }
  async function setPreferences({ audience, userId, changes }) {
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) throw new TypeError('Expected 1–100 notification preference changes.');
    const distinct = new Set();
    for (const item of changes) {
      if (!eventFor(item.eventKey,audience) || !CHANNELS.includes(item.channel) || typeof item.enabled !== 'boolean') throw new TypeError('Invalid notification preference.');
      const key = item.eventKey + ':' + item.channel;
      if (distinct.has(key)) throw new TypeError('Duplicate notification preference.');
      distinct.add(key);
    }
    for (const item of changes) {
      await pool.query('INSERT INTO app_notification_preferences (user_id,audience,event_key,channel,enabled,updated_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),updated_at=VALUES(updated_at)',
        [userId,audience,item.eventKey,item.channel,item.enabled ? 1 : 0]);
      // Opting out must also cancel any previously queued (but unsent) mail.
      if (item.channel === 'email' && !item.enabled) {
        await pool.query("UPDATE app_notification_email_deliveries d JOIN app_notifications n ON n.id=d.notification_id SET d.status='cancelled',d.updated_at=UTC_TIMESTAMP(6) WHERE d.user_id=? AND n.event_key=? AND n.audience=? AND d.status='pending'", [userId,item.eventKey,audience]);
      }
    }
    return preferences({ audience,userId });
  }
  async function enqueueEmailRecipients({ id, audience, orgId, workspaceId, eventKey }) {
    // Email is strictly opt-in. Verified platform identities register when
    // opening their admin panel; organization members come from membership.
    if (audience === 'platform') {
      await pool.query(
        'INSERT IGNORE INTO app_notification_email_deliveries (id,notification_id,user_id,recipient_email,status,next_attempt_at,updated_at) ' +
        "SELECT UUID(),?,u.user_id,u.email,'pending',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) FROM app_notification_users u " +
        "JOIN app_notification_preferences p ON p.user_id=u.user_id AND p.audience='platform' AND p.event_key=? AND p.channel='email' AND p.enabled=1 WHERE u.audience='platform'",
        [id,eventKey]);
    } else {
      let extra = '';
      const args = [id,eventKey,orgId];
      if (workspaceId) {
        extra = ' AND EXISTS (SELECT 1 FROM workspace_members w WHERE w.org_id=m.org_id AND w.member_id=m.id AND w.workspace_id=?)';
        args.push(workspaceId);
      }
      await pool.query(
        'INSERT IGNORE INTO app_notification_email_deliveries (id,notification_id,user_id,recipient_email,status,next_attempt_at,updated_at) ' +
        "SELECT UUID(),?,m.user_id,m.email,'pending',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6) FROM org_members m " +
        "JOIN app_notification_preferences p ON p.user_id=m.user_id AND p.audience='organization' AND p.event_key=? AND p.channel='email' AND p.enabled=1 " +
        "WHERE m.org_id=? AND m.user_id IS NOT NULL AND m.email IS NOT NULL AND COALESCE(m.status,'Active')='Active'" + extra,
        args);
    }
  }
  return { rememberUser, create, list, markRead, clear, preferences, setPreferences, enqueueEmailRecipients };
}
module.exports = { createRepository };
