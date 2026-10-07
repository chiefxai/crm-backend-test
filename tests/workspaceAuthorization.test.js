jest.mock('../src/db/repositories/workspaceRepository', () => ({ getDefault: jest.fn(async orgId => ({ id: orgId, orgId, isDefault: true })) }));
jest.mock("../src/db/repository", () => ({
  findMembershipForUser: jest.fn(), getOrg: jest.fn(), listMembershipsForUser: jest.fn(),
}));
jest.mock("../src/auth", () => ({ verifyToken: jest.fn() }));
jest.mock("../src/platform/admin", () => ({ listOrganizations: jest.fn() }));
jest.mock("../src/seed/industryPacks", () => ({ listIndustries: () => [] }));
jest.mock("../src/observability/logger", () => ({ getLogger: () => ({ info() {}, error() {} }) }));

const express = require("express");
const request = require("supertest");
const db = require("../src/db/repository");
const provider = require("../src/auth");
const platform = require("../src/platform/admin");
const { requireAuth, requireAuthIdentityOnly, requirePlatformAdmin } = require("../src/middleware/auth");

const app = express();
app.use("/api/auth", require("../src/routes/auth"));
app.get("/api/resource", requireAuth, (req, res) => res.json({ orgId: req.orgId, role: req.userRole }));
app.get("/api/operator", requireAuthIdentityOnly, requirePlatformAdmin, (_req, res) => res.sendStatus(204));

describe("workspace and platform authorization", () => {
  const previousEnvironment = process.env.NODE_ENV;
  const previousAllowlist = process.env.PLATFORM_ADMIN_EMAILS;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "production";
    delete process.env.PLATFORM_ADMIN_EMAILS;
    provider.verifyToken.mockResolvedValue({ sub: "user-a", email: "member@example.com" });
    db.findMembershipForUser.mockImplementation(async (_id, _email, selected) =>
      selected && selected !== "org-a" ? null : { orgId: "org-a", role: "Agent" });
    db.getOrg.mockImplementation(async (id) => ({ id, name: id, status: "Active" }));
    db.listMembershipsForUser.mockResolvedValue([{ orgId: "org-a", role: "Agent" }]);
    platform.listOrganizations.mockResolvedValue([{ id: "org-b", name: "Private customer" }]);
  });
  afterAll(() => {
    process.env.NODE_ENV = previousEnvironment;
    if (previousAllowlist === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = previousAllowlist;
  });

  test("ordinary authenticated users receive only their own memberships", async () => {
    const res = await request(app).get("/api/auth/workspaces").set("Authorization", "Bearer valid").expect(200);
    expect(res.body).toEqual([{ orgId: "org-a", role: "Agent", workspaceId: "org-a", workspace: { id: "org-a", orgId: "org-a", isDefault: true } }]);
    expect(platform.listOrganizations).not.toHaveBeenCalled();
  });
  test("ordinary users cannot select another organization", async () => {
    await request(app).get("/api/resource").set("Authorization", "Bearer valid").set("X-Organization-Id", "org-b").expect(403);
    expect(db.getOrg).not.toHaveBeenCalled();
  });
  test("own organization remains accessible", async () => {
    const res = await request(app).get("/api/resource").set("Authorization", "Bearer valid").set("X-Organization-Id", "org-a").expect(200);
    expect(res.body).toEqual({ orgId: "org-a", role: "Agent" });
  });
  test.each([
    { platformAdmin: true },
    { admin: true },
    { realm_access: { roles: ["platform-admin"] } },
  ])("verified platform claim %j permits explicit customer access", async (claims) => {
    provider.verifyToken.mockResolvedValue({ sub: "operator", email: "operator@example.com", ...claims });
    const res = await request(app).get("/api/resource").set("Authorization", "Bearer valid").set("X-Organization-Id", "org-b").expect(200);
    expect(res.body).toEqual({ orgId: "org-b", role: "Super Admin" });
    await request(app).get("/api/operator").set("Authorization", "Bearer valid").expect(204);
  });
  test("configured operator email is recognized consistently", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = " MEMBER@EXAMPLE.COM ";
    const res = await request(app).get("/api/auth/workspaces").set("Authorization", "Bearer valid").expect(200);
    expect(res.body[0].orgId).toBe("org-b");
    await request(app).get("/api/operator").set("Authorization", "Bearer valid").expect(204);
  });
  test("ordinary users and string-valued administrator claims cannot access operator routes", async () => {
    provider.verifyToken.mockResolvedValue({ sub: "user-a", platformAdmin: "true", admin: "false" });
    await request(app).get("/api/operator").set("Authorization", "Bearer valid").expect(403);
  });
  test("suspension applies even when the selected customer is accessed by an operator", async () => {
    provider.verifyToken.mockResolvedValue({ sub: "operator", platformAdmin: true });
    db.getOrg.mockResolvedValue({ id: "org-b", status: "Suspended" });
    await request(app).get("/api/resource").set("Authorization", "Bearer valid").set("X-Organization-Id", "org-b").expect(403);
  });
  test("missing and invalid credentials never list customer workspaces", async () => {
    await request(app).get("/api/auth/workspaces").expect(401);
    provider.verifyToken.mockRejectedValue(new Error("bad signature"));
    await request(app).get("/api/auth/workspaces").set("Authorization", "Bearer invalid").expect(401);
    expect(platform.listOrganizations).not.toHaveBeenCalled();
    expect(db.listMembershipsForUser).not.toHaveBeenCalled();
  });
});
