const crypto = require('crypto');
const { pool } = require('../pool');
const db = require('../client');

function parseJson(value, fallback) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return fallback; } }
  return value == null ? fallback : value;
}

function shareSecret() {
  const secret=process.env.WORKSPACE_SHARE_TOKEN_SECRET;
  if (!secret || secret.length<32) throw Object.assign(new Error('Workspace share token secret is not configured'),{statusCode:503});
  return crypto.createHash('sha256').update(secret).digest();
}
function encodeOpaque(value) {
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',shareSecret(),iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
function decodeOpaque(token) {
  try {
    const bytes=Buffer.from(String(token||''),'base64url');
    if (bytes.length<29) throw new Error('short token');
    const decipher=crypto.createDecipheriv('aes-256-gcm',shareSecret(),bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(12,28));
    const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
    return value;
  } catch(error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error('Invalid or expired share reference'),{statusCode:400});
  }
}
function encodeRecordRef(grantId,recordId,baseVersion) { return encodeOpaque({kind:'record',grantId,recordId,baseVersion}); }
function decodeRecordRef(token) {
  const value=decodeOpaque(token);
  if(value.kind!=='record'||typeof value.grantId!=='string'||typeof value.recordId!=='string'||typeof value.baseVersion!=='string')
    throw Object.assign(new Error('Invalid or expired record reference'),{statusCode:400});
  return value;
}
function recordVersion(row) {
  return crypto.createHash('sha256').update(JSON.stringify({updatedAt:row.updated_at||null,data:parseJson(row.data,{})})).digest('hex');
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

function decodeCursor(cursor,grantId) {
  if (!cursor) return null;
  try {
    const value=decodeOpaque(cursor);
    if (value.kind!=='cursor'||value.grantId!==grantId||typeof value.createdAt!=='string'||typeof value.id!=='string') throw new Error('invalid');
    return value;
  } catch { throw Object.assign(new Error('Invalid or expired page cursor'),{statusCode:400}); }
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
    const after=decodeCursor(cursor,grant.id);
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
      return { data,recordRef:encodeRecordRef(grant.id,row.id,recordVersion(row)) };
    });
    const last=selected[selected.length-1];
    await client.query('COMMIT');
    return { grant,records,nextCursor:more&&last?encodeOpaque({kind:'cursor',grantId:grant.id,createdAt:last.created_at,id:last.id}):null };
  } catch(error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

async function createProposal(orgId,targetWorkspaceId,grantId,recordRef,patch,memberId) {
  await db.ready;
  if (!patch || typeof patch!=='object' || Array.isArray(patch) || !Object.keys(patch).length || Buffer.byteLength(JSON.stringify(patch))>32768) {
    throw Object.assign(new Error('Provide a non-empty patch no larger than 32 KB'),{statusCode:400});
  }
  const reference=decodeRecordRef(recordRef);
  if (reference.grantId!==grantId) throw Object.assign(new Error('Record reference does not match this share'),{statusCode:400});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const now=new Date().toISOString();
    const {rows:grants}=await client.query(`SELECT g.* FROM workspace_share_grants g
      INNER JOIN workspaces sw ON sw.org_id=g.org_id AND sw.id=g.source_workspace_id AND sw.status='Active'
      INNER JOIN workspaces tw ON tw.org_id=g.org_id AND tw.id=g.target_workspace_id AND tw.status='Active'
      WHERE g.id=? AND g.org_id=? AND g.target_workspace_id=? AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?) FOR SHARE`,[grantId,orgId,targetWorkspaceId,now]);
    const grant=grants[0];
    if (!grant) throw Object.assign(new Error('Active incoming share was not found'),{statusCode:404});
    const allowed=new Set(parseJson(grant.allowed_fields,[]));
    if (Object.keys(patch).some(key=>!allowed.has(key))) throw Object.assign(new Error('A proposed field is outside the share allowlist'),{statusCode:403});
    const {rows:records}=await client.query(`SELECT id,data,updated_at FROM object_records
      WHERE org_id=? AND workspace_id=? AND object_id=? AND id=? FOR UPDATE`,[orgId,grant.source_workspace_id,grant.object_id,reference.recordId]);
    if (!records[0]) throw Object.assign(new Error('Shared record is no longer available'),{statusCode:404});
    if (recordVersion(records[0])!==reference.baseVersion) throw Object.assign(new Error('Record changed since it was shared; reload before proposing an edit'),{statusCode:409});
    const id=crypto.randomUUID();
    await client.query(`INSERT INTO workspace_share_proposals
      (id,org_id,grant_id,source_workspace_id,target_workspace_id,object_id,record_id,base_version,proposed_patch,status,proposed_by_member_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,[id,orgId,grantId,grant.source_workspace_id,targetWorkspaceId,grant.object_id,reference.recordId,reference.baseVersion,JSON.stringify(patch),memberId,now]);
    await client.query('COMMIT');
    return id;
  } catch(error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

async function listProposals(orgId,sourceWorkspaceId) {
  await db.ready;
  const {rows}=await pool.query(`SELECT p.*,o.key AS object_key,o.label AS object_label,
      sw.name AS source_workspace_name,tw.name AS target_workspace_name,pm.name AS proposer_name
    FROM workspace_share_proposals p
    INNER JOIN objects o ON o.org_id=p.org_id AND o.id=p.object_id AND o.workspace_id=p.source_workspace_id
    INNER JOIN workspaces sw ON sw.org_id=p.org_id AND sw.id=p.source_workspace_id
    INNER JOIN workspaces tw ON tw.org_id=p.org_id AND tw.id=p.target_workspace_id
    LEFT JOIN org_members pm ON pm.org_id=p.org_id AND pm.id=p.proposed_by_member_id
    WHERE p.org_id=? AND p.source_workspace_id=? ORDER BY p.created_at DESC,p.id DESC LIMIT 100`,[orgId,sourceWorkspaceId]);
  return rows.map(row=>({id:row.id,grantId:row.grant_id,objectKey:row.object_key,objectLabel:row.object_label,
    sourceWorkspaceName:row.source_workspace_name,targetWorkspaceName:row.target_workspace_name,recordId:row.record_id,
    baseVersion:row.base_version,patch:parseJson(row.proposed_patch,{}),previousData:parseJson(row.previous_data,null),
    status:row.status,proposerName:row.proposer_name,proposedByMemberId:row.proposed_by_member_id,
    reviewedByMemberId:row.reviewed_by_member_id,createdAt:row.created_at,reviewedAt:row.reviewed_at}));
}

async function reviewProposal(orgId,sourceWorkspaceId,proposalId,decision,reviewerMemberId) {
  await db.ready;
  if (!['approved','rejected'].includes(decision)) throw Object.assign(new Error('Decision must be approved or rejected'),{statusCode:400});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:proposals}=await client.query(`SELECT * FROM workspace_share_proposals
      WHERE id=? AND org_id=? AND source_workspace_id=? AND status='pending' FOR UPDATE`,[proposalId,orgId,sourceWorkspaceId]);
    const proposal=proposals[0];
    if (!proposal) throw Object.assign(new Error('Pending proposal was not found'),{statusCode:404});
    const now=new Date().toISOString();
    if (decision==='rejected') {
      await client.query(`UPDATE workspace_share_proposals SET status='rejected',reviewed_by_member_id=?,reviewed_at=? WHERE id=?`,[reviewerMemberId,now,proposalId]);
      await client.query('COMMIT');
      return {status:'rejected'};
    }
    const {rows:grants}=await client.query(`SELECT g.id FROM workspace_share_grants g
      INNER JOIN workspaces sw ON sw.org_id=g.org_id AND sw.id=g.source_workspace_id AND sw.status='Active'
      INNER JOIN workspaces tw ON tw.org_id=g.org_id AND tw.id=g.target_workspace_id AND tw.status='Active'
      WHERE g.id=? AND g.org_id=? AND g.source_workspace_id=? AND g.target_workspace_id=? AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?) FOR SHARE`,[proposal.grant_id,orgId,sourceWorkspaceId,proposal.target_workspace_id,now]);
    if (!grants[0]) {
      await client.query(`UPDATE workspace_share_proposals SET status='share_inactive',reviewed_by_member_id=?,reviewed_at=? WHERE id=?`,[reviewerMemberId,now,proposalId]);
      await client.query('COMMIT');
      return {status:'share_inactive'};
    }
    const {rows:records}=await client.query(`SELECT id,data,updated_at FROM object_records
      WHERE org_id=? AND workspace_id=? AND object_id=? AND id=? FOR UPDATE`,[orgId,sourceWorkspaceId,proposal.object_id,proposal.record_id]);
    const current=records[0];
    if (!current) throw Object.assign(new Error('Source record no longer exists'),{statusCode:404});
    if (recordVersion(current)!==proposal.base_version) {
      await client.query(`UPDATE workspace_share_proposals SET status='stale',reviewed_by_member_id=?,reviewed_at=? WHERE id=?`,[reviewerMemberId,now,proposalId]);
      await client.query('COMMIT');
      return {status:'stale'};
    }
    const previousData=parseJson(current.data,{}), nextData={...previousData,...parseJson(proposal.proposed_patch,{})};
    const {rows:requiredFields}=await client.query(`SELECT \`key\`,label FROM object_fields
      WHERE org_id=? AND workspace_id=? AND object_id=? AND required=1`,[orgId,sourceWorkspaceId,proposal.object_id]);
    const missing=requiredFields.find(field=>nextData[field.key]===undefined||nextData[field.key]===null||nextData[field.key]==='');
    if (missing) throw Object.assign(new Error(`The change would leave required field "${missing.label}" empty`),{statusCode:400});
    await client.query(`UPDATE object_records SET data=?,updated_at=? WHERE org_id=? AND workspace_id=? AND object_id=? AND id=?`,
      [JSON.stringify(nextData),now,orgId,sourceWorkspaceId,proposal.object_id,proposal.record_id]);
    await client.query(`UPDATE workspace_share_proposals SET status='approved',previous_data=?,reviewed_by_member_id=?,reviewed_at=? WHERE id=?`,
      [JSON.stringify(previousData),reviewerMemberId,now,proposalId]);
    await client.query('COMMIT');
    return {status:'approved'};
  } catch(error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally { client.release(); }
}

module.exports={list,create,revoke,readActiveSharedRecords,createProposal,listProposals,reviewProposal};
