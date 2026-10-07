// Vobiz provider adapter. Signed media authorization binds the call to one
// active workspace before any socket callbacks or CRM queries are registered.
const { WebSocketServer } = require("ws");
const { incrementSessions, decrementSessions, getActiveSessionsCount } = require("../../shared");
const { runWithScope } = require("../../workspaces/scope");
const workspaces = require("../../db/repositories/workspaceRepository");
const vobiz = require("../vobiz");
const { getLogger } = require("../../observability/logger");
const { normalizeCallStatus, normalizeCallIdentity, normalizeWebhookEvent, normalizeAudio, normalizeRecording } = require("../base");
const log = getLogger("telephony.connectors.vobiz");
const wss = new WebSocketServer({ noServer: true });
const wssCascaded = new WebSocketServer({ noServer: true });
function reject(socket, status = 401, message = "Unauthorized") {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
function startSession(handler, ws, req) {
  incrementSessions();
  ws.once("close", () => decrementSessions());
  log.info(`[vobiz] call connected | Active: ${getActiveSessionsCount()}`);
  runWithScope(req.vobizStreamContext, () => Promise.resolve(handler(ws, req.vobizStreamContext)))
    .catch(err => {
      log.error("[vobiz] stream initialization failed:", err.message);
      try { ws.close(1011, "Stream initialization failed"); } catch {}
    });
}
wss.on("connection", (ws, req) => startSession(vobiz.handleVobizSession, ws, req));
wssCascaded.on("connection", (ws, req) => startSession(vobiz.handleVobizSessionCascaded, ws, req));
module.exports = {
  name: "vobiz", label: "Vobiz.ai",
  capabilities: { inbound: true, outbound: true, recording: true, streaming: true, dtmf: true, numberProvisioning: true, machineDetection: true },
  registerBackgroundWorkers() { vobiz.registerPostCallWorker(); },
  normalizeCallStatus, normalizeCallIdentity, normalizeWebhookEvent, normalizeAudio, normalizeRecording,
  wsPaths: ["/vobiz/stream", "/vobiz/stream-cascaded"],
  async handleUpgrade(request, socket, head, pathname) {
    try {
      const url = new URL(request.url, "http://localhost");
      const context = vobiz.verifyVobizStreamToken(url.searchParams.get("stream_token"));
      if (!context) return reject(socket);
      if (!await workspaces.getActive(context.orgId, context.workspaceId)) return reject(socket, 403, "Forbidden");
      if (socket.destroyed) return;
      request.vobizStreamContext = { callId: String(context.callId), orgId: context.orgId, workspaceId: context.workspaceId };
      const server = pathname === "/vobiz/stream" ? wss : wssCascaded;
      server.handleUpgrade(request, socket, head, ws => server.emit("connection", ws, request));
    } catch (err) {
      log.error("[vobiz] media authorization failed:", err.message);
      if (!socket.destroyed) reject(socket, 503, "Service Unavailable");
    }
  },
  getRouter() {
    const router = require("express").Router();
    router.use("/api/vobiz", require("../vobiz/routes"));
    return router;
  },
  async triggerOutboundCall(orgId, phoneNumber, options = {}) { return vobiz.triggerVobizOutboundCall(orgId, phoneNumber, options); },
  async hangupCall(callSid, orgId) { return vobiz.hangupVobizCall(callSid, orgId); },
  buildInboundWebhookUrl(baseUrl) { return vobiz.buildVobizIncomingWebhookUrl(baseUrl); },
  async provisionInboundNumber(authId, authToken, phoneNumber) { return vobiz.ensureVobizInboundApplication(authId, authToken, phoneNumber); },
};
