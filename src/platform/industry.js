// Canonical industry configuration exposed to the frontend.
//
// The generic object engine remains the persistence/runtime layer; this module
// only describes which industry was selected and which seeded domain objects
// and pipelines belong to it. Feature flags and user permissions stay separate.
const industryPacks = require("../seed/industryPacks");

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
  const domainObjects = pack.map((object, index) => ({
    key: object.key,
    label: object.label.replace(/s$/, ""),
    pluralLabel: object.label,
    position: index,
    description: object.description || null,
    hasPipeline: Boolean(object.hasPipeline),
    fields: object.fields || [],
    stages: object.stages || [],
  }));

  return {
    key: known,
    label: industryPacks.listIndustries().find((item) => item.key === known)?.label || known,
    labels,
    domainObjects,
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
