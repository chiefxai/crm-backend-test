// src/routes/index.js — central router: mounts all domain routers

const router = require("express").Router();

// Auth (public signup/login + authenticated /me)
router.use("/api/auth", require("./auth"));

// CRM objects & webhooks (webhooks are public — called by Meta/etc, no auth)
router.use("/api/objects", require("./objects"));
router.use("/api/webhooks", require("./webhooks"));

// Channels & conversations
const { channelsRouter, conversationsRouter } = require("./channels");
router.use("/api/channels", channelsRouter);
router.use("/api/conversations", conversationsRouter);

// Platform admin
router.use("/api/platform", require("./platform"));

// Telephony connectors — all HTTP endpoints (vobiz, twilio, telecmi, …)
// are mounted here via the registry. Adding a new provider = register it
// in src/telephony/registry.js, nowhere else.
router.use("/", require("../telephony/registry").buildRouter());

// Agent config & AI persona
router.use("/api/config", require("./config"));

// Per-org named agents
router.use("/api/agents", require("./agents"));

// Compliance & knowledge base
router.use("/api/compliance", require("./compliance"));
router.use("/api/knowledge", require("./knowledge"));

// Admin: audit-log, billing, metrics, SSE log-stream, list-models
router.use("/api", require("./admin"));

// Catalog: orders, catalog, customers, khata, questions, lead-responses, chroma
router.use("/api", require("./catalog"));

// Lending CRM
router.use("/api/leads", require("./leads"));
router.use("/api/contact-groups", require("./contactGroups"));
router.use("/api/enquiries", require("./enquiries"));
router.use("/api/ai-usage", require("./aiUsage"));
router.use("/api/loans", require("./loans"));

// Calls — mounted at /api because it handles both /api/calls and /api/call-logs
router.use("/api", require("./calls"));

// Campaigns, workflows, dialer
router.use("/api", require("./campaigns"));

// Settings (numbers, team, org)
router.use("/api/settings", require("./settings"));
router.use("/api/workspace-sharing", require("./workspaceSharing"));

// Dashboard analytics
router.use("/api/dashboard", require("./dashboard"));

// Integrations + AI (email, WhatsApp, Gemini CRM routes, simulate-call, telecmi-diag)
router.use("/api", require("./ai"));

module.exports = router;
