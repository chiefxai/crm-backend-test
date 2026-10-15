describe("shared application display name", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.APP_NAME;
  });
  afterAll(() => { process.env = originalEnv; });

  test("defaults to Chief Connect in welcome emails and backup notices", () => {
    const templates = require("../../src/email/templates");
    const welcome = templates.welcomeEmail({
      orgName: "Demo", adminEmail: "user@example.com", tempPassword: "temporary", role: "OrganizationAdmin",
    });
    expect(welcome.subject).toContain("Chief Connect");
    expect(welcome.html).toContain("Sign in to Chief Connect");
    expect(templates.backupReadyEmail({ downloadUrl: "https://example.com" }).subject)
      .toBe("Your Chief Connect backup is ready");
  });

  test("reuses APP_NAME across all templates", () => {
    process.env.APP_NAME = "Example Workspace";
    const templates = require("../../src/email/templates");
    expect(templates.welcomeEmail({ orgName: "Demo", adminEmail: "user@example.com", tempPassword: "temp" }).subject)
      .toContain("Example Workspace");
    expect(templates.billingNotificationEmail({ title: "Billing notice", message: "Details" }).html)
      .toContain("Example Workspace");
    expect(templates.backupReadyEmail({ downloadUrl: "https://example.com" }).subject)
      .toContain("Example Workspace");
  });
});
