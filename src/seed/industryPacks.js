// ============================================================
// services/industryPacks.js
//
// Each pack is a list of object specs (matching objectsEngine.
// createObject's input shape) that get seeded into a fresh org when
// they pick that industry at signup. "lending" isn't a pack here —
// it keeps using the existing hardcoded Lead/Loan/Campaign system
// (services/db.js), which already works well for that vertical.
// These packs are what make every OTHER industry possible without
// writing new tables/routes/UI per vertical.
// ============================================================

const PACKS = {
  real_estate: [
    {
      key: "property_lead",
      label: "Property Leads",
      icon: "Building2",
      description: "Buyer/renter enquiries through to booking",
      hasPipeline: true,
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "email", label: "Email", type: "email" },
        { key: "budget", label: "Budget", type: "currency" },
        { key: "propertyType", label: "Property Type", type: "select", options: ["Apartment", "Villa", "Plot", "Commercial"] },
        { key: "preferredLocation", label: "Preferred Location", type: "text" },
        { key: "notes", label: "Notes", type: "textarea" }
      ],
      stages: [
        { key: "enquiry", label: "Enquiry", color: "#6366f1" },
        { key: "site_visit_scheduled", label: "Site Visit Scheduled", color: "#0ea5e9" },
        { key: "site_visit_done", label: "Site Visit Done", color: "#14b8a6" },
        { key: "negotiation", label: "Negotiation", color: "#f59e0b" },
        { key: "booked", label: "Booked", color: "#22c55e" },
        { key: "lost", label: "Lost", color: "#ef4444" }
      ]
    }
  ],

  healthcare: [
    {
      key: "patient",
      label: "Patients",
      icon: "HeartPulse",
      description: "Appointment booking through to follow-up",
      hasPipeline: true,
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "dob", label: "Date of Birth", type: "date" },
        { key: "condition", label: "Condition / Reason for Visit", type: "textarea" },
        { key: "assignedDoctor", label: "Assigned Doctor", type: "text" },
        { key: "insuranceProvider", label: "Insurance Provider", type: "text" }
      ],
      stages: [
        { key: "enquiry", label: "Enquiry", color: "#6366f1" },
        { key: "appointment_booked", label: "Appointment Booked", color: "#0ea5e9" },
        { key: "consulted", label: "Consulted", color: "#14b8a6" },
        { key: "follow_up", label: "Follow-up", color: "#f59e0b" },
        { key: "discharged", label: "Discharged", color: "#22c55e" }
      ]
    }
  ],

  education: [
    {
      key: "admission",
      label: "Admissions",
      icon: "GraduationCap",
      description: "Enquiry through to enrollment",
      hasPipeline: true,
      fields: [
        { key: "studentName", label: "Student Name", type: "text", required: true },
        { key: "parentPhone", label: "Parent Phone", type: "phone", required: true },
        { key: "email", label: "Email", type: "email" },
        { key: "gradeApplied", label: "Grade / Program Applied", type: "text" },
        { key: "previousSchool", label: "Previous School", type: "text" },
        { key: "notes", label: "Notes", type: "textarea" }
      ],
      stages: [
        { key: "enquiry", label: "Enquiry", color: "#6366f1" },
        { key: "counselling_scheduled", label: "Counselling Scheduled", color: "#0ea5e9" },
        { key: "counselling_done", label: "Counselling Done", color: "#14b8a6" },
        { key: "fee_pending", label: "Fee Pending", color: "#f59e0b" },
        { key: "enrolled", label: "Enrolled", color: "#22c55e" },
        { key: "rejected", label: "Rejected", color: "#ef4444" }
      ]
    }
  ],

  ecommerce: [
    {
      key: "order_lead",
      label: "Orders",
      icon: "ShoppingBag",
      description: "D2C orders from enquiry through to delivery",
      hasPipeline: true,
      fields: [
        { key: "customerName", label: "Customer Name", type: "text", required: true },
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "product", label: "Product", type: "text" },
        { key: "orderValue", label: "Order Value", type: "currency" },
        { key: "channel", label: "Channel", type: "select", options: ["Instagram", "WhatsApp", "Website", "Call"] }
      ],
      stages: [
        { key: "new", label: "New", color: "#6366f1" },
        { key: "confirmed", label: "Confirmed", color: "#0ea5e9" },
        { key: "packed", label: "Packed", color: "#14b8a6" },
        { key: "shipped", label: "Shipped", color: "#f59e0b" },
        { key: "delivered", label: "Delivered", color: "#22c55e" },
        { key: "returned", label: "Returned", color: "#ef4444" }
      ]
    }
  ],

  automotive: [
    {
      key: "test_drive",
      label: "Test Drives",
      icon: "Car",
      description: "Vehicle enquiries through to sale",
      hasPipeline: true,
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "model", label: "Model Interested", type: "text" },
        { key: "preferredDate", label: "Preferred Date", type: "date" },
        { key: "notes", label: "Notes", type: "textarea" }
      ],
      stages: [
        { key: "enquiry", label: "Enquiry", color: "#6366f1" },
        { key: "test_drive_scheduled", label: "Test Drive Scheduled", color: "#0ea5e9" },
        { key: "test_drive_done", label: "Test Drive Done", color: "#14b8a6" },
        { key: "negotiation", label: "Negotiation", color: "#f59e0b" },
        { key: "sold", label: "Sold", color: "#22c55e" },
        { key: "lost", label: "Lost", color: "#ef4444" }
      ]
    },
    {
      key: "vehicle", label: "Vehicles", icon: "Car", description: "Vehicle inventory available for sale", fields: [
        { key: "vin", label: "VIN", type: "text" }, { key: "make", label: "Make", type: "text" }, { key: "model", label: "Model", type: "text" },
        { key: "year", label: "Year", type: "number" }, { key: "price", label: "Price", type: "currency" },
        { key: "status", label: "Status", type: "select", options: ["available", "reserved", "sold"] }
      ]
    },
    { key: "vehicle_quotation", label: "Quotations", icon: "FileText", description: "Vehicle quotations", fields: [
      { key: "vehicleId", label: "Vehicle", type: "relation", relationObjectKey: "vehicle" }, { key: "amount", label: "Amount", type: "currency" }
    ] },
    { key: "vehicle_booking", label: "Bookings", icon: "CalendarCheck", description: "Vehicle bookings", fields: [
      { key: "vehicleId", label: "Vehicle", type: "relation", relationObjectKey: "vehicle" }, { key: "contactId", label: "Customer", type: "relation", relationObjectKey: "contact" }
    ] },
    { key: "vehicle_sale", label: "Vehicle Sales", icon: "BadgeDollarSign", description: "Completed vehicle sales", fields: [
      { key: "vehicleId", label: "Vehicle", type: "relation", relationObjectKey: "vehicle" }, { key: "contactId", label: "Customer", type: "relation", relationObjectKey: "contact" }, { key: "amount", label: "Sale Amount", type: "currency" }
      ] },
    ],
  it_sales: [
    {
      key: "it_lead",
      label: "IT Sales Leads",
      icon: "Laptop",
      description: "Product/demo enquiries through to closed deal",
      hasPipeline: true,
      fields: [
        { key: "contactName", label: "Contact Person", type: "text", required: true },
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "email", label: "Email", type: "email" },
        { key: "companyName", label: "Company Name", type: "text" },
        { key: "companySize", label: "Company Size", type: "select", options: ["1-10", "11-50", "51-200", "201-1000", "1000+"] },
        { key: "productInterest", label: "Product / Service Interested In", type: "text" },
        { key: "budget", label: "Budget Range", type: "currency" },
        { key: "currentSolution", label: "Current Solution", type: "text" },
        { key: "requirement", label: "Use Case / Requirement", type: "textarea" }
      ],
      stages: [
        { key: "enquiry", label: "Enquiry", color: "#6366f1" },
        { key: "demo_scheduled", label: "Demo Scheduled", color: "#0ea5e9" },
        { key: "demo_done", label: "Demo Done", color: "#14b8a6" },
        { key: "proposal_sent", label: "Proposal Sent", color: "#f59e0b" },
        { key: "won", label: "Won", color: "#22c55e" },
        { key: "lost", label: "Lost", color: "#ef4444" }
      ]
    }
  ],

  insurance: [
    {
      key: "policy_lead",
      label: "Policyholder Leads",
      icon: "Shield",
      description: "Coverage enquiries through to policy issuance",
      hasPipeline: true,
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "email", label: "Email", type: "email" },
        { key: "coverageType", label: "Coverage Type", type: "select", options: ["Health", "Life", "Motor", "Property", "Travel"] },
        { key: "premiumBudget", label: "Premium Budget", type: "currency" },
        { key: "existingProvider", label: "Existing Policy Provider", type: "text" },
        { key: "notes", label: "Notes", type: "textarea" }
      ],
      stages: [
        { key: "enquiry", label: "Enquiry", color: "#6366f1" },
        { key: "quote_sent", label: "Quote Sent", color: "#0ea5e9" },
        { key: "documents_pending", label: "Documents Pending", color: "#f59e0b" },
        { key: "policy_issued", label: "Policy Issued", color: "#22c55e" },
        { key: "lost", label: "Lost", color: "#ef4444" }
      ]
    },
    {
      key: "insurance_claim",
      label: "Claims",
      icon: "FileCheck2",
      description: "Filed claims through to settlement",
      hasPipeline: true,
      fields: [
        { key: "policyholderLeadId", label: "Linked Policyholder", type: "text" },
        { key: "policyNumber", label: "Policy Number", type: "text", required: true },
        { key: "claimAmount", label: "Claim Amount", type: "currency" },
        { key: "incidentDate", label: "Incident Date", type: "date" },
        { key: "description", label: "Description", type: "textarea" }
      ],
      stages: [
        { key: "filed", label: "Filed", color: "#6366f1" },
        { key: "under_review", label: "Under Review", color: "#0ea5e9" },
        { key: "additional_info_needed", label: "Additional Info Needed", color: "#f59e0b" },
        { key: "settled", label: "Settled", color: "#22c55e" },
        { key: "rejected", label: "Rejected", color: "#ef4444" }
      ]
    }
  ],

  field_services: [
    {
      key: "job",
      label: "Service Jobs",
      icon: "Wrench",
      description: "Booking through to completion",
      hasPipeline: true,
      fields: [
        { key: "customerName", label: "Customer Name", type: "text", required: true },
        { key: "phone", label: "Phone", type: "phone", required: true },
        { key: "address", label: "Address", type: "textarea" },
        { key: "serviceType", label: "Service Type", type: "text" },
        { key: "scheduledDate", label: "Scheduled Date", type: "date" }
      ],
      stages: [
        { key: "booked", label: "Booked", color: "#6366f1" },
        { key: "assigned", label: "Assigned", color: "#0ea5e9" },
        { key: "in_progress", label: "In Progress", color: "#f59e0b" },
        { key: "completed", label: "Completed", color: "#22c55e" },
        { key: "cancelled", label: "Cancelled", color: "#ef4444" }
      ]
    }
  ]
};

