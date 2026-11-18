/**
 * Spec 110-network-assets FR-001: what a network device is, whatever its vendor. A device has a **class** (`stolos:DeviceClass`: gateway,
 * switch, access point, camera, recorder, door controller, phone, other) and **facets** (`stolos:DeviceFacet`: routing, switching,
 * wireless, surveillance, access control), both typed from the ontology's code lists, so that a feature asks for a facet and gets the
 * devices of any vendor that have it.
 *
 * UniFi's devices are classified from what the official API gives (10.3.58): the `features` of an adopted device (`gateway`,
 * `switching`, `accessPoint`) first, which is authoritative; and where it gives none, the model code against a typed table of model
 * families. A model that matches nothing is `other`: a class is never guessed.
 *
 * ```mermaid
 * flowchart LR
 *   f["features: gateway, switching, accessPoint"] -->|"any"| c["class: gateway > switch > access-point"]
 *   f -->|"none"| m["model family table<br/>(camera, recorder, door controller, phone)"]
 *   m -->|"no match"| o["other"]
 *   m --> c
 *   c --> facets["facets: those of the class and those of the features"]
 * ```
 *
 * @example
 * ```ts
 * import { classify } from "./network-class.ts";
 * const c = classify({ model: "USW-24", features: ["switching"] });
 * c.class; // "switch"
 * c.facets; // ["switching"]
 * classify({ model: "X-1", features: [] }).class; // "other"
 * ```
 *
 * @module
 */
// Spec: 110-network-assets FR-001

import {
  DEVICE_CLASSES,
  DEVICE_FACETS,
  type DeviceClass,
  type DeviceFacet,
} from "../ontology.auto.ts";

export { DEVICE_CLASSES, DEVICE_FACETS, type DeviceClass, type DeviceFacet };

/** The facets of each class: what a device of that class does before its own features are looked at. */
export const FACETS_OF_CLASS: Readonly<Record<DeviceClass, readonly DeviceFacet[]>> = {
  gateway: ["routing"],
  switch: ["switching"],
  "access-point": ["wireless"],
  camera: ["surveillance"],
  recorder: ["surveillance"],
  "door-controller": ["access-control"],
  phone: [],
  other: [],
};

/**
 * The OCSF 1.9.0 device `type_id` (the object's `type`) each class reports as: Firewall (9), Switch (10), IOT (7) or Other (99). An access
 * point has no OCSF device type of its own and reports as Other.
 */
export const OCSF_DEVICE_TYPE: Readonly<Record<DeviceClass, { id: number; caption: string }>> = {
  gateway: { id: 9, caption: "Firewall" },
  switch: { id: 10, caption: "Switch" },
  "access-point": { id: 99, caption: "Other" },
  camera: { id: 7, caption: "IOT" },
  recorder: { id: 7, caption: "IOT" },
  "door-controller": { id: 7, caption: "IOT" },
  phone: { id: 7, caption: "IOT" },
  other: { id: 99, caption: "Other" },
};

/** The word a person reads for a class. */
export const CLASS_LABEL: Readonly<Record<DeviceClass, string>> = {
  gateway: "Gateway",
  switch: "Switch",
  "access-point": "Access point",
  camera: "Camera",
  recorder: "Recorder",
  "door-controller": "Door controller",
  phone: "Phone",
  other: "Other",
};

/** The plural a person reads (`2 switches`). */
export const CLASS_PLURAL: Readonly<Record<DeviceClass, string>> = {
  gateway: "gateways",
  switch: "switches",
  "access-point": "access points",
  camera: "cameras",
  recorder: "recorders",
  "door-controller": "door controllers",
  phone: "phones",
  other: "other devices",
};

/** What the official UniFi Network API calls a device's features. */
export type UnifiFeature = "gateway" | "switching" | "accessPoint";

/** The facet each feature of the official API stands for. */
export const FACET_OF_FEATURE: Readonly<Record<UnifiFeature, DeviceFacet>> = {
  gateway: "routing",
  switching: "switching",
  accessPoint: "wireless",
};

/**
 * Model families that the Network API does not list (they belong to UniFi's other applications) and that an integration or a later
 * version of the API may: the first pattern that matches a model code decides. A model that matches none is `other`.
 */
export const MODEL_FAMILIES: ReadonlyArray<{ pattern: RegExp; class: DeviceClass }> = [
  { pattern: /^(UNVR|UVC-NVR|NVR)/i, class: "recorder" },
  { pattern: /^(UVC|UVC-|G[345]\s|AI\s?(BULLET|PRO|THEATER))/i, class: "camera" },
  { pattern: /^(UA-|UAH|UA\s?HUB|UACC)/i, class: "door-controller" },
  { pattern: /^(UP-|UT-|UTP)/i, class: "phone" },
];

/** A device as the classifier needs it: its model and its features (the official API's words). */
export interface ClassifyInput {
  /** Its model code. */
  model: string;
  /** Its features, as the API gives them (possibly none). */
  features: readonly string[];
}

/** What the classifier decided, and what it rested on. */
export interface Classification {
  /** Its class. */
  class: DeviceClass;
  /** Its facets: those of the class and those of its features, each once, in the ontology's order. */
  facets: DeviceFacet[];
  /** What the class rests on: the API's features, the model family, or nothing (`other`). */
  basis: "features" | "model" | "unknown";
}

const isFeature = (f: string): f is UnifiFeature => f in FACET_OF_FEATURE;

/** The facets of a class and of some features, each once, in the order of `stolos:DeviceFacet`. */
export function facetsFor(cls: DeviceClass, features: readonly string[] = []): DeviceFacet[] {
  const have = new Set<DeviceFacet>(FACETS_OF_CLASS[cls]);
  for (const f of features) if (isFeature(f)) have.add(FACET_OF_FEATURE[f]);
  return DEVICE_FACETS.filter((f) => have.has(f));
}

/** Classify a device from what the official API gives of it. */
export function classify(d: ClassifyInput): Classification {
  const f = new Set(d.features);
  const fromFeatures: DeviceClass | undefined = f.has("gateway")
    ? "gateway"
    : f.has("switching")
      ? "switch"
      : f.has("accessPoint")
        ? "access-point"
        : undefined;
  if (fromFeatures !== undefined) {
    return {
      class: fromFeatures,
      facets: facetsFor(fromFeatures, d.features),
      basis: "features",
    };
  }
  const model = d.model.trim();
  const family = MODEL_FAMILIES.find((m) => m.pattern.test(model));
  if (family !== undefined) {
    return { class: family.class, facets: facetsFor(family.class), basis: "model" };
  }
  return { class: "other", facets: [], basis: "unknown" };
}

/**
 * A class as a person types it (`switch`, `Switch`, `access-point`, `AccessPoint`, `access point`), or undefined where it is none of the
 * ontology's.
 */
export function parseClass(word: string): DeviceClass | undefined {
  const w = word
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return DEVICE_CLASSES.find((c) => c === w);
}

/** A facet as a person types it, or undefined. */
export function parseFacet(word: string): DeviceFacet | undefined {
  const w = word
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return DEVICE_FACETS.find((c) => c === w);
}

/** Every device of any vendor that has a facet: what a feature asks for. */
export function devicesWithFacet<T extends { facets: readonly DeviceFacet[] }>(
  devices: readonly T[],
  facet: DeviceFacet,
): T[] {
  return devices.filter((d) => d.facets.includes(facet));
}
