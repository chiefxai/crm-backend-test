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
const INDUSTRY_DOMAIN_EXTRAS = {
  automotive: {
    objects: [
      { key: "vehicle", label: "Vehicle", pluralLabel: "Vehicles", searchable: true, auditable: true, fields: [
        { key: "vin", label: "VIN", type: "text" }, { key: "make", label: "Make", type: "text" },
        { key: "model", label: "Model", type: "text" }, { key: "year", label: "Year", type: "number" },
        { key: "price", label: "Price", type: "currency" }, { key: "status", label: "Status", type: "select", options: ["available", "reserved", "sold"] },
      ] },
      { key: "vehicle_quotation", label: "Quotation", pluralLabel: "Quotations", auditable: true, fields: [
        { key: "vehicleId", label: "Vehicle", type: "relation", relationObjectKey: "vehicle" },
        { key: "amount", label: "Amount", type: "currency" },
      ] },
      { key: "vehicle_booking", label: "Booking", pluralLabel: "Bookings", auditable: true, fields: [
        { key: "vehicleId", label: "Vehicle", type: "relation", relationObjectKey: "vehicle" },
        { key: "contactId", label: "Customer", type: "relation", relationObjectKey: "contact" },
      ] },
      { key: "vehicle_sale", label: "Vehicle Sale", pluralLabel: "Vehicle Sales", auditable: true, fields: [
        { key: "vehicleId", label: "Vehicle", type: "relation", relationObjectKey: "vehicle" },
        { key: "contactId", label: "Customer", type: "relation", relationObjectKey: "contact" },
        { key: "amount", label: "Sale Amount", type: "currency" },
      ] },
    ],
    relationships: [
      { from: "test_drive", to: "vehicle", type: "many_to_one" },
      { from: "test_drive", to: "contact", type: "many_to_one" },
      { from: "vehicle_quotation", to: "vehicle", type: "many_to_one" },
      { from: "vehicle_booking", to: "vehicle", type: "many_to_one" },
      { from: "vehicle_booking", to: "contact", type: "many_to_one" },
      { from: "vehicle_sale", to: "vehicle", type: "many_to_one" },
      { from: "vehicle_sale", to: "contact", type: "many_to_one" },
    ],
  },
};

function buildDomainModel(packObjects, industryKey) {
  const industryObjects = packObjects.map((object, index) => ({
    key: object.key, label: object.label.replace(/s$/, ""), pluralLabel: object.label, position: index,
    description: object.description || undefined, icon: object.icon || undefined,
    fields: (object.fields || []).map(normalizeField), searchable: true, auditable: true,
  }));
  return {
    objects: [...CORE_DOMAIN_OBJECTS, ...industryObjects.filter((object) => !CORE_DOMAIN_OBJECTS.some((core) => core.key === object.key))],
    relationships: [...CORE_DOMAIN_RELATIONSHIPS],
  };
}

const BUSINESS_TYPES = {
  lending: { personal_lending: { label: "Personal Lending" } },
  automotive: { vehicle_dealership: { label: "Vehicle Dealership" }, used_vehicle_dealership: { label: "Used Vehicle Dealership" }, service_center: { label: "Service Center" } },
  real_estate: { real_estate_agency: { label: "Real Estate Agency" } },
  healthcare: { clinic: { label: "Clinic" } },
  insurance: { insurance_agency: { label: "Insurance Agency" } },
};
const TAGLINES = {
  lending: "AI-powered lending conversations and loan lifecycle automation.",
  automotive: "AI-powered vehicle enquiries, test drives, quotations, and sales.",
  real_estate: "AI-powered property enquiries, visits, and deal management.",
  healthcare: "AI-powered patient communication and appointment workflows.",
  insurance: "AI-powered insurance enquiries, follow-ups, and policy workflows.",
};