// ------------------------------------------------------------
// Phase 4 draft: lending as a generic-objects pack (see
// PHASE4_MIGRATION_PLAN.md). Deliberately NOT added to PACKS/getPack()
// yet — signup (authRoutes.js) calls getPack(industry) unconditionally
// and would seed these objects for every new lending org the moment
// this key exists there. Keeping it as a separate export means it can
// be created/tested against an isolated org without touching real
// signup behavior, per the migration plan's step-by-step confirmation
// gates. `loanRecordLeadRef` on the loan object stores the linked
// lead's object_records.id as a plain text field — object_records has
// no native FK column, so this is the provisional cross-reference
// approach flagged as an open question in the plan.
// ------------------------------------------------------------
const INDUSTRY_CONFIG = {
  lending: { label: "Lending / Loans", tagline: "AI-powered lending conversations and loan lifecycle automation.", businessTypes: { personal_lending: { label: "Personal Lending" } }, labels: { workspace:["Workspace","Workspace"], lead:["Lead","Leads"], contact:["Contact","Contacts"], campaign:["Campaign","Campaigns"], pipeline:["Pipeline","Pipeline"], appointment:["Appointment","Appointments"], agent:["Loan Agent","Loan Agents"], enquiry:["Enquiry","Enquiries"], deal:["Loan","Loans"] } },
  automotive: { label: "Automotive", tagline: "AI-powered vehicle enquiries, test drives, quotations, and sales.", businessTypes: { vehicle_dealership:{label:"Vehicle Dealership"}, used_vehicle_dealership:{label:"Used Vehicle Dealership"}, service_center:{label:"Service Center"} }, labels: { workspace:["Dealership","Dealership"], lead:["Vehicle Enquiry","Vehicle Enquiries"], contact:["Customer","Customers"], campaign:["Sales Campaign","Sales Campaigns"], pipeline:["Sales Pipeline","Sales Pipeline"], appointment:["Test Drive","Test Drives"], agent:["Sales Executive","Sales Executives"], enquiry:["Vehicle Enquiry","Vehicle Enquiries"], deal:["Vehicle Sale","Vehicle Sales"] } },
  real_estate: { label:"Real Estate", tagline:"AI-powered property enquiries, visits, and deal management.", businessTypes:{real_estate_agency:{label:"Real Estate Agency"}}, labels:{workspace:["Agency","Agency"],lead:["Property Lead","Property Leads"],contact:["Contact","Contacts"],campaign:["Campaign","Campaigns"],pipeline:["Sales Pipeline","Sales Pipeline"],appointment:["Site Visit","Site Visits"],agent:["Agent","Agents"],enquiry:["Property Enquiry","Property Enquiries"],deal:["Property Deal","Property Deals"]} },
  healthcare: { label:"Healthcare", tagline:"AI-powered patient communication and appointment workflows.", businessTypes:{clinic:{label:"Clinic"}}, labels:{workspace:["Clinic","Clinics"],lead:["Patient Enquiry","Patient Enquiries"],contact:["Patient","Patients"],campaign:["Outreach Campaign","Outreach Campaigns"],pipeline:["Care Pipeline","Care Pipeline"],appointment:["Appointment","Appointments"],agent:["Care Representative","Care Representatives"],enquiry:["Patient Enquiry","Patient Enquiries"],deal:["Care Case","Care Cases"]} },
  insurance: { label:"Insurance", tagline:"AI-powered insurance enquiries, follow-ups, and policy workflows.", businessTypes:{insurance_agency:{label:"Insurance Agency"}}, labels:{workspace:["Agency","Agency"],lead:["Policyholder Lead","Policyholder Leads"],contact:["Policyholder","Policyholders"],campaign:["Campaign","Campaigns"],pipeline:["Policy Pipeline","Policy Pipeline"],appointment:["Appointment","Appointments"],agent:["Insurance Agent","Insurance Agents"],enquiry:["Coverage Enquiry","Coverage Enquiries"],deal:["Policy","Policies"]} },
  education: { label:"Education", tagline:"AI-powered admissions, counselling, and enrollment workflows.", businessTypes:{educational_institution:{label:"Educational Institution"}}, labels:{workspace:["Institution","Institutions"],lead:["Admission Enquiry","Admission Enquiries"],contact:["Student","Students"],campaign:["Outreach Campaign","Outreach Campaigns"],pipeline:["Admissions Pipeline","Admissions Pipeline"],appointment:["Counselling","Counselling"],agent:["Admissions Counselor","Admissions Counselors"],enquiry:["Admission Enquiry","Admission Enquiries"],deal:["Enrollment","Enrollments"]} },
  ecommerce: { label:"E-commerce / D2C", tagline:"AI-powered customer conversations from enquiry through delivery.", businessTypes:{online_store:{label:"Online Store"}}, labels:{workspace:["Store","Stores"],lead:["Order Lead","Order Leads"],contact:["Customer","Customers"],campaign:["Campaign","Campaigns"],pipeline:["Order Pipeline","Order Pipeline"],appointment:["Appointment","Appointments"],agent:["Sales Agent","Sales Agents"],enquiry:["Product Enquiry","Product Enquiries"],deal:["Order","Orders"]} },
  field_services: { label:"Field Services", tagline:"AI-powered service enquiries, scheduling, and job management.", businessTypes:{service_business:{label:"Service Business"}}, labels:{workspace:["Service Business","Service Businesses"],lead:["Service Lead","Service Leads"],contact:["Customer","Customers"],campaign:["Service Campaign","Service Campaigns"],pipeline:["Service Pipeline","Service Pipeline"],appointment:["Service Appointment","Service Appointments"],agent:["Field Agent","Field Agents"],enquiry:["Service Enquiry","Service Enquiries"],deal:["Job","Jobs"]} },
  it_sales: { label:"IT / SaaS Sales", tagline:"AI-powered B2B sales conversations and deal workflows.", businessTypes:{software_company:{label:"Software Company"}}, labels:{workspace:["Company","Companies"],lead:["Sales Lead","Sales Leads"],contact:["Contact","Contacts"],campaign:["Sales Campaign","Sales Campaigns"],pipeline:["Sales Pipeline","Sales Pipeline"],appointment:["Demo","Demos"],agent:["Sales Executive","Sales Executives"],enquiry:["Product Enquiry","Product Enquiries"],deal:["Deal","Deals"]} },
};

