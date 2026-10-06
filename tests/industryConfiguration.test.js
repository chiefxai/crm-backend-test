const { getIndustryDefinition } = require("../src/platform/industry");

describe("industry configuration", () => {
  test("returns a normalized automotive definition", () => {
    const config = getIndustryDefinition("automotive");
    expect(config.key).toBe("automotive");
    expect(config.labels.contact.plural).toBe("Customers");
    expect(config.domainObjects.some((object) => object.key === "test_drive")).toBe(true);
    expect(config.pipeline.some((stage) => stage.key === "client")).toBe(true);
  });

  test("falls back safely for unknown industries", () => {
    const config = getIndustryDefinition("does_not_exist");
    expect(config.key).toBe("lending");
    expect(config.labels.lead.plural).toBe("Leads");
  });
});
