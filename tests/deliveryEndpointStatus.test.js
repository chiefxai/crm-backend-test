jest.mock("../src/middleware/auth", () => ({
  requireAuth: (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
  requireSseTicket: (_req, _res, next) => next(),
  createSseTicket: () => "ticket",
  createWebSocketTicket: () => "ticket",
  resolveAuthorization: jest.fn(),
}));
jest.mock("../src/db/repository", () => ({ list: jest.fn(async () => [{ id: "customer-1", name: "Asha", phone: "+911234567890", khata: 10 }]), pool: {} }));
jest.mock("../src/crm/khataPayments", () => ({ createKhataPaymentService: () => ({ apply: jest.fn() }) }));
jest.mock("../src/crm/billingEngine", () => ({}));
jest.mock("../src/platform/auditLog", () => ({}));
jest.mock("../src/db/store", () => ({ readAll: () => [] }));

const adminRouter = require("../src/routes/admin");
const catalogRouter = require("../src/routes/catalog");

function routeHandler(router, path) {
  return router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe("unconfigured delivery endpoints", () => {
  test("broadcast reports not configured and does not claim a send", () => {
    const res = responseRecorder();
    routeHandler(adminRouter, "/broadcast")({ body: { audiencePhones: ["+911234567890"], templateName: "reminder" } }, res);
    expect(res.statusCode).toBe(501);
    expect(res.body).toMatchObject({ deliveryStatus: "not_configured", sent: 0 });
  });

  test("khata reminder reports not configured and does not claim a send", async () => {
    const res = responseRecorder();
    await routeHandler(catalogRouter, "/khata/:customerId/reminder")({
      params: { customerId: "customer-1" }, orgId: "org-1",
    }, res);
    expect(res.statusCode).toBe(501);
    expect(res.body).toMatchObject({ deliveryStatus: "not_configured", sent: false });
  });
});
