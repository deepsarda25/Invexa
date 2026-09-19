import type { OhlcPoint } from "../../market/adapter";
import type { Market } from "../universe";
import { buildPriceFeatureRows, fillRelativeStrength } from "./features";
import { buildNormalizedPanel, predictFromHistoricalAnalogs, type KnnPrediction } from "./knnPredictor";
import { crossSectionalZScores, percentile } from "./normalize";
import { cosineSimilarity } from "./similarity";
import { defaultEvaluationOffsets, evaluateWalkForward } from "./walkForward";
import { FUNDAMENTAL_FEATURE_NAMES, type FundamentalSnapshot, type GraphModelMetrics, type GraphNeighbor, type GraphRecommendation } from "./types";

/**
 * Sector-neutralized, feature-based k-NN peer recommender with a real
 * (if single-snapshot) walk-forward check — see walkForward.ts for
 * exactly what that check does and does not prove.
 *
 * Deliberate design choice, stated plainly: fundamentals only ever enter
 * the *live* similarity graph as a display/context signal, never the
 * historical training panel used for `predictedReturn20d`. Yahoo
 * Finance's free API (and this app) only has *current* fundamentals, no
 * point-in-time history — using today's P/E to help "explain" a price
 * move from four months ago would be look-ahead bias, just a subtler
 * version of the one this design is supposed to fix. A model with a
 * fundamentals-aware, walk-forward-validated forward-return target needs
 * a point-in-time fundamentals database this app doesn't have; that's a
 * data-engineering project, not a scoring-formula one, and pretending
 * otherwise would just move the dishonesty from "arbitrary weights" to
 * "fabricated backtest."
 */

export const GRAPH_DISCLAIMER =
  "Sector-neutralized, feature-based k-nearest-neighbor screening signal. modelMetrics comes from a real walk-forward check over the same historical window the model was built from — not yet an independent, multi-regime, out-of-sample track record, and not personalized financial or investment advice.";

export type GraphUniverseInput = {
  ticker: string;
  name?: string;
  market: Market;
  sector?: string;
  industry?: string;
  points: OhlcPoint[];
};

export type GraphBuildResult = {
  results: GraphRecommendation[];
  modelMetrics: GraphModelMetrics;
};

const NEIGHBORS_TO_SHOW = 8;
const MIN_PREDICTIONS_FOR_DYNAMIC_THRESHOLDS = 5;
const FALLBACK_BUY_THRESHOLD = 0.05;
const FALLBACK_SELL_THRESHOLD = -0.05;

function buildFundamentalSimilarityIndex(
  universe: GraphUniverseInput[],
  fundamentalsByTicker: Map<string, FundamentalSnapshot>
): Map<string, { vector: number[]; hasData: boolean }> {
  const tickers = universe.map((e) => e.ticker);
  const rawVectors = tickers.map((ticker) => {
    const snapshot = fundamentalsByTicker.get(ticker);
    return FUNDAMENTAL_FEATURE_NAMES.map((name) => {
      const value = snapshot?.[name];
      return value == null ? NaN : value;
    });
  });
  const normalized = crossSectionalZScores(rawVectors);

  const index = new Map<string, { vector: number[]; hasData: boolean }>();
  tickers.forEach((ticker, i) => {
    const snapshot = fundamentalsByTicker.get(ticker);
    const hasData = !!snapshot && FUNDAMENTAL_FEATURE_NAMES.some((name) => snapshot[name] != null);
    index.set(ticker, { vector: normalized[i], hasData });
  });
  return index;
}