const LENDING_PACK = [
  {
    key: "lending_lead",
    label: "Leads",
    icon: "Users",
    description: "Loan enquiries through to disbursal or loss",
    hasPipeline: true,
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "phone", label: "Phone", type: "phone", required: true },
      { key: "email", label: "Email", type: "email" },
      { key: "amountRequested", label: "Amount Requested", type: "currency" },
      { key: "score", label: "Score", type: "text" },
      { key: "source", label: "Source", type: "text" },
      { key: "notes", label: "Notes", type: "textarea" }
    ],
    stages: [
      { key: "new", label: "New", color: "#6366f1" },
      { key: "contacted", label: "Contacted", color: "#0ea5e9" },
      { key: "qualified", label: "Qualified", color: "#14b8a6" },
      { key: "converted", label: "Converted", color: "#22c55e" },
      { key: "lost", label: "Lost", color: "#ef4444" }
    ]
  },
  {
    key: "lending_loan",
    label: "Loans",
    icon: "Landmark",
    description: "Disbursed loans through repayment",
    hasPipeline: true,
    fields: [
      { key: "leadRecordId", label: "Linked Lead", type: "text" },
      { key: "amount", label: "Amount", type: "currency", required: true },
      { key: "interestRate", label: "Interest Rate", type: "text" },
      { key: "termMonths", label: "Term (Months)", type: "text" },
      { key: "monthlyEmi", label: "Monthly EMI", type: "currency" },
      { key: "nextPaymentDate", label: "Next Payment Date", type: "date" }
    ],
    stages: [
      { key: "active", label: "Active", color: "#0ea5e9" },
      { key: "delinquent", label: "Delinquent", color: "#f59e0b" },
      { key: "closed", label: "Closed", color: "#22c55e" },
      { key: "defaulted", label: "Defaulted", color: "#ef4444" }
    ]
  }
];

