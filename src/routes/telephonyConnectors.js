"use strict";

const express = require("express");
const { requireAuth, requirePermission } = require("../middleware/auth");
const accounts = require("../telephony/connectorAccountService");
const inventory = require("../telephony/connectorInventory");
const auditLog = require("../platform/auditLog");

function enabled(req, res, next) {
  if (process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED !== "true") {
    return res.status(404).json({ error: "Telephony connector accounts are not enabled" });
  }
  return next();
}

function callRoutingEnabled(req, res, next) {
  if (process.env.TELEPHONY_CONNECTOR_ACCOUNTS_ENABLED !== "true"
    || process.env.TELEPHONY_CONNECTOR_CALL_ROUTING_ENABLED !== "true") {
    return res.status(404).json({ error: "Telephony connector call routing is not enabled" });
  }
  return next();
}

function ownerForOrg(req) { return { ownerType: "organization", ownerOrgId: req.orgId }; }

function handleError(err, res) {
  const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
  if (status >= 500) return res.status(500).json({ error: "Unable to process telephony connector account request" });
  return res.status(status).json({ error: err.message });
}

function recordAudit(ownerOrgId, req, action, targetId, providerKey) {
  void auditLog.record(ownerOrgId, { userId: req.userId, userEmail: req.userEmail }, action,
    "telephony_connector_account", targetId, { providerKey });
}

function recordInventoryAudit(ownerOrgId, req, action, targetId, safeIds) {
  void auditLog.record(ownerOrgId, { userId: req.userId, userEmail: req.userEmail }, action,
    "telephony_phone_number", targetId, safeIds);
}

function platformInventoryActor() { return { type: "platform", orgId: null }; }
function orgInventoryActor(req) { return { type: "organization", orgId: req.orgId }; }

function inventoryDto(row) {
  return {
    id: row.id,
    connectorAccountId: row.connector_account_id,
    providerKey: row.provider_key,
    providerNumberId: row.provider_number_id || null,
    phoneNumberE164: row.phone_number_e164,
    displayName: row.display_name || null,
    inventoryStatus: row.inventory_status,
    provisioningStatus: row.provisioning_status,
    connectorDisplayName: row.connector_display_name,
    ownerType: row.owner_type,
    ownerOrgId: row.owner_org_id || null,
    assignedOrgId: row.assigned_org_id || null,
    assignedWorkspaceId: row.assigned_workspace_id || null,
    assignedAt: row.assigned_at || null,
  };
}

function inventoryOptions(body) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return {
    phoneNumberE164: input.phoneNumberE164,
    providerNumberId: input.providerNumberId,
    displayName: input.displayName,
  };
}

function assignInventoryNumber({ actor, req, res, orgId, workspaceId, numberId, ownerOrgId }) {
  return inventory.assignNumber({ actor, phoneNumberId: numberId, orgId, workspaceId, assignedBy: req.userId })
    .then((assignment) => {
      recordInventoryAudit(ownerOrgId, req, "telephony.number.assign", assignment.id, {
        phoneNumberId: assignment.phoneNumberId,
        orgId: assignment.orgId,
        workspaceId: assignment.workspaceId,
      });
      return res.status(201).json({ assignment });
    }).catch((err) => handleError(err, res));
}

function releaseInventoryNumber({ actor, req, res, orgId, numberId, ownerOrgId, reason }) {
  return inventory.releaseNumber({ actor, phoneNumberId: numberId, orgId, releasedBy: req.userId, reason })
    .then((assignment) => {
      recordInventoryAudit(ownerOrgId, req, "telephony.number.release", assignment.id, {
        phoneNumberId: assignment.phoneNumberId,
        orgId: assignment.orgId,
      });
      return res.json({ assignment });
    }).catch((err) => handleError(err, res));
}