function buildReasons(
  entry: GraphUniverseInput,
  predictedReturn20d: number,
  knn: KnnPrediction,
  regimeAdjustment: number
): string[] {
  const reasons: string[] = [];
  const usableNeighbors = knn.neighbors.filter((n) => n.historicalForwardReturn20d != null);

  if (usableNeighbors.length > 0) {
    reasons.push(
      `${usableNeighbors.length} historical peer analog${usableNeighbors.length === 1 ? "" : "s"} matched above the similarity threshold.`
    );
    const avgHistoricalReturn =
      usableNeighbors.reduce((sum, n) => sum + (n.historicalForwardReturn20d ?? 0), 0) / usableNeighbors.length;
    reasons.push(`Those analogs realized an average 20-session forward return of ${(avgHistoricalReturn * 100).toFixed(1)}%.`);
  } else {
    reasons.push("No sufficiently similar historical analogs were found, so this leans heavily on momentum and regime terms.");
  }

  reasons.push(`Model prediction blends peer analogs (70%), the stock's own 20-session momentum (20%), and market regime (10%).`);
  reasons.push(`Broad market regime term is currently ${regimeAdjustment >= 0 ? "supportive" : "unsupportive"} (${(regimeAdjustment * 100).toFixed(1)}%).`);

  const topPeerTickers = Array.from(new Set(usableNeighbors.slice(0, 3).map((n) => n.ticker)));
  if (topPeerTickers.length > 0) reasons.push(`Closest analogs drawn from: ${topPeerTickers.join(", ")}.`);

  reasons.push(`Predicted 20-session forward return: ${(predictedReturn20d * 100).toFixed(1)}%.`);

  return reasons.slice(0, 6);
}

