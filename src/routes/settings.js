// src/routes/settings.js — /api/settings/*

const { safeErrorMessage } = require("../observability/safeError");
const crypto = require("crypto");
const router = require("express").Router();
const { requireAuth, requireRole, ADMIN_ROLES } = require("../middleware/auth");
const db = require("../db/repository");
const auditLog = require("../platform/auditLog");
const industryPacks = require("../seed/industryPacks");
const { updateConfigForOrg, buildIndustryPersona } = require("../config/agentConfig");
const mailer = require("../email/mailer");
const emailTemplates = require("../email/templates");
const authProvider = require("../auth");
const { getLogger } = require("../observability/logger");
const log = getLogger("routes.settings");
const { isDuplicateKeyError } = require("../lib/dbErrors");
const telephony = require("../telephony/registry");
const channelsEngine = require("../channels/engine");

// CRM stores human-readable job titles (Loan Agent, etc.). Only these
// auth-level roles are blocked from org-admin team creation — Cognito
// always provisions TeamMember regardless of the CRM title.
const AUTH_PRIVILEGED_ROLES = new Set(["Super Admin", "Organization Admin"]);

function isAuthPrivilegedRole(role) {
  return role && AUTH_PRIVILEGED_ROLES.has(String(role).trim());
}

function cognitoAuthHelpers() {
  try {
    return require("../auth/providers/cognito");
  } catch {
    return null;
  }
}

function cognitoTeamMemberGroup() {
  const cognito = cognitoAuthHelpers();
  return cognito?.COGNITO_ROLES?.TEAM_MEMBER || "TeamMember";
}

function cognitoTemporaryPassword() {
  const cognito = cognitoAuthHelpers();
  if (cognito?.generateCompliantTemporaryPassword) {
    return cognito.generateCompliantTemporaryPassword();
  }
  const crypto = require("crypto");
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const symbols = "!@#$%^&*_-+=";
  const all = upper + lower + digits + symbols;
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols), pick(all), pick(all)];
  return chars.join("");
}

