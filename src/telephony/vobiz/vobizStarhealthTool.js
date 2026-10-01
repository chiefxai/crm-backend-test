// Star Health quote tool declaration for Gemini Live (Vobiz calls).
const GET_STARHEALTH_QUOTE_TOOL = {
  name: "get_starhealth_quote",
  description: "Fetch a live Star Health insurance quote once you have collected ALL of the caller's quote details (pincode, product preference, family composition and ages, pre-existing disease). Call this only once, after every required answer has been given — calling it early with missing info will fail.",
  parameters: {
    type: "OBJECT",
    properties: {
      pincode: { type: "STRING", description: "Caller's 6-digit pincode" },
      category: { type: "STRING", description: "Product category: 'Health' or 'Speciality'. Default 'Health'." },
      product: { type: "STRING", description: "Star Health product name if the caller expressed a preference (e.g. 'Super Star', 'Women's Care'), otherwise omit to let Star Health recommend one." },
      policyPlan: { type: "STRING", description: "'Fresh' (new policy) or 'Portability' (switching from another insurer). Default 'Fresh'." },
      policyType: { type: "STRING", description: "'Floater' (shared cover) or 'Individual'. Default 'Floater'." },
      members: {
        type: "ARRAY",
        description: "One entry per family member to be covered.",
        items: {
          type: "OBJECT",
          properties: {
            type: { type: "STRING", description: "'Parent', 'Adult', or 'Child'" },
            index: { type: "NUMBER", description: "1-based position among members of this type (Parent 1, Parent 2, Adult 1, ...)" },
            age: { type: "STRING", description: "The member's age, exactly as the caller stated it" },
          },
          required: ["type", "index", "age"],
        },
      },
      ped: { type: "STRING", description: "Whether the caller or any family member has a Pre-Existing Disease: 'Yes' or 'No'." },
    },
    required: ["pincode", "members", "ped"],
  },
};

module.exports = { GET_STARHEALTH_QUOTE_TOOL };
