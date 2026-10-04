/** JSONB preserves values and array order, but not object-property order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))
    : entry) ?? 'undefined'
}

export function matchesJson(value: unknown, encoded: string): boolean {
  try { return stableJson(value) === stableJson(JSON.parse(encoded)) } catch { return false }
}
