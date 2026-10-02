import type { Attack } from "../assertions";

export const BOOLEAN_ATTACKS: Attack[] = [
  { label: "string-true", value: "true", tags: ["confusable"] },
  { label: "string-false", value: "false", tags: ["confusable"] },
  { label: "zero", value: 0, tags: ["confusable"] },
  { label: "one", value: 1, tags: ["confusable"] },
  { label: "string-yes", value: "yes", tags: ["confusable"] },
  { label: "null", value: null, tags: ["type"] },
  { label: "array", value: [], tags: ["type"] },
  { label: "object", value: {}, tags: ["type"] },
];