// Paste this URL into the Vobiz portal as the number's Answer URL (must include webhook_secret).
router.get("/vobiz-inbound-webhook", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const baseUrl = (process.env.PUBLIC_API_BASE_URL || process.env.PUBLIC_URL || process.env.API_BASE_URL || "")
      .trim()
      .replace(/\/$/, "");
    const provider = telephony.findConnector("vobiz"); const incomingUrl = provider?.buildInboundWebhookUrl?.(baseUrl);
    if (!incomingUrl) {
      return res.status(503).json({
        error: "Public API base URL is not configured (set PUBLIC_API_BASE_URL).",
      });
    }
    const hasSecret = Boolean(process.env.VOBIZ_WEBHOOK_SECRET);
    res.json({
      incomingUrl,
      hasWebhookSecret: hasSecret,
      instructions: hasSecret
        ? "Use POST /api/settings/vobiz-inbound-webhook/sync to attach your Vobiz number automatically, or paste incomingUrl into the Vobiz Answer URL."
        : "VOBIZ_WEBHOOK_SECRET is not set; webhooks will be rejected in production until it is configured.",
    });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

router.post("/vobiz-inbound-webhook/sync", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const channel = await channelsEngine.getChannel(req.orgId, "vobiz");
    const authId = channel?.config?.authId;
    const authToken = channel?.config?.authToken;
    const phoneNumber = channel?.config?.phoneNumber || channel?.externalId;
    if (!authId || !authToken || !phoneNumber) {
      return res.status(400).json({ error: "Connect Vobiz in Channels settings (authId, authToken, phone number) before syncing inbound routing." });
    }
    const provider = telephony.findConnector("vobiz"); if (!provider?.provisionInboundNumber) return res.status(503).json({ error: "Vobiz provider is not registered." }); const result = await provider.provisionInboundNumber(authId, authToken, phoneNumber);
    res.json({
      success: true,
      appId: result.appId,
      incomingUrl: result.answerUrl,
      message: "Vobiz number is now attached to the ChiefVoice Answer URL. Place a test inbound call.",
    });
  } catch (err) {
    log.error("POST /api/settings/vobiz-inbound-webhook/sync failed:", err.message);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ── Virtual numbers ──
router.get("/numbers", requireAuth, async (req, res) => {
  try { res.json(await db.list("numbers", req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/numbers", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    if (req.body.number && !(await db.isNumberAvailable(req.body.number, req.orgId))) {
      return res.status(409).json({ error: "This number is already assigned to another organization." });
    }
    const n = await db.create("numbers", req.orgId, req.body);
    global.broadcastLog(`📞 Assigned virtual number: ${n.number}`, { type: "settings" });
    res.status(201).json(n);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/numbers/:id", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    if (req.body.number && !(await db.isNumberAvailable(req.body.number, req.orgId))) {
      return res.status(409).json({ error: "This number is already assigned to another organization." });
    }
    const updated = await db.patch("numbers", req.orgId, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Number not found" });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.delete("/numbers/:id", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    // A Vobiz number has two related records: the virtual-number entry used
    // by the CRM UI and the channel row used for the provider credentials.
    // Removing only the virtual number leaves the globally-unique
    // channels(type, external_id) row behind, so the same number cannot be
    // connected again later. Capture the number before deleting it and clean
    // up the corresponding Vobiz channel as part of the same removal flow.
    const numbers = await db.list("numbers", req.orgId);
    const numberRow = (numbers || []).find((n) => n.id === req.params.id);
    await db.remove("numbers", req.orgId, req.params.id);

    if (numberRow?.number) {
      const supabase = require("../db/client");
      await supabase
        .from("channels")
        .delete()
        .eq("org_id", req.orgId)
        .eq("type", "vobiz")
        .eq("external_id", numberRow.number);
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/numbers/sync", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const incoming = Array.isArray(req.body) ? req.body.map(n => n.number).filter(Boolean) : [];
    for (const number of incoming) {
      if (!(await db.isNumberAvailable(number, req.orgId))) {
        return res.status(409).json({ error: `Number "${number}" is already assigned to another organization.` });
      }
    }
    res.json(await db.replaceAll("numbers", req.orgId, req.body));
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Team members ──
// Returns the logged-in user's own membership info including granted feature flags.
router.get("/me", requireAuth, async (req, res) => {
  try {
    const [membership, org] = await Promise.all([
      db.findMembershipForUser(req.userId, req.userEmail),
      db.getOrg(req.orgId),
    ]);
    const orgFlags = await require("../platform/featureFlags").sanitizeFeatureKeys(Array.isArray(org?.featureFlags) ? org.featureFlags : []);
    const memberFlags = Array.isArray(membership?.featureFlags) ? membership.featureFlags : [];
    // Org admins get whatever the org-level flags are (controlled by super admin).
    // Other roles get the intersection of personal grants and org-level grants.
    const isOrgAdmin = req.userRole === "Organization Admin";
    const featureFlags = isOrgAdmin
      ? orgFlags
      : memberFlags.filter((f) => orgFlags.includes(f));
    res.json({
      userId: req.userId,
      email: req.userEmail,
      name: req.userName,
      role: req.userRole,
      orgId: req.orgId,
      featureFlags,
      orgFeatureFlags: orgFlags,
    });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.get("/team", requireAuth, async (req, res) => {
  try { res.json(await db.list("team", req.orgId)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/team", requireAuth, requireRole(["Organization Admin"]), async (req, res) => {
  try {
    const { featureFlags, role, ...memberFields } = req.body || {};
    let availableFeatureFlags = [];
    try {
      availableFeatureFlags = await require("../platform/featureFlags").sanitizeFeatureKeys(featureFlags);
    } catch (flagErr) {
      log.warn("sanitizeFeatureKeys failed for team create, using no flags:", flagErr.message);
    }

    if (isAuthPrivilegedRole(role)) {
      return res.status(400).json({ error: "Organization admins cannot assign platform or organization-admin roles." });
    }
    if (!memberFields.email) {
      return res.status(400).json({ error: "email is required" });
    }

    const crmRole = role && String(role).trim() ? String(role).trim() : "Team Member";

    const existingMember = await db.findOrgMemberByEmail(memberFields.email);
    if (existingMember) {
      const sameOrg = existingMember.orgId === req.orgId;
      return res.status(409).json({
        error: sameOrg
          ? "A team member with this email is already in your organization."
          : "This email is already registered to another organization.",
      });
    }

    const m = await db.addOrgMember(req.orgId, null, {
      ...memberFields,
      role: crmRole,
      feature_flags: availableFeatureFlags,
    });

    if ((process.env.AUTH_PROVIDER || "cognito").toLowerCase() === "cognito") {
      try {
        const tempPassword = cognitoTemporaryPassword();
        const authUserId = await authProvider.provisionUser(
          m.email,
          tempPassword,
          m.name || "",
          cognitoTeamMemberGroup()
        );

        if (!authUserId) throw new Error("Cognito did not return a user id");
        await db.updateOrgMemberUserId(req.orgId, m.id, authUserId);

        const org = await db.getOrg(req.orgId);
        const tpl = emailTemplates.welcomeEmail({
          orgName: org?.name || "your organization",
          adminEmail: m.email,
          tempPassword,
          role: crmRole,
        });
        mailer.sendMail({ to: m.email, ...tpl })
          .catch((err) => log.error("⚠️  Welcome email failed:", err.message));

        global.broadcastLog(`👤 Registered team member: ${m.name}`, { type: "settings" });
        auditLog.record(req.orgId, req, "team.add", "team_member", m.id, {
          name: m.name,
          role: crmRole,
          authUserId,
        });
        return res.status(201).json({ ...m, userId: authUserId, role: crmRole, credsSent: true });
      } catch (authErr) {
        // Do not leave an org member record that cannot authenticate.
        await db.remove("team", req.orgId, m.id).catch((cleanupErr) =>
          log.error("⚠️  Failed to clean up member after Cognito provisioning failure:", cleanupErr.message)
        );
        log.error("⚠️  Cognito team-member provisioning failed:", authErr.message);
        return res.status(502).json({
          error: "Team member could not be provisioned in Cognito.",
          detail: authErr.message,
        });
      }
    }

    // Preserve the provider-agnostic behavior for non-Cognito deployments.
    const authUserId = await authProvider.provisionUser(
      m.email,
      null,
      m.name || "",
      cognitoTeamMemberGroup()
    ).catch((authErr) => {
      log.warn(`⚠️  Authentication provider provisioning deferred for ${m.email}: ${authErr.message}`);
      return null;
    });
    if (authUserId) await db.updateOrgMemberUserId(req.orgId, m.id, authUserId);

    global.broadcastLog(`👤 Registered team member: ${m.name}`, { type: "settings" });
    auditLog.record(req.orgId, req, "team.add", "team_member", m.id, { name: m.name, role: crmRole, authUserId });
    res.status(201).json({ ...m, userId: authUserId, role: crmRole, credsSent: false });
  } catch (err) {
    log.error("POST /api/settings/team failed:", err.message);
    if (isDuplicateKeyError(err)) {
      return res.status(409).json({ error: "A team member with this email already exists." });
    }
    const status = err?.code === "ER_DUP_ENTRY" || err?.code === "23505" ? 409 : 500;
    res.status(status).json({ error: safeErrorMessage(err) });
  }
});

router.patch("/team/:id/flags", requireAuth, requireRole(["Organization Admin"]), async (req, res) => {
  try {
    const { featureFlags } = req.body;
    if (!Array.isArray(featureFlags)) return res.status(400).json({ error: "featureFlags must be an array" });
    const sanitizedFeatureFlags = await require("../platform/featureFlags").sanitizeFeatureKeys(featureFlags);
    const updated = await db.patch("team", req.orgId, req.params.id, { featureFlags: sanitizedFeatureFlags });
    if (!updated) return res.status(404).json({ error: "Team member not found" });
    auditLog.record(req.orgId, req, "team.flags_update", "team_member", req.params.id, { featureFlags: sanitizedFeatureFlags });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.patch("/team/:id", requireAuth, requireRole(["Organization Admin"]), async (req, res) => {
  try {
    const patch = { ...(req.body || {}) };
    if (isAuthPrivilegedRole(patch.role)) {
      return res.status(400).json({ error: "Organization admins cannot assign platform or organization-admin roles." });
    }
    if (patch.userId) delete patch.userId;

    const existing = await db.getTeamMemberById(req.orgId, req.params.id);
    if (!existing) return res.status(404).json({ error: "Team member not found" });

    const updated = await db.patch("team", req.orgId, req.params.id, patch);
    auditLog.record(req.orgId, req, "team.update", "team_member", req.params.id, patch);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.delete("/team/:id", requireAuth, requireRole(["Organization Admin"]), async (req, res) => {
  try {
    await db.remove("team", req.orgId, req.params.id);
    auditLog.record(req.orgId, req, "team.remove", "team_member", req.params.id, {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/team/sync", requireAuth, requireRole(["Organization Admin"]), async (req, res) => {
  try { res.json(await db.replaceTeamMembers(req.orgId, req.body)); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// ── Organization settings ──
router.get("/org", requireAuth, async (req, res) => {
  try { res.json(await db.getOrg(req.orgId) || {}); }
  catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.get("/org/profile-config", requireAuth, async (req, res) => {
  try {
    const org = await db.getOrg(req.orgId);
    res.json(industryPacks.getCompanyProfileConfig(org && org.industry));
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

// The universal contact -> campaign -> lead -> opportunity -> client
// pipeline every industry uses, worded to match this org's own industry —
// see industryPacks.js's getPipelineStageLabels.
router.get("/pipeline-stages", requireAuth, async (req, res) => {
  try {
    const org = await db.getOrg(req.orgId);
    res.json({ stages: industryPacks.getPipelineStageLabels(org && org.industry) });
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

router.post("/org", requireAuth, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    const before = await db.getOrg(req.orgId);
    const updated = await db.updateOrg(req.orgId, req.body);
    const personaInputsChanged = ["industry", "name", "companyBio"].some(k => req.body[k] !== undefined && req.body[k] !== before?.[k]);
    if (personaInputsChanged) {
      await updateConfigForOrg(req.orgId, buildIndustryPersona(updated)).catch((err) =>
        log.error("❌ Failed to auto-regenerate persona after profile update:", err.message)
      );
    }
    global.broadcastLog(`⚙️ Updated organization settings: ${updated.name}`, { type: "settings" });
    auditLog.record(req.orgId, req, "org_settings.update", "organization", req.orgId, req.body);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: safeErrorMessage(err) }); }
});

module.exports = router;
