/* Package-internal helpers; intentionally not re-exported from index.ts. */

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function hasUniqueItems<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}
