// Body-level attacks: raw payloads and content-type variants.
// Engine sends `raw` verbatim with the given headers.
export type RawBodyAttack = {
  label: string;
  raw: string | undefined; // undefined = no body at all
  contentType: string | undefined; // undefined = header omitted
  tags: string[];
};

export const RAW_BODY_ATTACKS: RawBodyAttack[] = [
  { label: "broken-json", raw: "{not json", contentType: "application/json", tags: ["shape"] },
  { label: "truncated-json", raw: '{"name": "abc', contentType: "application/json", tags: ["shape"] },
  { label: "empty-body-with-ct", raw: "", contentType: "application/json", tags: ["shape"] },
  { label: "no-body-no-ct", raw: undefined, contentType: undefined, tags: ["shape"] },
  { label: "top-level-array", raw: '["a","b"]', contentType: "application/json", tags: ["shape"] },
  { label: "top-level-string", raw: '"just a string"', contentType: "application/json", tags: ["shape"] },
  { label: "top-level-number", raw: "42", contentType: "application/json", tags: ["shape"] },
  { label: "top-level-null", raw: "null", contentType: "application/json", tags: ["shape"] },
  { label: "top-level-true", raw: "true", contentType: "application/json", tags: ["shape"] },
  { label: "duplicate-keys", raw: '{"name":"a","name":"b"}', contentType: "application/json", tags: ["shape"] },
  { label: "missing-ct", raw: '{"name":"contract-x"}', contentType: undefined, tags: ["headers"] },
  { label: "text-plain", raw: '{"name":"contract-x"}', contentType: "text/plain", tags: ["headers"] },
  { label: "urlencoded", raw: "name=contract-x", contentType: "application/x-www-form-urlencoded", tags: ["headers"] },
  { label: "wrong-charset", raw: '{"name":"contract-x"}', contentType: "application/json; charset=iso-8859-1", tags: ["headers"] },
  { label: "charset-utf16", raw: '{"name":"contract-x"}', contentType: "application/json; charset=utf-16", tags: ["headers"] },
];
