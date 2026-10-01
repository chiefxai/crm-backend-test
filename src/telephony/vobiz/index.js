// Vobiz provider implementation boundary. All Vobiz-specific telephony,
// media, recording, provisioning and webhook behavior lives in this folder.
module.exports={...require("./vobizProxy"),...require("./vobizPipelineCascaded"),...require("./vobizInboundProvision"),...require("./vobizWebhookAuth"),...require("./vobizSignature"),...require("./vobizOutboundAudio"),...require("./vobizOutboundPrewarm"),...require("./vobizOpeningGreeting"),...require("./vobizCallPrompt"),...require("./vobizStarhealthTool")};
