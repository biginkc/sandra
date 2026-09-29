// Pinned to catalog_fingerprint.py at e767bec7; catalog-scope.json does not list section names.
export const CATALOG_SECTIONS = Object.freeze(['created_objects_present', 'extensions', 'functions', 'index_names', 'relations', 'schema_migrations', 'schemas', 'trigger_names', 'types']);

export function hasExactKeys(value, expected, valid = () => true) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  return allowed.size === expected.length && keys.length === expected.length &&
    expected.every(key => Object.hasOwn(value, key)) &&
    keys.every(key => allowed.has(key) && valid(value[key], key));
}
