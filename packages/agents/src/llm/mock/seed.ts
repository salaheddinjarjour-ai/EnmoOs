/* Deterministic seeding for MockLlm fixtures: the same input always yields the same output. */

/** JSON with object keys sorted, so equal values hash equally whatever their key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(item).sort())
      sorted[key] = (item as Record<string, unknown>)[key];
    return sorted;
  });
}

/** FNV-1a, 32-bit. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hashOf(value: unknown): number {
  return hashString(stableStringify(value) ?? "undefined");
}

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new Error("Rng.pick on an empty list");
      return items[Math.floor(next() * items.length)]!;
    },
  };
}
