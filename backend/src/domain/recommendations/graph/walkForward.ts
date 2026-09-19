import { predictFromHistoricalAnalogs, type NormalizedPanel } from "./knnPredictor";
import type { GraphModelMetrics } from "./types";

/**
 * Real (if approximate) walk-forward validation, computed from the same
 * price history the live model uses — no fabricated accuracy numbers.
 *
 * The panel is built once from ~400 days of OHLC per ticker, addressed by
 * `offset` = "sessions back from the most recent close" rather than a
 * calendar date (see types.ts). That gives a strict, checkable
 * no-look-ahead rule: when evaluating a row at `targetOffset`, only rows
 * whose *forward-return window has already resolved by that point* are
 * eligible peers — i.e. candidate offset ≥ targetOffset + 20. Nothing
 * whose outcome the target "couldn't have known yet" is used to predict
 * it.
 *
 * Caveat worth being upfront about: every row still comes from one
 * snapshot fetch (the same universe-wide price pull), so this validates
 * "does the KNN logic have predictive signal within the market regimes
 * covered by the last ~400 sessions," not "does it hold up across
 * independent, never-seen market regimes collected over calendar time."
 * The latter is the real bar for `HIGH` confidence in a production
 * model; see graphRecommendationEngine.ts / the feature doc for how the
 * app can accumulate genuinely out-of-sample days going forward.
 */
export function evaluateWalkForward(panel: NormalizedPanel, evaluationOffsets: number[]): GraphModelMetrics {
  const ROUND_TRIP_COST = 0.002; // 20 bps assumed, crude and constant — not calibrated per market/broker
  const BUY_PROXY_THRESHOLD = 0.02; // 2% predicted 20d return — a fixed stand-in for "would have been a BUY" during evaluation, since the *dynamic* percentile threshold is only meaningful on the live cross-section, not on an isolated historical target

  let evaluated = 0;
  let hits = 0;
  let returnSum = 0;
  const buyReturns: number[] = [];

  const rowsByOffset = new Map<number, number[]>();
  panel.rows.forEach((row, idx) => {
    const list = rowsByOffset.get(row.offset) ?? [];
    list.push(idx);
    rowsByOffset.set(row.offset, list);
  });

  for (const targetOffset of evaluationOffsets) {
    const targetIndices = (rowsByOffset.get(targetOffset) ?? []).filter((idx) => panel.rows[idx].forwardReturn20d != null);

    // Candidate pool shared across every target at this offset: anything
    // in the whole panel whose outcome had already resolved by
    // `targetOffset` (offset far enough in the past that offset - 20 is
    // still >= targetOffset).
    const candidateIndices: number[] = [];
    for (let idx = 0; idx < panel.rows.length; idx += 1) {
      const row = panel.rows[idx];
      if (row.forwardReturn20d == null) continue;
      if (row.offset >= targetOffset + 20) candidateIndices.push(idx);
    }

    if (candidateIndices.length < 3) continue;

    for (const targetIndex of targetIndices) {
      const eligibleCandidates = candidateIndices.filter((idx) => idx !== targetIndex);
      const prediction = predictFromHistoricalAnalogs(targetIndex, panel, eligibleCandidates);
      if (prediction.predictedReturn20d == null) continue;

      const actual = panel.rows[targetIndex].forwardReturn20d!;
      const predictedDirection = prediction.predictedReturn20d > 0 ? 1 : -1;
      const actualDirection = actual > 0 ? 1 : -1;

      if (predictedDirection === actualDirection) hits += 1;
      returnSum += actual;
      evaluated += 1;

      if (prediction.predictedReturn20d >= BUY_PROXY_THRESHOLD) {
        buyReturns.push(actual - ROUND_TRIP_COST);
      }
    }
  }

  return {
    hitRate: evaluated > 0 ? hits / evaluated : null,
    averageReturn: evaluated > 0 ? returnSum / evaluated : null,
    netAverageReturn: buyReturns.length > 0 ? buyReturns.reduce((a, b) => a + b, 0) / buyReturns.length : null,
    worstBuyReturn: buyReturns.length > 0 ? Math.min(...buyReturns) : null,
    sampleCount: evaluated
  };
}

/**
 * Picks which offsets to run the walk-forward check at, thinned from the
 * offsets that actually exist in the panel (features.ts builds the panel
 * on a step-3 grid — evaluating at arbitrary offsets that don't land on
 * that grid would silently match zero rows and look like "no data"
 * instead of a wiring bug).
 */
export function defaultEvaluationOffsets(availableOffsets: number[], maxOffset: number, thinTo = 5): number[] {
  const eligible = Array.from(new Set(availableOffsets))
    .filter((o) => o >= 20 && o <= maxOffset - 20)
    .sort((a, b) => a - b);
  return eligible.filter((_, i) => i % thinTo === 0);
}
