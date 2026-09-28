describe("email appUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.APP_URL;
    delete process.env.FRONTEND_URL;
    delete process.env.PUBLIC_APP_URL;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("normalizes host-only APP_URL with https", () => {
    process.env.APP_URL = "crm.elvoryx.in";
    const { getPublicAppUrl } = require("../../src/email/appUrl");
    expect(getPublicAppUrl()).toBe("https://crm.elvoryx.in");
  });

  test("prefers APP_URL over ALLOWED_ORIGINS", () => {
    process.env.APP_URL = "https://crm.elvoryx.in";
    process.env.ALLOWED_ORIGINS = "https://other.example.com";
    const { getPublicAppUrl } = require("../../src/email/appUrl");
    expect(getPublicAppUrl()).toBe("https://crm.elvoryx.in");
  });

  test("falls back to first ALLOWED_ORIGINS when APP_URL unset", () => {
    process.env.ALLOWED_ORIGINS = "https://crm.elvoryx.in,https://api.crm.elvoryx.in";
    const { getPublicAppUrl } = require("../../src/email/appUrl");
    expect(getPublicAppUrl()).toBe("https://crm.elvoryx.in");
  });
});
