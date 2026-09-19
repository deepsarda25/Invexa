export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magnitudeA += a[i] ** 2;
    magnitudeB += b[i] ** 2;
  }

  if (magnitudeA === 0 || magnitudeB === 0) return 0;

  return dot / Math.sqrt(magnitudeA * magnitudeB);
}

export function sameSector(a?: string, b?: string): 0 | 1 {
  if (!a || !b) return 0;
  return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
}

export function sameIndustry(a?: string, b?: string): 0 | 1 {
  if (!a || !b) return 0;
  return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
}

/**
 * Blended edge weight (0..1) for the price-feature graph.
 *
 * `featureVector` is the full, normalized + sector-neutralized price
 * feature vector; `returnVector` is the subset of it that's purely about
 * return profile (ret20/ret60/ret120/relativeStrength20) — split out and
 * given its own weight because "moves like me" and "matches my overall
 * risk/behavior profile" are related but distinct notions of similarity,
 * and collapsing them into one cosine score over the full vector lets
 * volatility/drawdown swamp the thing recommendations actually care most
 * about (shared direction of movement).
 */
export function priceSimilarity(
  featureVectorA: number[],
  featureVectorB: number[],
  returnVectorA: number[],
  returnVectorB: number[],
  sectorA: string | undefined,
  sectorB: string | undefined,
  industryA: string | undefined,
  industryB: string | undefined
): number {
  const featureScore = (cosineSimilarity(featureVectorA, featureVectorB) + 1) / 2;
  const returnScore = (cosineSimilarity(returnVectorA, returnVectorB) + 1) / 2;

  return (
    featureScore * 0.45 +
    returnScore * 0.25 +
    sameSector(sectorA, sectorB) * 0.15 +
    sameIndustry(industryA, industryB) * 0.15
  );
}
