const crypto = require("crypto");
const { verifyVobizWebhookSignature, vobizWebhookBaseUrl } = require("../../src/telephony/vobiz/vobizSignature");

describe("vobizSignature", () => {
  test("verifies X-Vobiz-Signature-V3", () => {
    const baseUrl = "https://api.example.com/api/vobiz/incoming";
    const authToken = "test-auth-token";
    const nonce = "random-nonce-123";
    const signature = crypto.createHmac("sha256", authToken).update(`${baseUrl}.${nonce}`).digest("base64");

    const req = {
      baseUrl: "/api/vobiz",
      path: "/incoming",
      protocol: "https",
      headers: {},
      get(header) {
        const map = {
          host: "api.example.com",
          "X-Vobiz-Signature-V3": signature,
          "X-Vobiz-Signature-V3-Nonce": nonce,
        };
        return map[header];
      },
    };
    expect(vobizWebhookBaseUrl(req)).toBe(baseUrl);
    expect(verifyVobizWebhookSignature(req, authToken)).toBe(true);
    expect(verifyVobizWebhookSignature(req, "wrong-token")).toBe(false);
  });
});
