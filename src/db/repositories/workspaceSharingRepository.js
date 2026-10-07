const crypto = require('crypto');
const { pool } = require('../pool');
const db = require('../client');

function parseJson(value, fallback) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return fallback; } }
  return value == null ? fallback : value;
}

async function list(orgId, workspaceId) {
  await db.ready;
  const { rows } = await pool.query(`SELECT g.*,sw.name AS source_name,tw.name AS target_name,o.key AS object_key,o.label AS object_label
    FROM workspace_share_grants g
    INNER JOIN workspaces sw ON sw.org_id=g.org_id AND sw.id=g.source_workspace_id
    INNER JOIN workspaces tw ON tw.org_id=g.org_id AND tw.id=g.target_workspace_id
    INNER JOIN objects o ON o.org_id=g.org_id AND o.id=g.object_id AND o.workspace_id=g.source_workspace_id
    WHERE g.org_id=? AND (g.source_workspace_id=? OR g.target_workspace_id=?)
    ORDER BY g.created_at DESC,g.id DESC`, [orgId,workspaceId,workspaceId]);
  return rows.map(row => ({ id:row.id,sourceWorkspaceId:row.source_workspace_id,sourceWorkspaceName:row.source_name,
    targetWorkspaceId:row.target_workspace_id,targetWorkspaceName:row.target_name,objectKey:row.object_key,
    objectLabel:row.object_label,allowedFields:parseJson(row.allowed_fields,[]),grantedByMemberId:row.granted_by_member_id,
    expiresAt:row.expires_at,revokedAt:row.revoked_at,createdAt:row.created_at,
    direction:row.source_workspace_id===workspaceId?'outgoing':'incoming' }));
}

async function create(orgId, sourceWorkspaceId, targetWorkspaceId, objectKey, allowedFields, memberId, expiresAt) {
  await db.ready;
  if (sourceWorkspaceId === targetWorkspaceId) throw Object.assign(new Error('Choose a different target workspace'),{statusCode:400});
  const { rows:targets } = await pool.query("SELECT id FROM workspaces WHERE org_id=? AND id=? AND status='Active'",[orgId,targetWorkspaceId]);
  if (!targets[0]) throw Object.assign(new Error('Target workspace was not found in this organization'),{statusCode:404});
  const { rows:objects } = await pool.query("SELECT id,key FROM objects WHERE org_id=? AND workspace_id=? AND `key`=? LIMIT 1",[orgId,sourceWorkspaceId,objectKey]);
  if (!objects[0]) throw Object.assign(new Error('Object was not found in this workspace'),{statusCode:404});
  const { rows:fields } = await pool.query('SELECT `key` FROM object_fields WHERE org_id=? AND workspace_id=? AND object_id=?',[orgId,sourceWorkspaceId,objects[0].id]);
  const known = new Set(fields.map(row=>row.key));
  const normalized = [...new Set(allowedFields)];
  if (!normalized.length || normalized.some(key=>!known.has(key))) throw Object.assign(new Error('Select one or more valid fields from this object'),{statusCode:400});
  const id=crypto.randomUUID(), now=new Date().toISOString();
  await pool.query(`INSERT INTO workspace_share_grants
    (id,org_id,source_workspace_id,target_workspace_id,object_id,allowed_fields,granted_by_member_id,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`,[id,orgId,sourceWorkspaceId,targetWorkspaceId,objects[0].id,JSON.stringify(normalized),memberId,expiresAt,now]);
  return id;
}

async function revoke(orgId, sourceWorkspaceId, grantId) {
  await db.ready;
  const now=new Date().toISOString();
  const { rows } = await pool.query(`SELECT id FROM workspace_share_grants
    WHERE id=? AND org_id=? AND source_workspace_id=? AND revoked_at IS NULL`,[grantId,orgId,sourceWorkspaceId]);
  if (!rows[0]) return false;
  await pool.query('UPDATE workspace_share_grants SET revoked_at=? WHERE id=? AND org_id=? AND source_workspace_id=? AND revoked_at IS NULL',
    [now,grantId,orgId,sourceWorkspaceId]);
  return true;
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    if (typeof value.createdAt!=='string' || typeof value.id!=='string') throw new Error('invalid');
    return value;
  } catch { throw Object.assign(new Error('Invalid page cursor'),{statusCode:400}); }
}

async function readActiveSharedRecords(orgId,targetWorkspaceId,grantId,cursor,pageSize=50) {
  await db.ready;
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const now=new Date().toISOString();
    const { rows:grants }=await client.query(`SELECT g.*,o.key AS object_key,o.label AS object_label
      FROM workspace_share_grants g
      INNER JOIN workspaces sw ON sw.org_id=g.org_id AND sw.id=g.source_workspace_id AND sw.status='Active'
      INNER JOIN workspaces tw ON tw.org_id=g.org_id AND tw.id=g.target_workspace_id AND tw.status='Active'
      INNER JOIN objects o ON o.org_id=g.org_id AND o.id=g.object_id AND o.workspace_id=g.source_workspace_id
      WHERE g.id=? AND g.org_id=? AND g.target_workspace_id=? AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?) FOR SHARE`,[grantId,orgId,targetWorkspaceId,now]);
    const grant=grants[0];
    if (!grant) { await client.query('COMMIT'); return null; }
    const after=decodeCursor(cursor);
    const params=[grant.org_id,grant.source_workspace_id,grant.object_id];
    let cursorClause='';
    if (after) { cursorClause=' AND (created_at<? OR (created_at=? AND id<?))'; params.push(after.createdAt,after.createdAt,after.id); }
    const limit=Math.max(1,Math.min(Number(pageSize)||50,100));
    params.push(limit+1);
    const { rows }=await client.query(`SELECT id,data,created_at FROM object_records
      WHERE org_id=? AND workspace_id=? AND object_id=?${cursorClause}
      ORDER BY created_at DESC,id DESC LIMIT ?`,params);
    const more=rows.length>limit;
    const selected=more?rows.slice(0,-1):rows;
    const fields=parseJson(grant.allowed_fields,[]);
    const records=selected.map(row=>{
      const source=parseJson(row.data,{}), data={};
      for (const key of fields) if (Object.hasOwn(source,key)) data[key]=source[key];
      return { data };
    });
    const last=selected[selected.length-1];
    await client.query('COMMIT');
    return { grant,records,nextCursor:more&&last?Buffer.from(JSON.stringify({createdAt:last.created_at,id:last.id})).toString('base64url'):null };
  } catch(error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

module.exports={list,create,revoke,readActiveSharedRecords};
