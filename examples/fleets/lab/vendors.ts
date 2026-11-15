// An example vendor triage file (spec 080): each vendor's criticality (FIPS 199) and the data it
// holds (OCSF data categories). Vendors are discovered from SSO applications, DNS, and connected
// accounts; deno task stolos vendors triage --write adds new ones here, in a pull request.

import { defineVendors } from "@stolos/archon/risk/mod.ts";

export const vendors = defineVendors([
  {
    id: "cloudflare",
    name: "Cloudflare",
    criticality: "high",
    data: ["Business"],
    owner: "alice@example.org",
  },
  {
    id: "mailhost",
    name: "Mailhost",
    criticality: "moderate",
    data: ["Personal", "Business"],
    domains: ["mailhost.example"],
    notes: "The lab's mail provider (an example).",
  },
]);
