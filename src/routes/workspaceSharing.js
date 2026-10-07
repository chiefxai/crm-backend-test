const router=require('express').Router();
const { requireAuth,requirePermission }=require('../middleware/auth');
const workspaceSharing=require('../db/repositories/workspaceSharingRepository');
const auditLog=require('../platform/auditLog');
const { workspaceSharingEnabled }=require('../workspaces/capabilities');

function requireSharing(req,res,next) {
  if (!workspaceSharingEnabled()) return res.status(404).json({error:'Workspace sharing is not enabled'});
  next();
}
function requireWorkspaceAdmin(req,res,next) {
  if (req.authorization?.workspaceRole !== 'Workspace Admin') return res.status(403).json({error:'Workspace Admin role required'});
  next();
}
router.use(requireAuth,requireSharing);

router.get('/grants',requirePermission('workspace.read'),async(req,res)=>{
  try { res.json(await workspaceSharing.list(req.orgId,req.workspaceId)); }
  catch(error) { res.status(error.statusCode||500).json({error:'Could not load workspace sharing grants'}); }
});

router.post('/grants',requirePermission('workspace.settings.manage'),requireWorkspaceAdmin,async(req,res)=>{
  const targetWorkspaceId=String(req.body?.targetWorkspaceId||'').trim();
  const objectKey=String(req.body?.objectKey||'').trim();
  const allowedFields=req.body?.allowedFields;
  const expiresAt=String(req.body?.expiresAt||'').trim();
  if (!targetWorkspaceId || !objectKey || !Array.isArray(allowedFields) || allowedFields.length>100 || allowedFields.some(key=>typeof key!=='string')) {
    return res.status(400).json({error:'Target workspace, object, and an explicit field allowlist are required'});
  }
  const expiryDate=new Date(expiresAt);
  const now=Date.now();
  if (!expiresAt || !Number.isFinite(expiryDate.getTime()) || expiryDate.getTime()<=now || expiryDate.getTime()>now+366*24*60*60*1000) {
    return res.status(400).json({error:'Choose an expiry time within the next year'});
  }
  try {
    const membership=await require('../db/repository').findMembershipForUser(req.userId,req.userEmail,req.orgId);
    if (!membership?.memberId) return res.status(403).json({error:'Active organization membership required'});
    const id=await workspaceSharing.create(req.orgId,req.workspaceId,targetWorkspaceId,objectKey,allowedFields,membership.memberId,expiryDate.toISOString());
    await auditLog.record(req.orgId,req,'workspace.share.create','workspace_share',id,{targetWorkspaceId,objectKey,allowedFields,expiresAt:expiryDate.toISOString()});
    res.status(201).json({id});
  } catch(error) { res.status(error.statusCode||500).json({error:error.statusCode?error.message:'Could not create workspace sharing grant'}); }
});

router.delete('/grants/:id',requirePermission('workspace.settings.manage'),requireWorkspaceAdmin,async(req,res)=>{
  try {
    const revoked=await workspaceSharing.revoke(req.orgId,req.workspaceId,req.params.id);
    if (!revoked) return res.status(404).json({error:'Active outgoing sharing grant was not found'});
    await auditLog.record(req.orgId,req,'workspace.share.revoke','workspace_share',req.params.id,{});
    res.json({success:true});
  } catch(error) { res.status(error.statusCode||500).json({error:'Could not revoke workspace sharing grant'}); }
});

router.get('/records/:grantId',requirePermission('workspace.read'),async(req,res)=>{
  try {
    const pageSize=Math.max(1,Math.min(Number.parseInt(req.query.limit,10)||50,100));
    const result=await workspaceSharing.readActiveSharedRecords(req.orgId,req.workspaceId,req.params.grantId,req.query.cursor,pageSize);
    if (!result) return res.status(404).json({error:'Active incoming share was not found'});
    const {grant,...page}=result;
    res.json({grant:{id:grant.id,objectKey:grant.object_key,objectLabel:grant.object_label,sourceWorkspaceId:grant.source_workspace_id},...page});
  } catch(error) { res.status(error.statusCode||500).json({error:error.statusCode?error.message:'Could not load shared records'}); }
});

module.exports=router;
