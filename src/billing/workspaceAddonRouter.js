'use strict';

const router = require('express').Router();
const {requireAuth,requirePermission} = require('../middleware/auth');
const {buildBillingContext} = require('./httpContext');
const {requireBillingSubmitRole,paymentError} = require('./paymentSubmissionRouter');
const {createWorkspaceAddonBilling,purchasesEnabled,topupRedemptionEnabled} = require('./workspaceAddonBilling');
const {safeErrorMessage} = require('../observability/safeError');

function enabled(_req,res,next) {
  if (!purchasesEnabled()) return res.status(503).json({error:'Workspace add-on payments are currently unavailable. Contact your platform administrator.'});
  next();
}
function errorResponse(res,error) {
  if (error.statusCode) return res.status(error.statusCode).json({error:safeErrorMessage(error)});
  return paymentError(res,error);
}
router.get('/workspace-addons',requireAuth,requirePermission('billing.organization.read'),async(req,res) => {
  try {
    const service=createWorkspaceAddonBilling();
    const [rows,topupBalance]=await Promise.all([service.list(req.orgId),service.availableTopupBalance(req.orgId)]);
    res.json({purchasesAvailable:purchasesEnabled(),topupPaymentAvailable:topupRedemptionEnabled(),
      unallocatedTopupCredits:topupBalance,rows});
  } catch (error) { errorResponse(res,error); }
});
router.post('/workspace-addons',requireAuth,requirePermission('organization.manage'),requirePermission('billing.read'),requireBillingSubmitRole,enabled,async(req,res) => {
  if (!require('../workspaces/capabilities').multipleWorkspacesEnabled()) return res.status(404).json({error:'Workspace provisioning is not enabled'});
  try {
    const context = buildBillingContext(req);
    const membership = await require('../db/repository').findMembershipForUser(req.userId,req.userEmail,req.orgId);
    if (!membership?.memberId) return res.status(403).json({error:'An active organization membership is required.'});
    res.status(201).json(await createWorkspaceAddonBilling().createPurchase({orgId:req.orgId,memberId:membership.memberId,input:req.body,context}));
  } catch (error) { errorResponse(res,error); }
});
// Top-up credits are already funded. This route consumes only the organization's
// unallocated top-up grants; invoice settlement and provisioning are atomic.
router.post('/workspace-addons/pay-with-topup',requireAuth,requirePermission('organization.manage'),
  requirePermission('billing.read'),requireBillingSubmitRole,async(req,res)=>{
    if(!topupRedemptionEnabled()) return res.status(503).json({error:'Workspace payments with top-up credits are not enabled.'});
    if(!require('../workspaces/capabilities').multipleWorkspacesEnabled()) return res.status(404).json({error:'Workspace provisioning is not enabled.'});
    try {
      const context=buildBillingContext(req);
      const membership=await require('../db/repository').findMembershipForUser(req.userId,req.userEmail,req.orgId);
      if(!membership?.memberId) return res.status(403).json({error:'An active organization membership is required.'});
      const result=await createWorkspaceAddonBilling().purchaseWithTopup({orgId:req.orgId,memberId:membership.memberId,input:req.body,context});
      res.status(201).json(result);
    } catch(error){errorResponse(res,error);}
  });

router.put('/workspace-addons/:id/renewal',requireAuth,requirePermission('billing.read'),requireBillingSubmitRole,async(req,res) => {
  try { res.json(await createWorkspaceAddonBilling().changeRenewal({orgId:req.orgId,addonId:req.params.id,autoRenew:req.body?.autoRenew,context:buildBillingContext(req)})); }
  catch (error) { errorResponse(res,error); }
});
router.delete('/workspace-addons/:id',requireAuth,requirePermission('billing.read'),requireBillingSubmitRole,async(req,res) => {
  try { res.json(await createWorkspaceAddonBilling().cancelPending({orgId:req.orgId,addonId:req.params.id,context:buildBillingContext(req)})); }
  catch (error) { errorResponse(res,error); }
});

module.exports = {router};