const LABELS = {
  lending: { workspace: ["Workspace", "Workspace"], lead: ["Lead", "Leads"], contact: ["Contact", "Contacts"], campaign: ["Campaign", "Campaigns"], pipeline: ["Pipeline", "Pipeline"], appointment: ["Appointment", "Appointments"], agent: ["Loan Agent", "Loan Agents"], enquiry: ["Enquiry", "Enquiries"], deal: ["Loan", "Loans"] },
  automotive: { workspace: ["Dealership", "Dealership"], lead: ["Vehicle Enquiry", "Vehicle Enquiries"], contact: ["Customer", "Customers"], campaign: ["Sales Campaign", "Sales Campaigns"], pipeline: ["Sales Pipeline", "Sales Pipeline"], appointment: ["Test Drive", "Test Drives"], agent: ["Sales Executive", "Sales Executives"], enquiry: ["Vehicle Enquiry", "Vehicle Enquiries"], deal: ["Vehicle Sale", "Vehicle Sales"] },
  real_estate: { workspace: ["Agency", "Agency"], lead: ["Property Lead", "Property Leads"], contact: ["Contact", "Contacts"], campaign: ["Campaign", "Campaigns"], pipeline: ["Sales Pipeline", "Sales Pipeline"], appointment: ["Site Visit", "Site Visits"], agent: ["Agent", "Agents"], enquiry: ["Property Enquiry", "Property Enquiries"], deal: ["Property Deal", "Property Deals"] },
  healthcare: { workspace: ["Clinic", "Clinics"], lead: ["Patient Enquiry", "Patient Enquiries"], contact: ["Patient", "Patients"], campaign: ["Outreach Campaign", "Outreach Campaigns"], pipeline: ["Care Pipeline", "Care Pipeline"], appointment: ["Appointment", "Appointments"], agent: ["Care Representative", "Care Representatives"], enquiry: ["Patient Enquiry", "Patient Enquiries"], deal: ["Care Case", "Care Cases"] },
  insurance: { workspace: ["Agency", "Agency"], lead: ["Policyholder Lead", "Policyholder Leads"], contact: ["Policyholder", "Policyholders"], campaign: ["Campaign", "Campaigns"], pipeline: ["Policy Pipeline", "Policy Pipeline"], appointment: ["Appointment", "Appointments"], agent: ["Insurance Agent", "Insurance Agents"], enquiry: ["Coverage Enquiry", "Coverage Enquiries"], deal: ["Policy", "Policies"] },
};

function pair([singular, plural]) { return { singular, plural }; }

function getIndustryDefinition(industryKey) {
  const key = industryKey || "lending";
  const known = LABELS[key] ? key : "lending";
  const pack = industryPacks.getPack(known) || [];
  const labels = Object.fromEntries(Object.entries(LABELS[known]).map(([name, value]) => [name, pair(value)]));
  const domainModel = buildDomainModel(pack, known);
  const domainObjects = domainModel.objects;

  return {
    key: known,
    tagline: TAGLINES[known] || "AI-powered customer conversations and workflow automation.",
    businessTypes: BUSINESS_TYPES[known] || {},
    label: industryPacks.listIndustries().find((item) => item.key === known)?.label || known,
    labels,
    domainObjects,
    domainModel,
    pipeline: {
      key: known,
      label: labels.pipeline.plural,
      stages: industryPacks.getPipelineStageLabels(known).map((stage, index, stages) => ({
        ...stage,
        order: (index + 1) * 10,
        terminal: stage.key === "client" || stage.key === "converted" || stage.key === "sold" || stage.key === "enrolled" || stage.key === "discharged" || stage.key === "policy_issued" || stage.key === "settled" || stage.key === "completed" || stage.key === "delivered" || stage.key === "won" ? "won" : stage.key === "lost" || stage.key === "rejected" || stage.key === "returned" || stage.key === "cancelled" ? "lost" : undefined,
      })),
    },
    modules: (known === "lending"
      ? [["loan_lifecycle", "Loan Lifecycle", "/loans", "loans", "layers"]]
      : known === "automotive"
      ? [
          ["vehicle_inventory", "Vehicle Inventory", "/vehicles"],
          ["test_drives", "Test Drives", "/test-drives"],
          ["quotations", "Quotations", "/quotations"],
          ["bookings", "Bookings", "/bookings"],
          ["vehicle_sales", "Vehicle Sales", "/vehicle-sales"],
        ]
      : domainObjects.map((object) => [object.key, object.pluralLabel, `/${object.key}`])
    ).map(([key, label, route, tabId, iconKey]) => ({ key, label, route, ...(tabId ? { tabId } : {}), ...(iconKey ? { iconKey } : {}), domainSpecific: true })),
  };
}

module.exports = { getIndustryDefinition };
