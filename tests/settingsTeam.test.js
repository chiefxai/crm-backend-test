describe("settings team member creation", () => {
  test("allows CRM job titles and blocks privileged auth roles", () => {
    const fs = require("fs");
    const source = fs.readFileSync(require.resolve("../src/routes/settings.js"), "utf8");
    expect(source).toContain("AUTH_PRIVILEGED_ROLES");
    expect(source).toContain("isAuthPrivilegedRole");
    expect(source).not.toContain('role !== "Team Member"');
    expect(source).toContain("cognitoTeamMemberGroup()");
  });
});
