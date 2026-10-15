'use strict';
const routerFactory = require('express').Router;
const { requireAuth } = require('../middleware/auth');
const { getService } = require('./service');
const { ticketFor } = require('./channels/browserSse');
const { catalogFor } = require('./catalog');
const { getLogger } = require('../observability/logger');
const log = getLogger('notifications.http');

function handler(fn) {
  return async (req,res) => {
    try { await fn(req,res); }
    catch (error) {
      log.error('Notification endpoint failed',{message:error.message,path:req.path});
      return res.status(error instanceof TypeError ? 400 : 500).json({error:error instanceof TypeError ? error.message : 'Notification service is temporarily unavailable.'});
    }
  };
}
function mountCommon(router,audience) {
  const scope = (req) => ({ userId:req.userId,audience,
    ...(audience === 'organization' ? { orgId:req.orgId, workspaceId:req.workspaceId || req.orgId } : {}) });
  router.get('/catalog',handler(async (req,res) => res.json({ events:catalogFor(audience) })));
  router.get('/preferences',handler(async (req,res) => {
    const service=getService();
    await service.rememberUser({userId:req.userId,email:req.userEmail,audience});
    res.setHeader('Cache-Control','no-store');
    return res.json({events:await service.preferences(scope(req))});
  }));
  router.put('/preferences',handler(async(req,res) => {
    const changes=req.body?.changes;
    const events=await getService().setPreferences({ ...scope(req),changes });
    return res.json({events});
  }));
  router.get('/',handler(async(req,res) => {
    const service=getService();
    await service.rememberUser({userId:req.userId,email:req.userEmail,audience});
    res.setHeader('Cache-Control','no-store');
    return res.json({rows:await service.list({...scope(req),limit:req.query.limit})});
  }));
  router.post('/read',handler(async(req,res) => {
    if (req.body?.id != null && (typeof req.body.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(req.body.id))) throw new TypeError('Invalid notification id.');
    return res.json(await getService().markRead({...scope(req),id:req.body?.id || null}));
  }));
}
function createUserRouter() {
  const router=routerFactory();
  router.use(requireAuth);
  mountCommon(router,'organization');
  return router;
}
function createPlatformRouter() {
  const router=routerFactory();
  router.post('/stream-ticket',handler(async(req,res)=>{
    // Parent /api/platform router verifies identity and the platform-admin
    // allowlist before this short-lived SSE credential can be issued.
    return res.json({ticket:ticketFor({userId:req.userId,email:req.userEmail})});
  }));
  mountCommon(router,'platform');
  return router;
}
module.exports={createUserRouter,createPlatformRouter};