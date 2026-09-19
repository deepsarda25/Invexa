import { crossSectionalZScores, sectorNeutralize } from "./normalize";
import { priceSimilarity } from "./similarity";
import type { GraphNeighbor, PriceFeatureRow } from "./types";

export type NormalizedPanel = {
  rows: PriceFeatureRow[];
  /** Normalized + sector-neutralized feature vectors, index-aligned with `rows`. */
  vectors: number[][];
};

// Indices into PRICE_FEATURE_NAMES that describe pure return profile
// (as opposed to volatility/drawdown/52w-distance), used for the
// `returnScore` term in similarity.priceSimilarity.
const RETURN_FEATURE_INDICES = [0, 1, 2, 6]; // ret20, ret60, ret120, relativeStrength20

function returnVectorOf(vector: number[]): number[] {
  return RETURN_FEATURE_INDICES.map((i) => vector[i]);
}

export function buildNormalizedPanel(rows: PriceFeatureRow[]): NormalizedPanel {
  const raw = rows.map((r) => r.raw);
  const zScored = crossSectionalZScores(raw);
  const neutralized = sectorNeutralize(rows, zScored);
  return { rows, vectors: neutralized };
}

export type KnnPredictionOptions = {
  neighbors?: number;
  minimumSimilarity?: number;
};

export type KnnPrediction = {
  predictedReturn20d: number | null;
  /** 0..1 */
  confidence: number;
  neighbors: GraphNeighbor[];
};

/**
 * Predicts `targetIndex`'s forward 20-day return from the (similarity,
 * realized-forward-return) pairs of everything in `candidateIndices`.
 *
 * This function has no opinion about *why* a candidate is or isn't a
 * legitimate peer to learn from — that's the caller's job (see
 * walkForward.ts's causal-ordering rule, and
 * graphRecommendationEngine.ts's live-prediction candidate set). It only
 * knows how to rank by similarity and combine the survivors.
 */
export function predictFromHistoricalAnalogs(
  targetIndex: number,
  panel: NormalizedPanel,
  candidateIndices: number[],
  options: KnnPredictionOptions = {}
): KnnPrediction {
  const neighborsWanted = options.neighbors ?? 12;
  const minimumSimilarity = options.minimumSimilarity ?? 0.55;

  const targetRow = panel.rows[targetIndex];
  const targetVector = panel.vectors[targetIndex];
  const targetReturnVector = returnVectorOf(targetVector);

  const rankedAll = candidateIndices
    .map((idx) => {
      const row = panel.rows[idx];
      const vector = panel.vectors[idx];
      const similarity = priceSimilarity(
        targetVector,
        vector,
        targetReturnVector,
        returnVectorOf(vector),
        targetRow.sector,
        row.sector,
        targetRow.industry,
        row.industry
      );
      return { idx, row, similarity };
    })
    .filter((item) => item.similarity >= minimumSimilarity && item.row.forwardReturn20d != null)
    .sort((a, b) => b.similarity - a.similarity);

  // Deduplicate by ticker, keeping only each company's single closest
  // analog. Without this, a company with a long, calm price history
  // routinely supplies several of its own past states as "neighbors" at
  // different offsets — which both looks like a repeated/broken list in
  // the UI and is a real statistical problem (pseudo-replication): those
  // rows aren't independent evidence, they're highly autocorrelated
  // snapshots of the same underlying company, and letting them fill most
  // of the neighbor slots quietly narrows the peer set to 2-3 companies
  // while looking like N analogs.
  const seenTickers = new Set<string>();
  const ranked: typeof rankedAll = [];
  for (const item of rankedAll) {
    if (seenTickers.has(item.row.ticker)) continue;
    seenTickers.add(item.row.ticker);
    ranked.push(item);
    if (ranked.length >= neighborsWanted) break;
  }

  const toNeighbor = (item: (typeof ranked)[number]): GraphNeighbor => ({
    ticker: item.row.ticker,
    name: item.row.name,
    similarity: Number(item.similarity.toFixed(4)),
    offset: item.row.offset,
    historicalForwardReturn20d: item.row.forwardReturn20d,
    fundamentalSimilarity: null // filled in by the engine as a display-only context layer, see types.ts
  });

  // Fewer than 3 usable analogs isn't enough to average over responsibly —
  // report it as NO_DATA-grade rather than a confident-looking number
  // built from one or two coincidental matches.
  if (ranked.length < 3) {
    return { predictedReturn20d: null, confidence: 0, neighbors: ranked.map(toNeighbor) };
  }

  let weightedReturn = 0;
  let totalWeight = 0;
  for (const item of ranked) {
    const weight = item.similarity ** 2; // square to let the closest analogs dominate over marginal ones
    weightedReturn += weight * (item.row.forwardReturn20d ?? 0);
    totalWeight += weight;
  }
  const predictedReturn20d = totalWeight > 0 ? weightedReturn / totalWeight : null;

  const meanReturn = ranked.reduce((sum, item) => sum + (item.row.forwardReturn20d ?? 0), 0) / ranked.length;
  const variance =
    ranked.reduce((sum, item) => sum + ((item.row.forwardReturn20d ?? 0) - meanReturn) ** 2, 0) / ranked.length;
  // Returns here are fractions (0.05 = 5%), not percentages, so the
  // penalty scaling is tuned accordingly — a 5% stdev of disagreement
  // among neighbors already meaningfully dents confidence.
  const disagreementPenalty = Math.min(Math.sqrt(variance) * 4, 0.5);

  const avgSimilarity = ranked.reduce((sum, item) => sum + item.similarity, 0) / ranked.length;

  const confidence = Math.max(
    0,
    Math.min(1, (ranked.length / neighborsWanted) * 0.4 + avgSimilarity * 0.35 + (1 - disagreementPenalty) * 0.25)
  );

  return { predictedReturn20d, confidence, neighbors: ranked.map(toNeighbor) };
}
