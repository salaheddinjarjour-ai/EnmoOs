/*
 * The one banned-words matcher (DESIGN §C). Used by the web CopyEditor warnings, the agent
 * validators, PATCH /posts/:id/copy (422), the gate before an approval request and the publish
 * guard, so a word flagged in one place is flagged in all of them.
 *
 * Matching:
 *   - Text and terms are folded the same way: NFKC (full-width letters, ligatures, Arabic
 *     presentation forms), case folding, then optional diacritics and invisible characters are
 *     ignored: Latin combining accents, Arabic harakat and tatweel, format characters such as
 *     zero-width spaces. A caption can't dodge the list with an accent, tashkeel or a ZWSP, and
 *     Arabic hamza-on-alef spellings (أ/إ/آ vs ا) match each other. Marks that change a letter in
 *     other scripts (e.g. Devanagari vowel signs) are kept.
 *   - A term only matches whole words: it may not touch a letter, digit or mark on either side
 *     (`(?<![\p{L}\p{N}\p{M}])term(?![\p{L}\p{N}\p{M}])`), in any script. Arabic clitics are not
 *     stripped, so "رخيص" does not match "والرخيص"; list those forms explicitly.
 *   - Multi-word terms match across any run of spaces, hyphens or underscores.
 *   - A leading "#" on a list entry is ignored, so "#ad" bans "ad". A hashtag whose body is a
 *     multi-word term with the separators removed ("#FreeShipping" for "free shipping") matches.
 * Match offsets refer to the original, unfolded text.
 */

export interface BannedWordMatch {
  /** The list entry that matched, spelled as in the list. */
  term: string;
  /** UTF-16 offset of the match in the original text. */
  index: number;
  /** Length of the match in the original text. */
  length: number;
  /** The matched slice of the original text. */
  match: string;
}

export interface BannedWordHit extends BannedWordMatch {
  /** JSON path of the string field, e.g. `script.scenes[0].voiceover`; "" for a bare string. */
  path: string;
}

export interface BannedWordScanOptions {
  /** Object keys whose values are skipped entirely (e.g. enum fields like "platform"). */
  ignoreKeys?: readonly string[];
  /** Keys holding hashtag arrays: their items are read as hashtags even without the "#". */
  hashtagKeys?: readonly string[];
  /**
   * Stop after this many hits: the first ones in walk order, so a hostile or huge value can't
   * make the report as big as itself.
   */
  limit?: number;
}

export interface BannedWordMatcher {
  /** The distinct list entries in effect (blank and fold-equal duplicates dropped). */
  readonly terms: readonly string[];
  find(text: string): BannedWordMatch[];
  scan(value: unknown, options?: BannedWordScanOptions): BannedWordHit[];
}

const DEFAULT_HASHTAG_KEYS = ["hashtags"] as const;

/*
 * Removed after decomposition: format characters (ZWSP, ZWJ, bidi marks), Latin combining accents,
 * Arabic signs, harakat, superscript alef and Quranic marks, variation selectors, and tatweel.
 * Tatweel is a letter (Lm), so it sits last: in front of a mark it would read as one combined
 * character.
 */
const IGNORABLE =
  /[\p{Cf}\u0300-\u036F\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\uFE00-\uFE0F\u0640]/gu;
/** A base character with its combining marks, or stray marks: folded as one unit. */
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;
const WORD_CHAR = String.raw`[\p{L}\p{N}\p{M}]`;
const SEPARATOR = String.raw`[\s\p{Z}\p{Pd}_]+`;
const SEPARATOR_RE = new RegExp(SEPARATOR, "u");
const NON_WORD_RE = new RegExp(String.raw`[^\p{L}\p{N}\p{M}]+`, "gu");
const HASHTAG_RE = new RegExp(String.raw`#([\p{L}\p{N}\p{M}_]+)`, "gu");

function foldCluster(cluster: string): string {
  // Upper-then-lower approximates Unicode case folding (ß → ss, ς → σ).
  return cluster
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFD")
    .replace(IGNORABLE, "");
}

interface FoldedText {
  text: string;
  /** For each UTF-16 unit of `text`: the [start, end) range it came from in the original. */
  starts: number[];
  ends: number[];
}

function foldWithOffsets(original: string): FoldedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const cluster of original.matchAll(CLUSTER)) {
    const folded = foldCluster(cluster[0]);
    const start = cluster.index;
    const end = start + cluster[0].length;
    text += folded;
    for (let i = 0; i < folded.length; i++) {
      starts.push(start);
      ends.push(end);
    }
  }
  return { text, starts, ends };
}

/** The folded form the matcher compares (exported for tests and diagnostics). */
export function foldForBannedWords(text: string): string {
  return foldWithOffsets(text).text;
}

/** Escapes syntax characters only: the `u` flag rejects identity escapes like `\-`. */
function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

