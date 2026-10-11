jest.mock("../src/middleware/auth", () => ({
  requireAuthOrInternal: (req, res, next) => { req.orgId = "org-test"; next(); },
}));
jest.mock("../src/ai/googleAiClient", () => ({ isVertex: true, getClientForOrg: jest.fn() }));

const aiRouter = require("../src/routes/ai");
const googleAiClient = require("../src/ai/googleAiClient");

function routeHandler(path) {
  const route = aiRouter.stack.find(layer => Array.isArray(layer.route?.path)
    ? layer.route.path.includes(path)
    : layer.route?.path === path)?.route;
  if (!route) throw new Error(`Route not found: ${path}`);
  return route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe("AI route validation and fail-closed document analysis", () => {
  test("rejects missing document text and malformed metadata", async () => {
    const handler = routeHandler("/gemini/verify-doc");
    for (const body of [{}, { docType: "Paystub", docName: "pay.pdf", fileContent: " " },
      { docType: "Paystub", docName: "pay.pdf", fileContent: {} }]) {
      const res = response();
      await handler({ body }, res);
      expect(res.statusCode).toBe(422);
    }
  });

  test("uses supplied document text for extraction and never labels model output verified", async () => {
    const generateContent = jest.fn(async ({ contents }) => {
      expect(contents).toContain("REAL PAYSTUB TEXT");
      return { text: JSON.stringify({ extractedName: "A Person", confidenceScore: 90, issues: [] }) };
    });
    googleAiClient.getClientForOrg.mockReturnValue({ models: { generateContent } });
    const res = response();
    await routeHandler("/gemini/verify-doc")({ body: { docType: "Paystub", docName: "pay.pdf", fileContent: "REAL PAYSTUB TEXT" } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("Needs Review");
    expect(res.body.status).not.toBe("Verified");
  });

  test("does not synthesize a score or positive eligibility when lead scoring fails", async () => {
    googleAiClient.getClientForOrg.mockReturnValue({ models: { generateContent: jest.fn().mockRejectedValue(new Error("provider down")) } });
    const res = response();
    await routeHandler("/gemini/score-lead")({ body: { lead: { name: "A Person" } } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.score).toBeUndefined();
    expect(res.body.decision).toBeUndefined();
  });

  test("rejects malformed lead scoring and call simulation payloads", async () => {
    const scoreRes = response();
    await routeHandler("/gemini/score-lead")({ body: { lead: [] } }, scoreRes);
    expect(scoreRes.statusCode).toBe(400);
    const callRes = response();
    await routeHandler("/simulate-call")({ body: { customerUtterance: "yes" } }, callRes);
    expect(callRes.statusCode).toBe(400);
  });
});