function getPack(industryKey) {
  return PACKS[industryKey] || null;
}

function listIndustries() {
  return [
    { key: "lending", label: "Lending / Loans" }, // built-in, not a generic pack
    { key: "real_estate", label: "Real Estate" },
    { key: "healthcare", label: "Healthcare" },
    { key: "insurance", label: "Insurance" },
    { key: "education", label: "Education" },
    { key: "ecommerce", label: "E-commerce / D2C" },
    { key: "automotive", label: "Automotive" },
    { key: "field_services", label: "Field Services" },
    { key: "it_sales", label: "IT / SaaS Sales" }
  ];
}

// Default AI-call qualification questions per industry, seeded into
// `questionnaires` at signup (see authRoutes.js) instead of the lending
// defaults in db.js's DEFAULT_QUESTIONS. Matches each pack's own fields —
// e.g. real estate asks about budget/property type, not insurance premiums.
const DEFAULT_QUESTIONS = {
  real_estate: [
    "Unga full name enna, sollunga?",
    "Neenga property vaanga paakringala illa rent-ku paakringala?",
    "Unga approximate budget enna?",
    "Edhachum specific location prefer pandringala?"
  ],
  healthcare: [
    "Patient-oda full name enna?",
    "Enna reason-ku appointment book pandrom?",
    "Edhachum existing doctor illa insurance provider iruka?",
    "Unga preferred appointment date and time enna?"
  ],
  insurance: [
    "Unga full name enna, sollunga?",
    "Ugaluku enna maadhiri insurance coverage venum — health, life, motor illa property?",
    "Unga budget illa premium target enna?",
    "Ugaluku edhavadhu existing policy illa provider iruka?"
  ],
  education: [
    "Student-oda full name enna?",
    "Endha grade or program-ku apply pandrom?",
    "Munnadi eppadi school-la iruntheenga?",
    "Parent-oda contact number confirm pannunga."
  ],
  ecommerce: [
    "Unga full name enna, sollunga?",
    "Eppadi order pannurathukku plan pandringa — Instagram, WhatsApp illa website?",
    "Endha product-ku interested-a irukeenga?",
    "Delivery address confirm pannunga."
  ],
  automotive: [
    "Unga full name enna, sollunga?",
    "Endha model-la interest iruku?",
    "Test drive-ku eppo convenient-a irukum?",
    "Purchase pannurathukku edhachum financing venuma?"
  ],
  field_services: [
    "Unga full name enna, sollunga?",
    "Enna maadhiri service venum?",
    "Unga address confirm pannunga.",
    "Eppo service venum — urgent-a illa schedule pannalama?"
  ],
  it_sales: [
    "Unga full name and company name enna, sollunga?",
    "Endha product illa service-la interested-a irukeenga?",
    "Unga company size epdi irukum — approximate team size sollunga?",
    "Demo-ku eppo convenient-a irukum?"
  ]
};

