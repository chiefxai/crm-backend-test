const {
  buildVobizIncomingWebhookUrl,
  extractSuppliedVobizWebhookSecret,
} = require("../../src/telephony/vobizWebhookAuth");

describe("vobizWebhookAuth", () => {
  const prevSecret = process.env.VOBIZ_WEBHOOK_SECRET;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.VOBIZ_WEBHOOK_SECRET;
    else process.env.VOBIZ_WEBHOOK_SECRET = prevSecret;
  });

  test("buildVobizIncomingWebhookUrl appends webhook_secret when configured", () => {
    process.env.VOBIZ_WEBHOOK_SECRET = "test-secret-abc";
    const url = buildVobizIncomingWebhookUrl("https://api.example.com/");
    expect(url).toBe("https://api.example.com/api/vobiz/incoming?webhook_secret=test-secret-abc");
  });

  test("buildVobizIncomingWebhookUrl omits query when secret unset", () => {
    delete process.env.VOBIZ_WEBHOOK_SECRET;
    const url = buildVobizIncomingWebhookUrl("https://api.example.com");
    expect(url).toBe("https://api.example.com/api/vobiz/incoming");
  });

  test("extractSuppliedVobizWebhookSecret reads query and body", () => {
    expect(
      extractSuppliedVobizWebhookSecret({ get: () => null, query: { webhook_secret: "q" }, body: {} })
    ).toBe("q");
    expect(
      extractSuppliedVobizWebhookSecret({
        get: (h) => (h === "X-Vobiz-Webhook-Secret" ? "hdr" : null),
        query: {},
        body: {},
      })
    ).toBe("hdr");
    expect(
      extractSuppliedVobizWebhookSecret({ get: () => null, query: {}, body: { webhookSecret: "body" } })
    ).toBe("body");
  });
});
