// Canonical industry configuration exposed to the frontend.
//
// The generic object engine remains the persistence/runtime layer; this module
// only describes which industry was selected and which seeded domain objects
// and pipelines belong to it. Feature flags and user permissions stay separate.
const industryPacks = require("../seed/industryPacks");

const CORE_DOMAIN_OBJECTS = [
  { key: "contact", label: "Contact", pluralLabel: "Contacts", searchable: true, auditable: true, primary: true, fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Phone", type: "phone" },
    { key: "email", label: "Email", type: "email" },
  ] },
  { key: "campaign", label: "Campaign", pluralLabel: "Campaigns", auditable: true, fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "status", label: "Status", type: "select" },
  ] },
  { key: "call", label: "Call", pluralLabel: "Calls", auditable: true, fields: [
    { key: "direction", label: "Direction", type: "select", options: ["inbound", "outbound"] },
    { key: "duration", label: "Duration", type: "number" },
  ] },
];
const CORE_DOMAIN_RELATIONSHIPS = [
  { from: "campaign", to: "contact", type: "many_to_many", label: "targets" },
  { from: "call", to: "contact", type: "many_to_one", label: "contact" },
];
function normalizeField(field) {
  const type = field.type === "textarea" ? "text" : field.type;
  const allowed = new Set(["text", "number", "boolean", "date", "datetime", "currency", "phone", "email", "select", "relation"]);
  return { key: field.key, label: field.label, type: allowed.has(type) ? type : "text", ...(field.required ? { required: true } : {}), ...(Array.isArray(field.options) ? { options: field.options } : {}), ...(field.relationObjectKey ? { relationObjectKey: field.relationObjectKey } : {}) };
}
function buildDomainModel(packObjects) {
  const industryObjects = packObjects.map((object, index) => ({
    key: object.key,
    label: object.label.replace(/s$/, ""),
    pluralLabel: object.label,
    position: index,
    description: object.description || undefined,
    icon: object.icon || undefined,
    fields: (object.fields || []).map(normalizeField),
    searchable: true,
    auditable: true,
  }));
  const packRelationships = packObjects.flatMap((object) =>
    (object.fields || [])
      .filter((field) => field.type === "relation" && field.relationObjectKey)
      .map((field) => ({
        from: object.key,
        to: field.relationObjectKey,
        type: "many_to_one",
        label: field.key,
      }))
  );
  return {
    objects: [
      ...CORE_DOMAIN_OBJECTS,
      ...industryObjects.filter((object) => !CORE_DOMAIN_OBJECTS.some((core) => core.key === object.key)),
    ],
    relationships: [...CORE_DOMAIN_RELATIONSHIPS, ...packRelationships],
  };
}

const INDUSTRY_CONFIG = industryPacks.INDUSTRY_CONFIG || {};
function pair([singular, plural]) { return { singular, plural }; }
function normalizeLabels(raw = {}) {
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, pair(value)]));
}

function getIndustryDefinition(industryKey) {
  const key = industryKey || "lending";
  const known = INDUSTRY_CONFIG[key] ? key : "lending";
  const pack = industryPacks.getPack(known) || [];
  const labels = normalizeLabels(INDUSTRY_CONFIG[known]?.labels);
  const domainModel = buildDomainModel(pack);
  const domainObjects = domainModel.objects;

  // Non-lending industries define their real pipeline on the primary
  // pipeline-enabled domain object. Lending keeps its legacy universal
  // lifecycle until its migration to generic objects is complete.
  const pipelineSource = known === "lending"
    ? industryPacks.getPipelineStageLabels(known)
    : (pack.find((object) => object.hasPipeline && Array.isArray(object.stages))?.stages || [])
      .map((stage) => ({ key: stage.key, label: stage.label }));
  const pipelineStages = pipelineSource.map((stage, index, stages) => ({
    ...stage,
    order: (index + 1) * 10,
    terminal: stage.key === "client" || stage.key === "converted" || stage.key === "sold" || stage.key === "enrolled" || stage.key === "discharged" || stage.key === "policy_issued" || stage.key === "settled" || stage.key === "completed" || stage.key === "delivered" || stage.key === "won" ? "won" : stage.key === "lost" || stage.key === "rejected" || stage.key === "returned" || stage.key === "cancelled" ? "lost" : undefined,
  }));

  return {
    schemaVersion: 1,
    key: known,
    tagline: INDUSTRY_CONFIG[known]?.tagline || "AI-powered customer conversations and workflow automation.",
    businessTypes: INDUSTRY_CONFIG[known]?.businessTypes || {},
    label: INDUSTRY_CONFIG[known]?.label || known,
    labels: normalizeLabels(INDUSTRY_CONFIG[known]?.labels),
    domainObjects,
    domainModel,
    pipeline: {
      key: known,
      label: labels.pipeline.plural,
      stages: pipelineStages,
    },
    modules: (known === "lending"
      ? [["loan_lifecycle", "Loan Lifecycle", "/loans", "loans", "layers"]]
      : known === "automotive"
      ? [
          ["automotive_records", "Vehicle Operations", "/objects", "objects", "layers", "objects"],
        ]
      : domainObjects.map((object) => [object.key, object.pluralLabel, `/${object.key}`])
    ).map(([key, label, route, tabId, iconKey, featureFlag]) => ({ key, label, route, ...(tabId ? { tabId } : {}), ...(iconKey ? { iconKey } : {}), ...(featureFlag ? { featureFlag } : {}), domainSpecific: true })),
  };
}

module.exports = { getIndustryDefinition };