function getDefaultQuestions(industryKey) {
  return DEFAULT_QUESTIONS[industryKey] || null;
}

// ------------------------------------------------------------
// Company Profile screen config, per industry. Replaces what used to
// be a single hardcoded-to-lending field set (EIN/NMLS/APR/"Loan
// Financing Sectors") shown to every org regardless of vertical. Each
// industry gets its own license/tax field labels and its own tags-list
// fields (sectors-equivalent, jurisdictions-equivalent) with their own
// storage keys in org.settings — so a real-estate org's "Property Types
// Handled" and a lending org's "Primary Loan Financing Sectors" are
// stored under different keys and never collide.
// `rate`/`risk` are lending-only (APR + underwriting risk appetite);
// every other industry omits them entirely rather than showing
// meaningless loan fields.
// ------------------------------------------------------------
const COMPANY_PROFILE_CONFIG = {
  lending: {
    taxIdLabel: "EIN / Tax Identification Number",
    taxIdPlaceholder: "XX-XXXXXXX",
    license: { key: "nmlsId", label: "NMLS License Identifier", placeholder: "NMLS-XXXXXX" },
    rate: { key: "defaultInterestRate", label: "Default Loan Portfolio APR (%)" },
    risk: { key: "riskProfile" },
    bioPlaceholder: "Describe your lending company's market niche and credit guidelines...",
    sectors: {
      key: "primaryLendingSectors", label: "Primary Loan Financing Sectors",
      hint: "Manage which product classes your organization is authorized to underwrite.",
      placeholder: "e.g. Small Business Loans",
      default: ["Personal Loans", "Mortgages", "Auto Refinancing"]
    },
    jurisdictions: {
      key: "regulatoryJurisdictions", label: "Licensed Operational Jurisdictions",
      hint: "Lending operates only within states that match your active regulatory clearances.",
      placeholder: "e.g. New York, Arizona",
      default: ["California", "Texas", "Florida", "New York"]
    }
  },
  real_estate: {
    taxIdLabel: "GSTIN / Tax ID",
    taxIdPlaceholder: "22AAAAA0000A1Z5",
    license: { key: "realEstateLicenseId", label: "RERA Registration Number", placeholder: "RERA-XXXXXX" },
    rate: null,
    risk: null,
    bioPlaceholder: "Describe your real estate business and specialties...",
    sectors: {
      key: "propertyTypesHandled", label: "Property Types Handled",
      hint: "Manage which property categories your organization deals in.",
      placeholder: "e.g. Commercial",
      default: ["Apartments", "Villas", "Plots"]
    },
    jurisdictions: {
      key: "serviceAreas", label: "Service Areas / Cities",
      hint: "Cities and regions your organization actively operates in.",
      placeholder: "e.g. Chennai",
      default: ["Chennai"]
    }
  },
  healthcare: {
    taxIdLabel: "GSTIN / Tax ID",
    taxIdPlaceholder: "22AAAAA0000A1Z5",
    license: { key: "medicalLicenseId", label: "Medical / Clinic Registration Number", placeholder: "REG-XXXXXX" },
    rate: null,
    risk: null,
    bioPlaceholder: "Describe your clinic/hospital and areas of care...",
    sectors: {
      key: "specialties", label: "Medical Specialties",
      hint: "Manage which specialties your organization offers.",
      placeholder: "e.g. Cardiology",
      default: ["General Medicine"]
    },
    jurisdictions: {
      key: "serviceLocations", label: "Service Locations",
      hint: "Cities and regions your organization actively operates in.",
      placeholder: "e.g. Chennai",
      default: ["Chennai"]
    }
  },
  insurance: {
    taxIdLabel: "GSTIN / Tax ID",
    taxIdPlaceholder: "22AAAAA0000A1Z5",
    license: { key: "irdaiLicenseId", label: "IRDAI Agent/Broker License Number", placeholder: "IRDAI-XXXXXX" },
    rate: null,
    risk: null,
    bioPlaceholder: "Describe your insurance agency and the carriers you represent...",
    sectors: {
      key: "policyTypesOffered", label: "Policy Types Offered",
      hint: "Manage which types of insurance policies your organization sells.",
      placeholder: "e.g. Health, Motor",
      default: ["Health", "Life"]
    },
    jurisdictions: {
      key: "serviceAreas", label: "Service Areas",
      hint: "Cities and regions your organization actively operates in.",
      placeholder: "e.g. Chennai",
      default: ["Chennai"]
    }
  },
  education: {
    taxIdLabel: "GSTIN / Tax ID",
    taxIdPlaceholder: "22AAAAA0000A1Z5",
    license: { key: "affiliationId", label: "Affiliation / Board Registration Number", placeholder: "AFF-XXXXXX" },
    rate: null,
    risk: null,
    bioPlaceholder: "Describe your institution and academic focus...",
    sectors: {
      key: "programsOffered", label: "Programs / Courses Offered",
      hint: "Manage which programs your institution offers.",
      placeholder: "e.g. K-12, Undergraduate",
      default: ["K-12"]
    },
    jurisdictions: {
      key: "campusLocations", label: "Campus Locations",
      hint: "Cities and regions your institution operates in.",
      placeholder: "e.g. Chennai",
      default: ["Chennai"]
    }
  },
  ecommerce: {
    taxIdLabel: "GSTIN / Business Registration Number",
    taxIdPlaceholder: "22AAAAA0000A1Z5",
    license: { key: "gstNumber", label: "GST Registration Number", placeholder: "GST-XXXXXX" },
    rate: null,
    risk: null,
    bioPlaceholder: "Describe your brand and product range...",
    sectors: {
      key: "productCategories", label: "Product Categories",
      hint: "Manage which product categories your store sells.",
      placeholder: "e.g. Apparel",
      default: ["Apparel"]
    },
    jurisdictions: {
      key: "deliveryRegions", label: "Delivery Regions",
      hint: "States/regions your store delivers to.",
      placeholder: "e.g. Tamil Nadu",
      default: ["Tamil Nadu"]
    }
  },
  automotive: {
    taxIdLabel: "GSTIN / Tax ID",
    taxIdPlaceholder: "22AAAAA0000A1Z5",
    license: { key: "dealerLicenseId", label: "Dealer License Number", placeholder: "DL-XXXXXX" },
    rate: null,
    risk: null,
    bioPlaceholder: "Describe your dealership and brands carried...",
    sectors: {
      key: "brandsSold", label: "Brands / Models Sold",
      hint: "Manage which brands or models your dealership sells.",
      placeholder: "e.g. Sedan, SUV",
      default: []
    },
    jurisdictions: {
      key: "showroomLocations", label: "Showroom / Service Locations",
      hint: "Cities where your showrooms/service centers operate.",
      placeholder: "e.g. Chennai",
      default: ["Chennai"]
    }
  },
  field_services: {
    taxIdLabel: "GSTIN / Tax ID",
    taxIdPlaceholder: "22AAAAA0000A1Z5",
    license: { key: "serviceLicenseId", label: "Service License Number", placeholder: "SL-XXXXXX" },
    rate: null,
    risk: null,
    bioPlaceholder: "Describe your services and coverage area...",
    sectors: {
      key: "serviceCategories", label: "Service Categories",
      hint: "Manage which categories of service your organization provides.",
      placeholder: "e.g. Plumbing, Electrical",
      default: []
    },
    jurisdictions: {
      key: "serviceAreas", label: "Service Areas",
      hint: "Cities and regions your organization actively services.",
      placeholder: "e.g. Chennai",
      default: ["Chennai"]
    }
  },
  it_sales: {
    taxIdLabel: "GST / CIN Number",
    taxIdPlaceholder: "22AAAAA0000A1Z5",
    license: { key: "gstNumber", label: "GST / CIN Registration Number", placeholder: "GST-XXXXXX" },
    rate: null,
    risk: null,
    bioPlaceholder: "Describe your product/service and target market...",
    sectors: {
      key: "productsOffered", label: "Products / Services Offered",
      hint: "Manage which products or services your company sells.",
      placeholder: "e.g. CRM Software",
      default: []
    },
    jurisdictions: {
      key: "industriesServed", label: "Industries Served",
      hint: "Which client industries your company primarily sells into.",
      placeholder: "e.g. Real Estate",
      default: []
    }
  }
};

