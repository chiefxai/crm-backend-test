jest.mock("../src/channels/whatsapp", () => ({ parseInboundWebhook: jest.fn(() => [{ messageId: "wamid-1" }]), handleIncomingMessage: jest.fn() }));
jest.mock("../src/channels/instagram", () => ({ parseInboundWebhook: jest.fn(() => [{ messageId: "ig-mid-1" }]), handleIncomingMessage: jest.fn() }));

const whatsapp = require("../src/channels/whatsapp");
const instagram = require("../src/channels/instagram");
const router = require("../src/routes/webhooks");

function handler(path) {
  return router.stack.find(layer => layer.route?.path === path && layer.route.methods.post).route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
    sendStatus(code) { this.statusCode = code; this.headersSent = true; return this; },
  };
}

describe("Meta webhook retry behavior", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns a retryable failure when WhatsApp persistence fails", async () => {
    whatsapp.handleIncomingMessage.mockRejectedValueOnce(new Error("database unavailable"));
    const res = response();
    await handler("/whatsapp")({ body: {} }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "Webhook processing failed; please retry." });
  });

  test("waits for Instagram message processing before acknowledging", async () => {
    let finish;
    instagram.handleIncomingMessage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const res = response();
    const pending = handler("/instagram")({ body: {} }, res);
    await Promise.resolve();
    expect(res.statusCode).toBeNull();
    finish();
    await pending;
    expect(res.statusCode).toBe(200);
  });
});
