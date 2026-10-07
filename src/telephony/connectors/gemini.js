const { runWithScope } = require("../../workspaces/scope");
// src/telephony/connectors/gemini.js — Gemini browser voice-session connector
//
// Handles the /session WebSocket path used by the web dashboard's
// in-browser voice testing panel.
//
// VOICE_ENGINE env var selects the pipeline:
//   "pipeline"    (default) — STT → LLM → TTS (three separate Gemini calls per turn)
//   "audio2audio" — Gemini Live native audio-to-audio
//
// No HTTP routes — this connector is WebSocket-only.

const { WebSocketServer } = require("ws");
const { incrementSessions, decrementSessions, getActiveSessionsCount } = require("../../shared");
const { getLogger } = require("../../observability/logger");
const { verifyWebSocketTicket, resolveAuthorization } = require("../../middleware/auth");
const log = getLogger("telephony.connectors.gemini");
const activeByOrg = new Map();
const MAX_SESSIONS_PER_ORG = Number(process.env.MAX_BROWSER_VOICE_SESSIONS_PER_ORG || 5);

const VOICE_ENGINE = (process.env.VOICE_ENGINE || "pipeline").toLowerCase();
const { handleBrowserSession: handleAudio2Audio } = require("../geminiProxy");
const { handleBrowserSession: handlePipeline } = require("../geminiPipeline");

function handleBrowserSession(ws, sessionContext) {
  return VOICE_ENGINE === "audio2audio" ? handleAudio2Audio(ws, sessionContext) : handlePipeline(ws, sessionContext);
}
log.info(`🎚️  [gemini] voice engine: ${VOICE_ENGINE}`);

// ── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  const ticket = req.browserWsTicket;
  const orgId = ticket.orgId;
  const current = activeByOrg.get(orgId) || 0;
  if (current >= MAX_SESSIONS_PER_ORG) {
    ws.close(1013, "Too many active voice sessions for this organization");
    return;
  }
  activeByOrg.set(orgId, current + 1);
  incrementSessions();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  log.info(`🌐 [gemini] browser session connected org=${orgId} user=${ticket.sub} from ${ip} | Active: ${getActiveSessionsCount()}`);
  Promise.resolve(runWithScope({ orgId, workspaceId: ticket.workspaceId || orgId }, () => handleBrowserSession(ws, ticket))).catch((err) => {
    log.error("❌ Gemini browser session failed:", err.message);
    try { ws.close(1011, "Voice session initialization failed"); } catch {}
  });
  let checking = false;
  const accessTimer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const access = await resolveAuthorization({ userId: ticket.sub,email: ticket.email,orgId,
        workspaceId: ticket.workspaceId || orgId,platformAdmin: ticket.platformAdmin === true });
      if (!access.permissions.includes('workspace.call')) ws.close(1008,'Voice access revoked');
    } catch { ws.close(1008,'Voice access unavailable'); }
    finally { checking = false; }
  },30000);
  accessTimer.unref();
  ws.on("close", () => {
    clearInterval(accessTimer);
    const next = Math.max(0, (activeByOrg.get(orgId) || 1) - 1);
    if (next) activeByOrg.set(orgId, next); else activeByOrg.delete(orgId);
    decrementSessions();
    log.info(`🌐 [gemini] browser session disconnected org=${orgId} | Active: ${getActiveSessionsCount()}`);
  });
});

// ── Connector interface ──────────────────────────────────────────────────────

module.exports = {
  name: "gemini",
  label: "Gemini Browser Session",
  capabilities: { inbound: false, outbound: false, recording: false, streaming: true, dtmf: false, numberProvisioning: false, machineDetection: false },
  wsPaths: ["/session"],

  async handleUpgrade(request, socket, head, _pathname) {
    try {
      const url = new URL(request.url, "http://localhost");
      const ticket = verifyWebSocketTicket(url.searchParams.get("ticket"));
      if (!ticket) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      const access = await resolveAuthorization({ userId: ticket.sub,email: ticket.email,orgId: ticket.orgId,
        workspaceId: ticket.workspaceId || ticket.orgId,platformAdmin: ticket.platformAdmin === true });
      if (!access.permissions.includes('workspace.call')) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
      }
      if (socket.destroyed) return;
      request.browserWsTicket = ticket;
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  },

  // No HTTP routes for browser sessions.
  getRouter() {
    return require("express").Router();
  },
};
