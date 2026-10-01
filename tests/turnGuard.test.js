const {
  createToolCallDeduper,
  createGenerationGate,
} = require("../src/telephony/conversation/turnGuard");

describe("provider-agnostic realtime turn guards", () => {
  test("dedupes the same logical tool call even when provider assigns a new id", () => {
    const guard = createToolCallDeduper({ ttlMs: 1000 });

    expect(guard.claim({ id: "a", name: "save_question_response", args: { question: "What is your name?", answer: "Sanjay" } })).toBe(true);
    expect(guard.claim({ id: "b", name: "save_question_response", args: { answer: "Sanjay", question: "What is your name?" } })).toBe(false);
  });

  test("allows a different logical tool call", () => {
    const guard = createToolCallDeduper({ ttlMs: 1000 });

    expect(guard.claim({ id: "a", name: "search_knowledge_base", args: { query: "policy" } })).toBe(true);
    expect(guard.claim({ id: "b", name: "search_knowledge_base", args: { query: "claim" } })).toBe(true);
  });

  test("invalidates stale audio generations", () => {
    const gate = createGenerationGate();
    const first = gate.begin("first-turn");
    const second = gate.begin("caller-barged-in");

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });
});
