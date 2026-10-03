const {getLogger}=require("../observability/logger");
const log=getLogger("telephony.registry");
const {validateConnector,capabilitiesOf}=require("./base");
const connectors=new Map();
function register(c){
  validateConnector(c);
  c.capabilities=capabilitiesOf(c);
  connectors.set(c.name,c);
  if (typeof c.registerBackgroundWorkers === "function") {
    c.registerBackgroundWorkers();
  }
  log.info(`📡 Registered telephony connector: ${c.label||c.name} | capabilities=${JSON.stringify(c.capabilities)}`);
  return c;
}
function get(n){return connectors.get(n)}
function all(){return [...connectors.values()]}
function handleUpgrade(req,socket,head,path){for(const c of connectors.values())if(c.wsPaths.includes(path)){c.handleUpgrade(req,socket,head,path);return true}return false}
function buildRouter(){const router=require("express").Router();for(const c of connectors.values())router.use("/",c.getRouter());return router}
function findConnector(name){if(!name)return null;const direct=connectors.get(name);if(direct)return direct;const key=String(name).trim().toLowerCase();for(const [slug,c] of connectors.entries()){const label=String(c.label||"").toLowerCase();if(slug.toLowerCase()===key||label===key||key.includes(slug.toLowerCase())||slug.toLowerCase().includes(key))return c}return null}
function getDefaultProvider(){const configured=process.env.DEFAULT_TELEPHONY_PROVIDER||process.env.TELEPHONY_PROVIDER;if(configured&&findConnector(configured))return findConnector(configured).name;return all().find(c=>c.capabilities?.outbound)?.name||all()[0]?.name||null}
function supportsOutbound(name){const c=findConnector(name||getDefaultProvider());return !!c?.capabilities?.outbound}
async function triggerOutboundCall(name,orgId,phone,options={}){const c=findConnector(name||getDefaultProvider());if(!c||typeof c.triggerOutboundCall!=="function")throw new Error(`[telephony/registry] Telephony provider "${name||getDefaultProvider()}" is not registered or does not support outbound calls.`);return c.triggerOutboundCall(orgId,phone,options)}
async function hangupCall(name,sid,orgId){const c=findConnector(name||getDefaultProvider());if(!c||typeof c.hangupCall!=="function"){log.warn(`⚠️ Cannot hang up call ${sid}: provider "${name||"default"}" has no hangup implementation.`);return}return c.hangupCall(sid,orgId)}
register(require("./connectors/gemini"));register(require("./connectors/vobiz"));register(require("./connectors/telecmi"));
module.exports={register,get,all,handleUpgrade,buildRouter,findConnector,getDefaultProvider,supportsOutbound,triggerOutboundCall,hangupCall};