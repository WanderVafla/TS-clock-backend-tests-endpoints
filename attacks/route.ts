// Route-level attacks, interpreted per registry path by the engine.
export type RouteAttack =
  | { kind: "unknown-route"; label: string }
  | { kind: "method"; label: string; method: string }
  | { kind: "slash"; label: string; suffix: string };

export const ROUTE_ATTACKS: RouteAttack[] = [
  { kind: "method", label: "PUT-not-allowed", method: "PUT" },
  { kind: "method", label: "HEAD", method: "HEAD" },
  { kind: "method", label: "OPTIONS", method: "OPTIONS" },
  { kind: "slash", label: "trailing-slash", suffix: "/" },
  { kind: "slash", label: "double-slash", suffix: "/" },
];

export const UNKNOWN_ROUTES = [
  "/contract-nope-xyz",
  "/labels/../contract-nope",
  "/labels%2fcontract-nope",
];
