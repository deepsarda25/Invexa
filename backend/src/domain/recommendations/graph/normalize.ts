/**
 * Cross-sectional normalization + sector neutralization.
 *
 * Both operate on the *whole panel at once* (every row: every ticker at
 * every offset) rather than per-ticker, which is the point — a feature's
 * scale and "what's typical for this sector" both depend on what
 * everything else in the universe looked like at roughly the same time,
 * not on some fixed constant. Without this step, a feature like P/E or
 * market cap can dominate distance purely because of its raw magnitude
 * (exactly the failure mode called out for the earlier design).
 */

export function crossSectionalZScores(vectors: number[][]): number[][] {
  const dims = vectors[0]?.length ?? 0;
  if (dims === 0) return vectors.map(() => []);

  const means = new Array(dims).fill(0);
  const stds = new Array(dims).fill(0);

  for (let d = 0; d < dims; d += 1) {
    let sum = 0;
    let count = 0;
    for (const v of vectors) {
      if (Number.isFinite(v[d])) {
        sum += v[d];
        count += 1;
      }
    }
    means[d] = count > 0 ? sum / count : 0;
  }

  for (let d = 0; d < dims; d += 1) {
    let sumSq = 0;
    let count = 0;
    for (const v of vectors) {
      if (Number.isFinite(v[d])) {
        sumSq += (v[d] - means[d]) ** 2;
        count += 1;
      }
    }
    stds[d] = count > 0 ? Math.sqrt(sumSq / count) : 0;
  }

  // A missing/unfinite feature is mapped to 0 (i.e. "average, no
  // information") after z-scoring, rather than letting a raw NaN poison
  // every downstream dot product.
  return vectors.map((v) =>
    v.map((x, d) => {
      if (!Number.isFinite(x)) return 0;
      if (stds[d] === 0) return 0;
      return (x - means[d]) / stds[d];
    })
  );
}

/**
 * Subtracts each feature's sector-wide mean from every row belonging to
 * that sector. Applied *after* z-scoring. The effect: two banks that both
 * happen to be in a rallying banking sector don't look "similar" purely
 * because banking is up — what matters for similarity is how each one is
 * doing *relative to its own sector*, which is a much better proxy for
 * shared idiosyncratic behavior than raw sector membership alone.
 */
export function sectorNeutralize<T extends { sector?: string }>(rows: T[], vectors: number[][]): number[][] {
  const dims = vectors[0]?.length ?? 0;
  if (dims === 0) return vectors.map(() => []);

  const sectorSums = new Map<string, number[]>();
  const sectorCounts = new Map<string, number>();

  rows.forEach((row, i) => {
    const key = row.sector ?? "Unclassified";
    const sums = sectorSums.get(key) ?? new Array(dims).fill(0);
    vectors[i].forEach((x, d) => {
      sums[d] += Number.isFinite(x) ? x : 0;
    });
    sectorSums.set(key, sums);
    sectorCounts.set(key, (sectorCounts.get(key) ?? 0) + 1);
  });

  return vectors.map((v, i) => {
    const key = rows[i].sector ?? "Unclassified";
    const sums = sectorSums.get(key)!;
    const count = sectorCounts.get(key)!;
    return v.map((x, d) => x - sums[d] / count);
  });
}

/** k-th percentile (0..100) of a numeric array, linear-interpolated. Ignores non-finite values. */
export function percentile(values: number[], p: number): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  const rank = (p / 100) * (clean.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return clean[lower];
  const weight = rank - lower;
  return clean[lower] * (1 - weight) + clean[upper] * weight;
}
