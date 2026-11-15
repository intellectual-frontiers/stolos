// An example risk register (spec 080): the lab's risks, in TypeScript. Likelihood and impact use NIST
// SP 800-30 Rev 1's scale; treatment is accept, mitigate, transfer, or avoid. Change it through a
// pull request (deno task stolos risks review <id>); a fleet signer approves with a signed merge.

import { defineRisks } from "@stolos/archon/risk/mod.ts";

export const risks = defineRisks([
  {
    id: "laptop-theft",
    title: "A laptop with customer data is stolen",
    description:
      "Laptops travel; a stolen one with an unencrypted disk would expose what is on it.",
    likelihood: "moderate",
    impact: "high",
    owner: "alice@example.org",
    treatment: "mitigate",
    scf: ["CRY-07", "AST-04"],
    nextReview: "2027-11-01",
  },
  {
    id: "dns-provider-outage",
    title: "The DNS provider is unavailable",
    description: "Every service is reached by name; an outage at the provider takes them offline.",
    likelihood: "low",
    impact: "moderate",
    owner: "alice@example.org",
    treatment: "accept",
    scf: ["TPM-09"],
    nextReview: "2027-11-01",
    reviewEveryDays: 180,
  },
]);
