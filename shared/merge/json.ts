type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MISSING = Symbol('missing');
type Value = Json | typeof MISSING;

const isObject = (value: Value): value is { [key: string]: Json } => typeof value === 'object' && value !== null && !Array.isArray(value);
function equal(x: Value, y: Value): boolean {
  if (x === y) return true;
  if (x === MISSING || y === MISSING || typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  if (Array.isArray(x) || Array.isArray(y)) return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((item, i) => equal(item, y[i]));
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(key => Object.hasOwn(y, key) && equal(x[key], y[key]));
}

/** Object member order is immaterial to JSON equality; array order is not. */
function fingerprint(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fingerprint(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Detects the serializer's layout and refuses files a re-serialization would reformat. */
function layout(text: string, parsed: Json): { indent: string | number; newline: boolean } | null {
  const indent = text.match(/\n([ \t]+)\S/)?.[1] ?? '  ';
  const newline = text.endsWith('\n');
  return JSON.stringify(parsed, null, indent) + (newline ? '\n' : '') === text ? { indent, newline } : null;
}

type JsonMergeResult = { text: string; conflicts: [] } | { text: null; conflicts: string[] };

/**
 * Key-level three-way merge for JSON configuration such as package.json.
 * Returns null when a file is not canonically formatted JSON, so formatting is
 * never rewritten as a side effect. Arrays merge only when both sides append.
 */
export function mergeJson(base: string, ours: string, theirs: string): JsonMergeResult | null {
  let o: Json, a: Json, b: Json;
  try { o = JSON.parse(base); a = JSON.parse(ours); b = JSON.parse(theirs); } catch { return null; }
  const format = layout(ours, a);
  const original = layout(base, o), incoming = layout(theirs, b);
  // Parsing may discard duplicate keys or round numbers. Check every input,
  // and do not silently discard an incoming indentation or newline change.
  if (!format || !original || !incoming || format.indent !== original.indent || format.indent !== incoming.indent
    || format.newline !== original.newline || format.newline !== incoming.newline) return null;
  const conflicts: string[] = [];
  const merged = value(o, a, b, '$', conflicts);
  if (conflicts.length) return { text: null, conflicts };
  if (merged === MISSING) return { text: null, conflicts: ['$'] };
  return { text: JSON.stringify(merged, null, format.indent) + (format.newline ? '\n' : ''), conflicts: [] };
}

function value(o: Value, a: Value, b: Value, path: string, conflicts: string[]): Value {
  if (equal(a, b) || equal(b, o)) return a;
  if (equal(a, o)) return b;
  if (isObject(a) && isObject(b) && (o === MISSING || isObject(o))) return object(o === MISSING ? {} : o, a, b, path, conflicts);
  if (Array.isArray(o) && Array.isArray(a) && Array.isArray(b) && a.length >= o.length && b.length >= o.length
    && o.every((item, i) => equal(item, a[i]) && equal(item, b[i]))) {
    const added = new Map<string, number>();
    for (const item of a.slice(o.length)) {
      const key = fingerprint(item);
      added.set(key, (added.get(key) ?? 0) + 1);
    }
    const result = [...a];
    for (const item of b.slice(o.length)) {
      const key = fingerprint(item), count = added.get(key) ?? 0;
      if (count) added.set(key, count - 1);
      else result.push(item);
    }
    return result;
  }
  conflicts.push(path);
  return a;
}

function object(o: { [key: string]: Json }, a: { [key: string]: Json }, b: { [key: string]: Json }, path: string, conflicts: string[]) {
  const keys = Object.keys(a);
  const sorted = keys.length > 1 && keys.every((key, i) => i === 0 || keys[i - 1].localeCompare(key) <= 0);
  for (const key of Object.keys(b)) if (!Object.hasOwn(a, key)) keys.push(key);
  if (sorted) keys.sort((x, y) => x.localeCompare(y));
  // A literal __proto__ member is data, not an invocation of Object's setter.
  const result: { [key: string]: Json } = Object.create(null);
  for (const key of new Set([...keys, ...Object.keys(o)])) {
    const merged = value(Object.hasOwn(o, key) ? o[key] : MISSING, Object.hasOwn(a, key) ? a[key] : MISSING, Object.hasOwn(b, key) ? b[key] : MISSING, `${path}.${key}`, conflicts);
    if (merged !== MISSING) result[key] = merged;
  }
  return result;
}