export function buildGraphRecommendations(
  universe: GraphUniverseInput[],
  fundamentalsByTicker: Map<string, FundamentalSnapshot>
): GraphBuildResult {
  const now = new Date().toISOString();

  // 1) Historical price-feature panel across the whole universe, then the
  // cross-sectional relative-strength pass, then normalize + sector-neutralize.
  const allRows = universe.flatMap((entry) => buildPriceFeatureRows(entry, entry.points));
  fillRelativeStrength(allRows);
  const panel = buildNormalizedPanel(allRows);

  // 2) Walk-forward validate the price-only KNN logic on that same panel.
  const maxOffset = panel.rows.reduce((max, row) => Math.max(max, row.offset), 0);
  const availableOffsets = panel.rows.map((row) => row.offset);
  const modelMetrics = evaluateWalkForward(panel, defaultEvaluationOffsets(availableOffsets, maxOffset));

  // 3) Market-regime term: mean *live* (offset 0) ret20 across the whole
  // universe — "how the tape has broadly been doing very recently."
  const liveIndexByTicker = new Map<string, number>();
  panel.rows.forEach((row, idx) => {
    if (row.offset === 0) liveIndexByTicker.set(row.ticker, idx);
  });
  const liveRet20Values = Array.from(liveIndexByTicker.values())
    .map((idx) => panel.rows[idx].raw[0])
    .filter((v) => Number.isFinite(v));
  const regimeAdjustment = liveRet20Values.length > 0 ? liveRet20Values.reduce((a, b) => a + b, 0) / liveRet20Values.length : 0;

  const fundamentalIndex = buildFundamentalSimilarityIndex(universe, fundamentalsByTicker);

  type Provisional = {
    entry: GraphUniverseInput;
    knn: KnnPrediction | null;
    predictedReturn20d: number | null;
  };

  // 4) Per-ticker live prediction: cross-sectional peer vote (any *other*
  // ticker's resolved historical analogs — never this ticker's own
  // history, and never an unresolved/live row) blended with the stock's
  // own recent momentum and the regime term, 70/20/10 as specified.
  const provisional: Provisional[] = universe.map((entry) => {
    const liveIndex = liveIndexByTicker.get(entry.ticker);
    if (liveIndex == null) return { entry, knn: null, predictedReturn20d: null };

    const candidateIndices: number[] = [];
    for (let idx = 0; idx < panel.rows.length; idx += 1) {
      const row = panel.rows[idx];
      if (row.ticker === entry.ticker) continue; // cross-sectional peers only
      if (row.offset < 20) continue; // must have a resolved, known outcome
      if (row.forwardReturn20d == null) continue;
      candidateIndices.push(idx);
    }

    const knn = candidateIndices.length >= 3 ? predictFromHistoricalAnalogs(liveIndex, panel, candidateIndices) : null;

    const ownMomentum = panel.rows[liveIndex].raw[0]; // ret20, fraction units
    const ownMomentumTerm = Number.isFinite(ownMomentum) ? ownMomentum : 0;

    const predictedReturn20d =
      knn && knn.predictedReturn20d != null ? 0.7 * knn.predictedReturn20d + 0.2 * ownMomentumTerm + 0.1 * regimeAdjustment : null;

    return { entry, knn, predictedReturn20d };
  });

  // 5) Dynamic BUY/SELL thresholds from *this run's* cross-sectional
  // distribution of predictions, rather than a hard-coded constant.
  const validPredictions = provisional.map((p) => p.predictedReturn20d).filter((v): v is number => v != null);
  const enoughForDynamicThresholds = validPredictions.length >= MIN_PREDICTIONS_FOR_DYNAMIC_THRESHOLDS;
  const buyThreshold = enoughForDynamicThresholds ? percentile(validPredictions, 70)! : FALLBACK_BUY_THRESHOLD;
  const sellThreshold = enoughForDynamicThresholds ? percentile(validPredictions, 30)! : FALLBACK_SELL_THRESHOLD;

  // 6) Assemble the public shape, re-annotating (not re-ranking) each
  // shown neighbor with a display-only fundamental-similarity context score.
  const results: GraphRecommendation[] = provisional.map(({ entry, knn, predictedReturn20d }) => {
    if (predictedReturn20d == null || knn == null) {
      return {
        ticker: entry.ticker,
        name: entry.name,
        market: entry.market,
        sector: entry.sector,
        industry: entry.industry,
        method: "GRAPH_KNN",
        signal: "NO_DATA",
        predictedReturn20d: null,
        confidence: 0,
        buyThreshold,
        sellThreshold,
        neighbors: [],
        modelMetrics,
        reasons: [
          entry.points.length < 30
            ? "Not enough historical price data to place this ticker in the peer graph."
            : "Fewer than 3 similar historical analogs were found above the similarity threshold."
        ],
        dataPoints: entry.points.length,
        timestamp: now,
        source: "Historical daily prices",
        disclaimer: GRAPH_DISCLAIMER
      };
    }

    const targetFundamental = fundamentalIndex.get(entry.ticker);

    const neighbors: GraphNeighbor[] = knn.neighbors.slice(0, NEIGHBORS_TO_SHOW).map((neighbor) => {
      const peerFundamental = fundamentalIndex.get(neighbor.ticker);
      const fundamentalSimilarity =
        targetFundamental?.hasData && peerFundamental?.hasData
          ? Number((((cosineSimilarity(targetFundamental.vector, peerFundamental.vector) + 1) / 2).toFixed(4)))
          : null;
      return { ...neighbor, fundamentalSimilarity };
    });

    const signal: GraphRecommendation["signal"] =
      predictedReturn20d >= buyThreshold ? "BUY" : predictedReturn20d <= sellThreshold ? "SELL" : "HOLD";

    return {
      ticker: entry.ticker,
      name: entry.name,
      market: entry.market,
      sector: entry.sector,
      industry: entry.industry,
      method: "GRAPH_KNN",
      signal,
      predictedReturn20d: Number(predictedReturn20d.toFixed(4)),
      confidence: Number(knn.confidence.toFixed(3)),
      buyThreshold: Number(buyThreshold.toFixed(4)),
      sellThreshold: Number(sellThreshold.toFixed(4)),
      neighbors,
      modelMetrics,
      reasons: buildReasons(entry, predictedReturn20d, knn, regimeAdjustment),
      dataPoints: entry.points.length,
      timestamp: now,
      source: "Historical daily prices",
      disclaimer: GRAPH_DISCLAIMER
    };
  });

  return { results, modelMetrics };
}