function createOrgRouter() {
  const router = express.Router();
  router.get("/assigned-numbers", callRoutingEnabled, requireAuth, requirePermission("workspace.call"), async (req, res) => {
    try {
      const numbers = await inventory.listAssignedNumbers({ orgId: req.orgId, workspaceId: req.workspaceId });
      return res.json({ numbers: numbers.map(row => ({
        id: row.id, providerKey: row.provider_key, phoneNumberE164: row.phone_number_e164,
        displayName: row.display_name || null, connectorDisplayName: row.connector_display_name,
        ownerType: row.owner_type, assignmentId: row.assignment_id,
      })) });
    } catch (err) { return handleError(err, res); }
  });
  router.use(enabled, requireAuth, requirePermission("organization.manage"));

  router.get("/providers", (_req, res) => res.json({ providers: accounts.listSupportedProviders() }));
  router.get("/connectors", async (req, res) => {
    try { return res.json({ connectors: await accounts.listAccounts(ownerForOrg(req)) }); }
    catch (err) { return handleError(err, res); }
  });
  router.post("/connectors", async (req, res) => {
    try {
      const connector = await accounts.createAccount(ownerForOrg(req), req.body || {}, req.userId);
      recordAudit(req.orgId, req, "telephony.connector.create", connector.id, connector.providerKey);
      return res.status(201).json({ connector });
    } catch (err) { return handleError(err, res); }
  });
  router.patch("/connectors/:id", async (req, res) => {
    try {
      const connector = await accounts.updateAccount(req.params.id, ownerForOrg(req), req.body || {}, req.userId);
      recordAudit(req.orgId, req, "telephony.connector.update", connector.id, connector.providerKey);
      return res.json({ connector });
    } catch (err) { return handleError(err, res); }
  });
  router.post("/connectors/:id/disable", async (req, res) => {
    try {
      const connector = await accounts.updateAccount(req.params.id, ownerForOrg(req), { status: "disabled" }, req.userId);
      recordAudit(req.orgId, req, "telephony.connector.disable", connector.id, connector.providerKey);
      return res.json({ connector });
    } catch (err) { return handleError(err, res); }
  });
  router.get("/connectors/:id/numbers", async (req, res) => {
    try {
      const numbers = await inventory.listInventory({ actor: orgInventoryActor(req), connectorAccountId: req.params.id });
      return res.json({ numbers: numbers.map(inventoryDto) });
    } catch (err) { return handleError(err, res); }
  });
  router.post("/connectors/:id/numbers", async (req, res) => {
    try {
      const number = await inventory.registerExistingNumber({
        actor: orgInventoryActor(req), connectorAccountId: req.params.id, ...inventoryOptions(req.body),
      });
      recordInventoryAudit(req.orgId, req, "telephony.number.register", number.id, { connectorAccountId: req.params.id });
      return res.status(201).json({ number });
    } catch (err) { return handleError(err, res); }
  });
  router.post("/numbers/:numberId/mark-ready", async (req, res) => {
    try {
      const number = await inventory.markNumberReady({ actor: orgInventoryActor(req), phoneNumberId: req.params.numberId });
      recordInventoryAudit(req.orgId, req, "telephony.number.mark_ready", number.id, { provisioningStatus: number.provisioningStatus });
      return res.json({ number });
    } catch (err) { return handleError(err, res); }
  });
  router.post("/numbers/:numberId/assign", (req, res) => assignInventoryNumber({
    actor: orgInventoryActor(req), req, res,
    orgId: req.orgId,
    workspaceId: req.body?.workspaceId || req.workspaceId,
    numberId: req.params.numberId,
    ownerOrgId: req.orgId,
  }));
  router.post("/numbers/:numberId/release", (req, res) => releaseInventoryNumber({
    actor: orgInventoryActor(req), req, res,
    orgId: req.orgId,
    numberId: req.params.numberId,
    ownerOrgId: req.orgId,
    reason: req.body?.reason,
  }));
  return router;
}

function createPlatformRouter() {
  const router = express.Router();
  // The parent /api/platform router already applies identity authentication
  // and the platform-admin allowlist middleware.
  router.use(enabled);
  const owner = { ownerType: "platform", ownerOrgId: null };
  router.get("/providers", (_req, res) => res.json({ providers: accounts.listSupportedProviders() }));
  router.get("/connectors", async (_req, res) => {
    try { return res.json({ connectors: await accounts.listAccounts(owner) }); }
    catch (err) { return handleError(err, res); }
  });
  router.post("/connectors", async (req, res) => {
    try {
      const connector = await accounts.createAccount(owner, req.body || {}, req.userId);
      recordAudit(null, req, "telephony.connector.create", connector.id, connector.providerKey);
      return res.status(201).json({ connector });
    } catch (err) { return handleError(err, res); }
  });
  router.patch("/connectors/:id", async (req, res) => {
    try {
      const connector = await accounts.updateAccount(req.params.id, owner, req.body || {}, req.userId);
      recordAudit(null, req, "telephony.connector.update", connector.id, connector.providerKey);
      return res.json({ connector });
    } catch (err) { return handleError(err, res); }
  });
  router.post("/connectors/:id/disable", async (req, res) => {
    try {
      const connector = await accounts.updateAccount(req.params.id, owner, { status: "disabled" }, req.userId);
      recordAudit(null, req, "telephony.connector.disable", connector.id, connector.providerKey);
      return res.json({ connector });
    } catch (err) { return handleError(err, res); }
  });
  router.get("/connectors/:id/numbers", async (req, res) => {
    try {
      const numbers = await inventory.listInventory({ actor: platformInventoryActor(), connectorAccountId: req.params.id });
      return res.json({ numbers: numbers.map(inventoryDto) });
    } catch (err) { return handleError(err, res); }
  });
  router.post("/connectors/:id/numbers", async (req, res) => {
    try {
      const number = await inventory.registerExistingNumber({
        actor: platformInventoryActor(), connectorAccountId: req.params.id, ...inventoryOptions(req.body),
      });
      recordInventoryAudit(null, req, "telephony.number.register", number.id, { connectorAccountId: req.params.id });
      return res.status(201).json({ number });
    } catch (err) { return handleError(err, res); }
  });
  router.post("/numbers/:numberId/mark-ready", async (req, res) => {
    try {
      const number = await inventory.markNumberReady({ actor: platformInventoryActor(), phoneNumberId: req.params.numberId });
      recordInventoryAudit(null, req, "telephony.number.mark_ready", number.id, { provisioningStatus: number.provisioningStatus });
      return res.json({ number });
    } catch (err) { return handleError(err, res); }
  });
  router.post("/numbers/:numberId/assign", (req, res) => assignInventoryNumber({
    actor: platformInventoryActor(), req, res,
    orgId: req.body?.orgId,
    workspaceId: req.body?.workspaceId,
    numberId: req.params.numberId,
    ownerOrgId: null,
  }));
  router.post("/numbers/:numberId/release", (req, res) => releaseInventoryNumber({
    actor: platformInventoryActor(), req, res,
    orgId: req.body?.orgId,
    numberId: req.params.numberId,
    ownerOrgId: null,
    reason: req.body?.reason,
  }));
  return router;
}

module.exports = { createOrgRouter, createPlatformRouter };