function getCompanyProfileConfig(industryKey) {
  return COMPANY_PROFILE_CONFIG[industryKey] || COMPANY_PROFILE_CONFIG.lending;
}

// ============================================================
// Pipeline stage labels — the single, universal 5-stage progression every
// contact moves through regardless of industry:
//   contact -> campaign -> lead -> opportunity -> client
// (stored as leads.pipeline_stage, these exact keys — see repository.js's
// advancePipelineStage and callFinalizer.js/routes/leads.js, which are
// what actually advance a contact through them). This is deliberately a
// SEPARATE, simpler concept from a PACK's own richer per-object `stages`
// above (property_lead's Enquiry->Site Visit->...->Booked, etc.) — this
// one instead describes how a raw Contact Directory entry matures into a
// paying client via the calling/campaign system itself, the same for
// every industry, just worded differently.
const PIPELINE_STAGE_KEYS = ["contact", "campaign", "lead", "opportunity", "client"];

const PIPELINE_STAGE_LABELS = {
  lending:        { contact: "Contact", campaign: "Campaign", lead: "Lead", opportunity: "Opportunity", client: "Client" },
  real_estate:    { contact: "Contact", campaign: "Campaign", lead: "Lead", opportunity: "Opportunity", client: "Buyer" },
  healthcare:     { contact: "Contact", campaign: "Outreach", lead: "Lead", opportunity: "Consultation", client: "Patient" },
  insurance:      { contact: "Contact", campaign: "Campaign", lead: "Lead", opportunity: "Opportunity", client: "Policyholder" },
  education:      { contact: "Contact", campaign: "Outreach", lead: "Lead", opportunity: "Applicant", client: "Enrolled Student" },
  ecommerce:      { contact: "Contact", campaign: "Campaign", lead: "Lead", opportunity: "Opportunity", client: "Customer" },
  automotive:     { contact: "Contact", campaign: "Campaign", lead: "Lead", opportunity: "Opportunity", client: "Buyer" },
  field_services: { contact: "Contact", campaign: "Campaign", lead: "Lead", opportunity: "Opportunity", client: "Customer" },
  it_sales:       { contact: "Contact", campaign: "Campaign", lead: "Lead", opportunity: "Opportunity", client: "Client" },
};

// Ordered [{key,label}] for the given industry (falls back to lending's
// wording for an industry with no override, or an unrecognized/missing
// industry — same fallback convention getCompanyProfileConfig already uses).
function getPipelineStageLabels(industryKey) {
  const labels = PIPELINE_STAGE_LABELS[industryKey] || PIPELINE_STAGE_LABELS.lending;
  return PIPELINE_STAGE_KEYS.map((key) => ({ key, label: labels[key] }));
}

module.exports = {
  getPack, listIndustries, getDefaultQuestions, getCompanyProfileConfig, LENDING_PACK, INDUSTRY_CONFIG,
  PIPELINE_STAGE_KEYS, getPipelineStageLabels,
};
