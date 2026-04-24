/**
 * Pure line-diff math for save-over-save comparison. Extracted from the
 * extension's lineDiffer so both sides can share it and it's unit-testable
 * without a VS Code environment. No crypto, no fs — SHA-1 fingerprinting is
 * delegated back to the caller so this module stays dependency-free.
 */

export interface LineDiffRewrite {
  fingerprint: string;
  roughLine: number;
  contentHash: string;
  sampleContent?: string;
}

export interface LineDiffResult {
  linesAdded: number;
  linesRemoved: number;
  rewritten: LineDiffRewrite[];
}

export interface LineDiffHashers {
  /** Short stable hash of a string. 16 hex chars is the extension default. */
  hashString: (input: string) => string;
}

const MAX_SAMPLE_CHARS = 120;

function normalize(line: string): string {
  return line.trim();
}

function fingerprintFor(
  file: string,
  roughLine: number,
  content: string,
  hashers: LineDiffHashers
): string {
  return hashers.hashString(
    `${file}::${Math.floor(roughLine / 5)}::${normalize(content).slice(0, 64)}`
  );
}

/**
 * Compute the multiset-based line diff between prior and current versions of
 * a file. Blank lines (after trim) are ignored. A rewrite fingerprint is
 * emitted for each index where both sides have a non-blank line and the
 * contents differ.
 */
export function computeLineDiff(
  prior: string[],
  current: string[],
  file: string,
  hashers: LineDiffHashers
): LineDiffResult {
  const priorSet = new Set<string>();
  for (let i = 0; i < prior.length; i++) {
    const n = normalize(prior[i]);
    if (n) priorSet.add(`${i}::${n}`);
  }
  const currentSet = new Set<string>();
  for (let i = 0; i < current.length; i++) {
    const n = normalize(current[i]);
    if (n) currentSet.add(`${i}::${n}`);
  }

  let linesAdded = 0;
  let linesRemoved = 0;
  const rewritten: LineDiffRewrite[] = [];

  const priorTextMultiset = new Map<string, number>();
  for (const p of prior) {
    const n = normalize(p);
    if (!n) continue;
    priorTextMultiset.set(n, (priorTextMultiset.get(n) ?? 0) + 1);
  }
  const currentTextMultiset = new Map<string, number>();
  for (const l of current) {
    const n = normalize(l);
    if (!n) continue;
    currentTextMultiset.set(n, (currentTextMultiset.get(n) ?? 0) + 1);
  }

  for (const [line, count] of currentTextMultiset) {
    const before = priorTextMultiset.get(line) ?? 0;
    if (count > before) linesAdded += count - before;
  }
  for (const [line, count] of priorTextMultiset) {
    const after = currentTextMultiset.get(line) ?? 0;
    if (count > after) linesRemoved += count - after;
  }

  // Rewrite fingerprints — for each current line whose prior at same
  // roughLine was different, emit a fingerprint. Blank lines ignored.
  const len = Math.min(current.length, prior.length);
  for (let i = 0; i < len; i++) {
    const c = normalize(current[i]);
    const p = normalize(prior[i]);
    if (!c || !p) continue;
    if (c === p) continue;
    if (!currentSet.has(`${i}::${c}`)) continue;
    if (!priorSet.has(`${i}::${p}`)) continue;
    const fp = fingerprintFor(file, i, c, hashers);
    rewritten.push({
      fingerprint: fp,
      roughLine: i + 1,
      contentHash: hashers.hashString(c),
      sampleContent: c.slice(0, MAX_SAMPLE_CHARS),
    });
  }

  return { linesAdded, linesRemoved, rewritten };
}
