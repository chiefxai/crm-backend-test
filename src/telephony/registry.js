const {getLogger}=require("../observability/logger");
const log=getLogger("telephony.registry");
const {validateConnector,capabilitiesOf,normalizeCredentialSchema,providerDefinitionOf}=require("./base");
const connectors=new Map();
function register(c){
  validateConnector(c);
  // The provider key identifies the adapter implementation. Connector account
  // instances are managed separately and may share this key.
  c.providerKey=c.providerKey||c.name;
  c.credentialSchema=normalizeCredentialSchema(c.credentialSchema,c.name);
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
function listProviderDefinitions(){return all().map(providerDefinitionOf)}
function handleUpgrade(req,socket,head,path){for(const c of connectors.values())if(c.wsPaths.includes(path)){c.handleUpgrade(req,socket,head,path);return true}return false}
function buildRouter(){const router=require("express").Router();for(const c of connectors.values())router.use("/",c.getRouter());return router}
function findConnector(name){if(!name)return null;const direct=connectors.get(name);if(direct)return direct;const key=String(name).trim().toLowerCase();for(const [slug,c] of connectors.entries()){const label=String(c.label||"").toLowerCase();if(slug.toLowerCase()===key||label===key||key.includes(slug.toLowerCase())||slug.toLowerCase().includes(key))return c}return null}
function getDefaultProvider(){const configured=process.env.DEFAULT_TELEPHONY_PROVIDER||process.env.TELEPHONY_PROVIDER;if(configured&&findConnector(configured))return findConnector(configured).name;return all().find(c=>c.capabilities?.outbound)?.name||all()[0]?.name||null}
function supportsOutbound(name){const c=findConnector(name||getDefaultProvider());return !!c?.capabilities?.outbound}
async function triggerOutboundCall(name,orgId,phone,options={}){const c=findConnector(name||getDefaultProvider());if(!c||typeof c.triggerOutboundCall!=="function")throw new Error(`[telephony/registry] Telephony provider "${name||getDefaultProvider()}" is not registered or does not support outbound calls.`);return c.triggerOutboundCall(orgId,phone,options)}
async function hangupCall(name,sid,orgId){const c=findConnector(name||getDefaultProvider());if(!c||typeof c.hangupCall!=="function"){log.warn(`⚠️ Cannot hang up call ${sid}: provider "${name||"default"}" has no hangup implementation.`);return}return c.hangupCall(sid,orgId)}
register(require("./connectors/gemini"));register(require("./connectors/vobiz"));
module.exports={register,get,all,listProviderDefinitions,handleUpgrade,buildRouter,findConnector,getDefaultProvider,supportsOutbound,triggerOutboundCall,hangupCall};
