// TeleCMI transport adapter for Chief Voice.
// TeleCMI owns SIP/RTP on its own VM; this module only owns the secure
// webhook + media WebSocket boundary and delegates the actual AI session
// to the shared Gemini Live browser-session engine.
const crypto = require("crypto");
const express = require("express");
const { EventEmitter } = require("events");
const { WebSocketServer } = require("ws");
const { handleBrowserSession } = require("../geminiProxy");
const db = require("../../db/repository");
const { getLogger } = require("../../observability/logger");
const log = getLogger("telephony.telecmi");

const pendingCalls = new Map();
const streamTickets = new Map();
const activeStreams = new Map();
const TICKET_TTL_MS = 5 * 60 * 1000;
const CALL_TTL_MS = 30 * 60 * 1000;

function secret() {
  return String(process.env.TELECMI_STREAM_SECRET || process.env.TELECMI_WEBHOOK_SECRET || process.env.INTERNAL_API_SECRET || "").trim();
}
function webhookAuthorized(req) {
  const expected = String(process.env.TELECMI_WEBHOOK_SECRET || "").trim();
  if (!expected) return false;
  const supplied = String(req.headers["x-telecmi-webhook-secret"] || "").trim();
  return supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
function makeTicket(context) {
  const key = secret();
  if (!key) throw new Error("TELECMI_STREAM_SECRET (or TELECMI_WEBHOOK_SECRET/INTERNAL_API_SECRET) is required");
  const payload = Buffer.from(JSON.stringify({ ...context, exp: Date.now() + TICKET_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyTicket(token) {
  try {
    const [payload, supplied] = String(token || "").split(".");
    if (!payload || !supplied) return null;
    const key = secret();
    if (!key) return null;
    const expected = crypto.createHmac("sha256", key).update(payload).digest("base64url");
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || Date.now() > Number(data.exp)) return null;
    return data;
  } catch { return null; }
}
function remember(map, key, value, ttl) {
  map.set(String(key), value);
  setTimeout(() => { if (map.get(String(key)) === value) map.delete(String(key)); }, ttl).unref?.();
}
function reject(socket, status=401, message="Unauthorized") {
  try { socket.write(`HTTP/1.1 ${status} ${message}\\r\\nConnection: close\\r\\n\\r\\n`); } catch {}
  try { socket.destroy(); } catch {}
}
function resample24To16(buffer24) {
  const input = new Int16Array(buffer24.buffer.slice(buffer24.byteOffset, buffer24.byteOffset + buffer24.byteLength));
  const output = new Int16Array(Math.floor(input.length * 2 / 3));
  for (let i = 0; i < output.length; i++) {
    const pos = i * 1.5;
    const lo = Math.floor(pos);
    const hi = Math.min(input.length - 1, lo + 1);
    const frac = pos - lo;
    output[i] = Math.round(input[lo] * (1 - frac) + input[hi] * frac);
  }
  return Buffer.from(output.buffer);
}

class TeleCMIBrowserSocket extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.readyState = 1;
  }
  send(data) {
    if (this.readyState !== 1 || this.ws.readyState !== 1) return;
    try {
      const message = typeof data === "string" ? JSON.parse(data) : data;
      if (message?.type === "audio" && message.data) {
        const pcm24 = Buffer.from(message.data, "base64");
        const pcm16 = resample24To16(pcm24);
        this.ws.send(JSON.stringify({
          event: "playAudio",
          media: { contentType: "audio/x-l16", sampleRate: 16000, payload: pcm16.toString("base64") }
        }));
      } else if (message?.type === "interrupted") {
        this.ws.send(JSON.stringify({ event: "clearAudio" }));
      }
      // transcript/ready/turn_complete/ended are intentionally not sent to
      // TeleCMI; its transport contract only needs media control frames.
    } catch (err) {
      log.warn("[telecmi] Failed to translate backend media frame:", err.message);
    }
  }
  close(code=1000, reason="") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    try { this.ws.close(code, reason); } catch {}
  }
  fail(err) { this.emit("error", err); }
  receive(message) { if (this.readyState === 1) this.emit("message", Buffer.from(message)); }
  end() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

function buildConnectorUrl() {
  return String(process.env.TELECMI_CONNECTOR_URL || "").replace(/\\/$/, "");
}
function controlHeaders() {
  const token = String(process.env.TELECMI_CONTROL_TOKEN || "").trim();
  if (!token) throw new Error("TELECMI_CONTROL_TOKEN is required");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function triggerTelecmiOutboundCall(orgId, phoneNumber, options={}) {
  const base = buildConnectorUrl();
  if (!base) throw new Error("TELECMI_CONNECTOR_URL is not configured");
  const from = String(options.from || "").trim();
  if (!from) throw new Error("A TeleCMI outbound number is required");
  const response = await fetch(`${base}/v1/calls`, {
    method: "POST",
    headers: controlHeaders(),
    body: JSON.stringify({ to: phoneNumber, from })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.callId) throw new Error(data.error || `TeleCMI dial failed (HTTP ${response.status})`);
  const context = {
    orgId: String(orgId), provider: "telecmi", providerCallSid: String(data.callId),
    callerNumber: from, calleeNumber: String(phoneNumber), direction: "outbound",
    campaignId: options.campaignId || options.taskId || null, taskId: options.taskId || null,
    leadId: options.leadId || null, agentId: options.agentId || null,
  };
  remember(pendingCalls, data.callId, context, CALL_TTL_MS);
  return { callSid: data.callId, callId: data.callId, status: data.status || "dialing" };
}

async function hangupTelecmiCall(callSid) {
  const base = buildConnectorUrl();
  if (!base) throw new Error("TELECMI_CONNECTOR_URL is not configured");
  const response = await fetch(`${base}/v1/calls/${encodeURIComponent(callSid)}/hangup`, { method:"POST", headers:controlHeaders() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `TeleCMI hangup failed (HTTP ${response.status})`);
  const stream = activeStreams.get(String(callSid));
  if (stream) stream.end();
  return data;
}

async function resolveContext(body) {
  const callId = String(body.CallUUID || body.callId || "").trim();
  const cached = pendingCalls.get(callId);
  if (cached) return cached;
  const from = String(body.From || "").trim();
  const to = String(body.To || "").trim();
  const direction = String(body.Direction || "").toLowerCase() === "outbound" ? "outbound" : "inbound";
  let orgId = null;
  try { orgId = await db.findOrgIdForNumber(direction === "outbound" ? from : to); } catch (err) { log.error("[telecmi] Number ownership lookup failed:", err.message); }
  if (!orgId) return null;
  let agentId = null;
  try {
    const agent = await db.getAgentForNumber(direction === "outbound" ? from : to);
    agentId = agent?.id || null;
  } catch {}
  return {
    orgId: String(orgId), provider: "telecmi", providerCallSid: callId,
    callerNumber: from, calleeNumber: to, direction, agentId,
  };
}

async function incoming(req, res) {
  if (!webhookAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
  const body = req.body || {};
  const callId = String(body.CallUUID || body.callId || "").trim();
  const event = String(body.Event || "").trim().toLowerCase();
  const status = String(body.CallStatus || "").trim().toLowerCase();
  if (!callId) return res.status(400).json({ error: "CallUUID is required" });

  const context = await resolveContext(body);
  if (!context) return res.status(404).json({ action: "reject", error: "TeleCMI number is not assigned to a Chief Voice organization" });

  const isHangup = event === "hangup" || ["completed","failed","busy","no-answer","no answer"].includes(status);
  if (isHangup) {
    const stream = activeStreams.get(callId);
    if (stream) stream.end();
    activeStreams.delete(callId);
    pendingCalls.delete(callId);
    return res.json({ ok: true });
  }
  if (event !== "startapp") return res.json({ streamUrl: "" });

  const token = makeTicket(context);
  remember(streamTickets, token, context, TICKET_TTL_MS);
  return res.json({ streamUrl: `${process.env.TELECMI_PUBLIC_WS_URL || ""}/telecmi/stream?stream_token=${encodeURIComponent(token)}` });
}

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  const context = req.telecmiStreamContext;
  const adapter = new TeleCMIBrowserSocket(ws);
  activeStreams.set(String(context.providerCallSid), adapter);
  log.info(`📞 [telecmi] media connected call=${context.providerCallSid} org=${context.orgId}`);
  Promise.resolve(handleBrowserSession(adapter, context)).catch((err) => {
    log.error("[telecmi] Gemini session failed:", err.message);
    adapter.fail(err);
    adapter.close(1011, "Voice session initialization failed");
  });
  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.event === "media") {
        const payload = message.media?.payload;
        if (payload) adapter.receive(JSON.stringify({ type:"audio", data:payload }));
      } else if (message.event === "stop") {
        adapter.end();
      }
    } catch (err) { log.warn("[telecmi] Invalid media frame:", err.message); }
  });
  ws.on("close", () => {
    adapter.end();
    activeStreams.delete(String(context.providerCallSid));
  });
  ws.on("error", (err) => adapter.fail(err));
});

function handleUpgrade(request, socket, head) {
  try {
    const url = new URL(request.url, "http://localhost");
    const token = url.searchParams.get("stream_token");
    const context = verifyTicket(token);
    if (!context || !context.orgId || !context.providerCallSid) return reject(socket);
    request.telecmiStreamContext = context;
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } catch { reject(socket); }
}

function getRouter() {
  const router = express.Router();
  router.post("/api/telecmi/incoming", express.json({ limit:"64kb" }), incoming);
  return router;
}

module.exports = {
  name: "telecmi", label: "TeleCMI",
  capabilities: { inbound:true, outbound:true, recording:true, streaming:true, dtmf:false, numberProvisioning:false, machineDetection:false },
  wsPaths: ["/telecmi/stream"],
  handleUpgrade,
  getRouter,
  triggerOutboundCall: triggerTelecmiOutboundCall,
  hangupCall: hangupTelecmiCall,
};
