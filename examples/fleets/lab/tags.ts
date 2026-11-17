/**
 * The example lab's tags (spec 108-tags): the starter kit a new fleet comes with (an environment, a role, a site, an owner, a
 * criticality and a data class), and one dimension of its own (the operating system) that a rule gives. A tag is
 * `<dimension>:<value>`; a one-of dimension holds one value per machine, a many-of one any number. A tag that is not defined
 * here is a type error and a problem of `stolos build`. Give a machine tags with `stolos tag add <machine> env:lab`.
 * Spec 112-machine-reported-tags: `fromMachine` says what to do with the tags machines report in a dimension (accept, hint, ignore).
 *
 * @module
 */

import {
  addressIn,
  defineTags,
  osIs,
  type TagIdOf,
} from "@intellectual-frontiers/stolos/archon/model/tags";

export const tags = defineTags(
  {
    env: {
      label: "Environment",
      description: "Where the machine's work runs.",
      cardinality: "one-of",
      fromMachine: "accept",
      tags: {
        prod: {
          label: "Production",
          colour: "red",
          description: "Real users or the business depend on it.",
        },
        staging: {
          label: "Staging",
          colour: "orange",
          description: "A copy of production to try changes on.",
        },
        lab: {
          label: "Lab",
          colour: "green",
          description: "Safe to break and to rebuild.",
        },
      },
    },
    role: {
      label: "Role",
      description: "What the machine is for.",
      cardinality: "many-of",
      fromMachine: "hint",
      tags: {
        server: {
          label: "Server",
          colour: "blue",
          description: "Serves other machines or people.",
        },
        workstation: {
          label: "Workstation",
          colour: "teal",
          description: "A person works on it.",
        },
        nas: {
          label: "NAS",
          colour: "violet",
          description: "Keeps files for others.",
        },
        database: {
          label: "Database",
          colour: "orange",
          description: "Holds a database.",
        },
        web: {
          label: "Web",
          colour: "blue",
          description: "Serves web pages or an API.",
        },
        network: {
          label: "Network",
          colour: "grey",
          description: "Routes, switches or reaches the network.",
        },
      },
    },
    site: {
      label: "Site",
      description: "Where the machine is.",
      cardinality: "one-of",
      fromMachine: "accept",
      tags: {
        main: {
          label: "Main site",
          colour: "blue",
          description: "The fleet's own premises.",
        },
        remote: {
          label: "Remote",
          colour: "teal",
          description: "Away from the main site (a home, a branch).",
        },
        cloud: {
          label: "Cloud",
          colour: "violet",
          description: "In a cloud account.",
        },
      },
    },
    owner: {
      label: "Owner",
      description: "The team accountable for the machine.",
      cardinality: "one-of",
      fromMachine: "hint",
      tags: {
        it: {
          label: "IT",
          colour: "violet",
          description: "Run by the people who run IT.",
        },
        engineering: {
          label: "Engineering",
          colour: "blue",
          description: "Run by the engineering team.",
        },
        office: {
          label: "Office",
          colour: "pink",
          description: "Belongs to the office and its staff.",
        },
      },
    },
    criticality: {
      label: "Criticality",
      description: "How much the business suffers if it is lost (FIPS 199's impact levels).",
      cardinality: "one-of",
      fromMachine: "ignore",
      tags: {
        low: {
          label: "Low",
          colour: "green",
          description: "Its loss has a limited effect.",
        },
        moderate: {
          label: "Moderate",
          colour: "yellow",
          description: "Its loss has a serious effect.",
        },
        high: {
          label: "High",
          colour: "red",
          description: "Its loss has a severe effect.",
        },
      },
    },
    data: {
      label: "Data class",
      description: "The most sensitive class of data the machine holds.",
      cardinality: "one-of",
      fromMachine: "ignore",
      tags: {
        public: {
          label: "Public",
          colour: "green",
          description: "Anyone may see it.",
        },
        internal: {
          label: "Internal",
          colour: "yellow",
          description: "For the organization only.",
        },
        confidential: {
          label: "Confidential",
          colour: "orange",
          description: "Its disclosure would harm the organization.",
        },
        regulated: {
          label: "Regulated",
          colour: "red",
          description: "A law or contract governs it.",
        },
      },
    },
    os: {
      label: "Operating system",
      description: "The family of the machine's operating system, given by rules.",
      cardinality: "one-of",
      tags: {
        linux: { label: "Linux", colour: "orange", description: "Ubuntu or another Linux." },
        macos: { label: "macOS", colour: "grey", description: "Apple's macOS." },
        windows: { label: "Windows", colour: "blue", description: "Microsoft Windows." },
      },
    },
  },
  {
    // A rule gives a tag from what Stolos knows of a machine, wherever the tags are read.
    rules: [
      {
        id: "windows",
        description: "Machines running Windows.",
        when: osIs("windows"),
        tag: "os:windows",
      },
      { id: "macos", description: "Machines running macOS.", when: osIs("macos"), tag: "os:macos" },
      { id: "linux", description: "Machines running Linux.", when: osIs("linux"), tag: "os:linux" },
      {
        id: "office-lan",
        description: "Anything on the Default network is in the main site's office.",
        when: addressIn("10.0.1.0/24"),
        tag: "owner:office",
      },
    ],
    // A group gives its tags to its members: here, every machine on the Servers network of the site.
    groups: [
      {
        id: "servers-network",
        description: "The site's Servers network.",
        network: "Servers",
        tags: ["site:main", "role:server"],
      },
    ],
    // What a machine's /etc/machine-info means here (spec 112-machine-reported-tags): DEPLOYMENT= becomes an environment, and a
    // place's name a site. What it does not name is read as the plain claim (env:testing, site:<the place>), which the fleet lists but
    // does not hold.
    machineInfoMap: {
      deployment: { production: "env:prod", staging: "env:staging", development: "env:lab" },
      location: { "main office": "site:main" },
    },
  },
);

/** Every tag of this fleet: what a typed file (decisions.ts, machine.ts) may hold. */
export type TagId = TagIdOf<typeof tags.dimensions>;
