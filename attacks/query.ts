// Query-level attacks. Each entry builds the raw query string for one key
// given the currently valid value. Engine supplies key + valid value.
export type QueryAttack = {
  label: string;
  tags: string[];
  apply: (key: string, valid: string) => string;
};

const enc = encodeURIComponent;

export const QUERY_ATTACKS: QueryAttack[] = [
  { label: "repeated-key", tags: ["shape"], apply: (k, v) => `${k}=${v}&${k}=${v}` },
  { label: "repeated-key-diff", tags: ["shape"], apply: (k, v) => `${k}=${v}&${k}=999999` },
  { label: "array-syntax", tags: ["shape"], apply: (k, v) => `${k}[]=${v}` },
  { label: "indexed-syntax", tags: ["shape"], apply: (k, v) => `${k}[0]=${v}` },
  { label: "empty-value", tags: ["boundary"], apply: (k) => `${k}=` },
  { label: "missing-key", tags: ["boundary"], apply: () => `` },
  { label: "percent-encoded", tags: ["encoding"], apply: (k, v) => `${k}=${enc(v)}` },
  { label: "double-encoded", tags: ["encoding"], apply: (k, v) => `${k}=${enc(enc(v))}` },
  { label: "upper-key", tags: ["shape"], apply: (k, v) => `${k.toUpperCase()}=${v}` },
  { label: "long-value", tags: ["boundary"], apply: (k) => `${k}=${"9".repeat(500)}` },
  { label: "unicode-value", tags: ["encoding"], apply: (k) => `${k}=${enc("тест🐛")}` },
  { label: "plus-as-space", tags: ["encoding"], apply: (k) => `${k}=+5+` },
  { label: "semicolon-sep", tags: ["shape"], apply: (k, v) => `${k}=${v};other=1` },
];