interface CompiledTerm {
  term: string;
  pattern: RegExp;
  /** Separator-free form for hashtag bodies; null for single-word terms (the pattern covers them). */
  compact: string | null;
}

function compileTerm(term: string): { key: string; compiled: CompiledTerm } | null {
  const folded = foldForBannedWords(term.trim().replace(/^#+/, "")).trim();
  const words = folded.split(SEPARATOR_RE).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  const body = words.map(escapeRegExp).join(SEPARATOR);
  const compact = words.join("").replace(NON_WORD_RE, "");
  return {
    key: words.join(" "),
    compiled: {
      term,
      pattern: new RegExp(`(?<!${WORD_CHAR})(?:${body})(?!${WORD_CHAR})`, "gu"),
      compact: words.length > 1 && compact.length > 0 ? compact : null,
    },
  };
}

export function compileBannedWords(list: readonly string[]): BannedWordMatcher {
  const byKey = new Map<string, CompiledTerm>();
  for (const term of list) {
    const result = compileTerm(term);
    if (result && !byKey.has(result.key)) byKey.set(result.key, result.compiled);
  }
  const compiled = [...byKey.values()];
  const matcher: BannedWordMatcher = {
    terms: compiled.map((entry) => entry.term),
    find: (text) => findCompiled(compiled, text),
    scan: (value, options) => scanValue(matcher, value, options),
  };
  return matcher;
}

function findCompiled(compiled: readonly CompiledTerm[], original: string): BannedWordMatch[] {
  if (compiled.length === 0 || original.length === 0) return [];
  const folded = foldWithOffsets(original);
  const found: { order: number; start: number; end: number; term: string }[] = [];
  // A hashtag hit can repeat a pattern hit; a Set keeps the dedupe linear in the number of hits.
  const seen = new Set<string>();

  const add = (order: number, term: string, from: number, to: number) => {
    const start = folded.starts[from]!;
    const end = folded.ends[to - 1]!;
    const key = `${order}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ order, start, end, term });
  };

  compiled.forEach((entry, order) => {
    for (const match of folded.text.matchAll(entry.pattern)) {
      if (match[0].length > 0) add(order, entry.term, match.index, match.index + match[0].length);
    }
  });

  if (compiled.some((entry) => entry.compact)) {
    for (const hashtag of folded.text.matchAll(HASHTAG_RE)) {
      const body = hashtag[1]!;
      const compact = body.replace(NON_WORD_RE, "");
      const from = hashtag.index + 1;
      compiled.forEach((entry, order) => {
        if (entry.compact === compact) add(order, entry.term, from, from + body.length);
      });
    }
  }

  return found
    .sort((a, b) => a.start - b.start || a.order - b.order)
    .map(({ term, start, end }) => ({
      term,
      index: start,
      length: end - start,
      match: original.slice(start, end),
    }));
}

function scanValue(
  matcher: BannedWordMatcher,
  value: unknown,
  options: BannedWordScanOptions = {},
): BannedWordHit[] {
  const ignore = new Set(options.ignoreKeys ?? []);
  const hashtagKeys = new Set<string>(options.hashtagKeys ?? DEFAULT_HASHTAG_KEYS);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const hits: BannedWordHit[] = [];
  const seen = new WeakSet<object>();
  const full = () => hits.length >= limit;

  const visit = (node: unknown, path: string, asHashtag: boolean) => {
    if (full()) return;
    if (typeof node === "string") {
      const prefixed = asHashtag && !node.startsWith("#");
      const text = prefixed ? `#${node}` : node;
      for (const match of matcher.find(text)) {
        if (full()) return;
        // Map offsets back from the "#"-prefixed text to the stored item.
        const shift = prefixed ? 1 : 0;
        const index = Math.max(0, match.index - shift);
        const end = match.index + match.length - shift;
        hits.push({ ...match, index, length: end - index, match: node.slice(index, end), path });
      }
      return;
    }
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`, asHashtag));
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (ignore.has(key)) continue;
      visit(child, path ? `${path}.${key}` : key, hashtagKeys.has(key));
    }
  };

  if (matcher.terms.length > 0) visit(value, "", false);
  return hits;
}

function isMatcher(list: readonly string[] | BannedWordMatcher): list is BannedWordMatcher {
  return !Array.isArray(list);
}

function toMatcher(list: readonly string[] | BannedWordMatcher): BannedWordMatcher {
  return isMatcher(list) ? list : compileBannedWords(list);
}

/** Every banned-word occurrence in `text`, in order of position. */
export function findBannedWords(
  text: string,
  list: readonly string[] | BannedWordMatcher,
): BannedWordMatch[] {
  return toMatcher(list).find(text);
}

/** Walks every string field of a JSON-like value (e.g. a CopywriterOutput) and reports hits by path. */
export function scanForBannedWords(
  value: unknown,
  list: readonly string[] | BannedWordMatcher,
  options?: BannedWordScanOptions,
): BannedWordHit[] {
  return toMatcher(list).scan(value, options);
}
