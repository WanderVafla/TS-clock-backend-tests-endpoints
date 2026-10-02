// Object-level attack DATA. The engine applies these generically to every
// object payload (extra keys one at a time + all together, proto keys).
// Valibot strips unknown keys by default, so the oracle (safeParse) expects
// SUCCESS here — owner confirmed stripping is currently accepted behavior.

export const MASS_ASSIGNMENT_KEYS: string[] = [
  "id",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "role",
  "isAdmin",
  "admin",
  "userId",
  "user_id",
  "deleted",
  "password",
];

export const PROTO_KEYS: string[] = ["__proto__", "constructor", "prototype"];

export const EXTRA_VALUES: unknown[] = ["x", 1, true, null, [], {}];
