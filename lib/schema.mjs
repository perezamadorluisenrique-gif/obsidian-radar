// A deliberately small JSON-Schema (draft-07 subset) validator, so the pipeline needs no dependencies.
// Supported: type, enum, const, required, properties, additionalProperties (bool | schema), items,
// minItems, maxItems, minimum, maximum, minLength, maxLength, pattern, format (date, date-time, uri),
// anyOf, oneOf, allOf, $ref to "#/definitions/..". Unknown keywords are ignored.
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t);

export function validate(rootSchema, value, { maxErrors = 20 } = {}) {
  const resolve = (ref) => ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], rootSchema);

  // Collects error strings for `v` against `s`. Stops early once `limit` errors were found.
  function run(s, v, at, limit) {
    const errors = [];
    const err = (m) => { if (errors.length < limit) errors.push(`${at || '$'}: ${m}`); };
    const sub = (s2, v2, at2) => { if (errors.length < limit) errors.push(...run(s2, v2, at2, limit - errors.length)); };
    if (s.$ref) return run(resolve(s.$ref), v, at, limit);
    for (const x of s.allOf ?? []) sub(x, v, at);
    if (s.anyOf && !s.anyOf.some((x) => run(x, v, at, 1).length === 0)) err('does not match any of anyOf');
    if (s.oneOf && s.oneOf.filter((x) => run(x, v, at, 1).length === 0).length !== 1) err('does not match exactly one of oneOf');
    if (s.type) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some((t) => isType(v, t))) { err(`expected ${ts.join('|')}, got ${typeOf(v)}`); return errors; }
    }
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(v)) err(`must equal ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) err(`must be one of ${JSON.stringify(s.enum)}`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) err(`${v} < minimum ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) err(`${v} > maximum ${s.maximum}`);
    }
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) err(`shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && v.length > s.maxLength) err(`longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) err(`"${v.slice(0, 40)}" does not match /${s.pattern}/`);
      if (s.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) err('not a YYYY-MM-DD date');
      if (s.format === 'date-time' && Number.isNaN(Date.parse(v))) err('not an ISO date-time');
      if (s.format === 'uri' && !/^https?:\/\/\S+$/.test(v)) err('not an http(s) URL');
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) err(`fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) err(`more than ${s.maxItems} items`);
      if (s.items) v.forEach((x, i) => sub(s.items, x, `${at}[${i}]`));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of s.required ?? []) if (!(k in v)) err(`missing required "${k}"`);
      const props = s.properties ?? {};
      for (const [k, x] of Object.entries(v)) {
        if (k in props) sub(props[k], x, `${at}.${k}`);
        else if (s.additionalProperties === false) err(`unexpected property "${k}"`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') sub(s.additionalProperties, x, `${at}.${k}`);
      }
    }
    return errors;
  }
  return run(rootSchema, value, '', maxErrors);
}

export const assertValid = (schema, value, label = 'value') => {
  const errs = validate(schema, value);
  if (errs.length) throw new Error(`${label} failed schema validation:\n  ${errs.join('\n  ')}`);
};
