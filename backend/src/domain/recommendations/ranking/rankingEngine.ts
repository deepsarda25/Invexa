import type { OhlcPoint } from "../../market/adapter";
import type { Market } from "../universe";
import { buildPriceFeatureRows, fillRelativeStrength } from "../graph/features";
import { crossSectionalZScores, percentile } from "../graph/normalize";
import { defaultEvaluationOffsets } from "../graph/walkForward";
import { PRICE_FEATURE_NAMES, type PriceFeatureRow } from "../graph/types";
import { pearsonCorrelation, predictOne, sigmoid, trainRidgeRegression, type RidgeModel } from "./model";
import type { RankingFeatureContribution, RankingModelMetrics, RankingRecommendation, RankingSignal } from "./types";

/**
 * A third, independent recommender: treats the problem as time-series
 * forecasting and cross-sectional ranking rather than screening rules or
 * peer similarity. The target is explicit — "given data available today,
 * predict this stock's 20-session return relative to its own sector" —
 * and the model that predicts it is a real, fitted regression, walk-
 * forward validated exactly like the graph engine's k-NN, not a
 * dressed-up heuristic.
 *
 * Features are the same seven point-in-time price/return/volatility
 * features the graph engine already builds (see graph/features.ts) —
 * reused rather than re-derived so the two models are judged on the same
 * evidence and never silently drift out of sync. Fundamentals are
 * deliberately excluded from training for the identical reason the graph
 * engine excludes them: Yahoo Finance's free API only exposes *current*
 * fundamentals, with no point-in-time history, so using today's P/E to
 * "explain" a return from months ago would be look-ahead bias baked into
 * a model instead of a scoring formula. Fundamentals can re-enter once
 * this app has a point-in-time fundamentals source — that's a data
 * problem, not a modeling one.
 */

export const RANKING_DISCLAIMER =
  "Supervised cross-sectional ranking model: ridge-regularized linear regression trained on point-in-time price/momentum/volatility features to predict 20-session return relative to sector. modelMetrics comes from a real walk-forward check (the model is retrained at each evaluation point using only data that would have been available at the time) over the same historical window the production model is fit from — not yet an independent, multi-regime, out-of-sample track record, and not personalized financial or investment advice.";

export type RankingUniverseInput = {
  ticker: string;
  name?: string;
  market: Market;
  sector?: string;
  industry?: string;
  points: OhlcPoint[];
};

export type RankingBuildResult = {
  results: RankingRecommendation[];
  modelMetrics: RankingModelMetrics;
};

/** Minimum resolved, labeled rows required before a regression is trusted over a NO_DATA/skip result. */
const MIN_TRAIN_ROWS = 40;
const MIN_PREDICTIONS_FOR_DYNAMIC_THRESHOLDS = 5;
const FALLBACK_BUY_THRESHOLD = 0.025;
const FALLBACK_SELL_THRESHOLD = -0.025;
const VOLATILITY_FEATURE_INDEX = PRICE_FEATURE_NAMES.indexOf("volatility20");

/**
 * Cross-sectional regression target: each row's realized 20-session
 * forward return, minus the mean forward return of its *own sector* at
 * the *same offset* (falling back to the whole-universe mean when the
 * sector has too few peers at that offset to be a meaningful baseline).
 * This is what keeps the model from just recommending everything when
 * the whole market — or the whole sector — is rising; see the design
 * note this engine follows for why sector-relative return, not raw
 * return, is the right label for a ranking model.
 */
function sectorRelativeTargets(rows: PriceFeatureRow[]): Array<number | null> {
  const MIN_SECTOR_PEERS = 3;
  const sectorKey = (offset: number, sector?: string) => `${offset}::${sector ?? "Unclassified"}`;
  const offsetKey = (offset: number) => `${offset}`;

  const sectorSum = new Map<string, number>();
  const sectorCount = new Map<string, number>();
  const overallSum = new Map<string, number>();
  const overallCount = new Map<string, number>();

  for (const row of rows) {
    if (row.forwardReturn20d == null) continue;
    const sKey = sectorKey(row.offset, row.sector);
    sectorSum.set(sKey, (sectorSum.get(sKey) ?? 0) + row.forwardReturn20d);
    sectorCount.set(sKey, (sectorCount.get(sKey) ?? 0) + 1);
    const oKey = offsetKey(row.offset);
    overallSum.set(oKey, (overallSum.get(oKey) ?? 0) + row.forwardReturn20d);
    overallCount.set(oKey, (overallCount.get(oKey) ?? 0) + 1);
  }

  return rows.map((row) => {
    if (row.forwardReturn20d == null) return null;
    const sKey = sectorKey(row.offset, row.sector);
    const sCount = sectorCount.get(sKey) ?? 0;
    if (sCount >= MIN_SECTOR_PEERS) {
      const sectorMean = (sectorSum.get(sKey) ?? 0) / sCount;
      return row.forwardReturn20d - sectorMean;
    }
    const oKey = offsetKey(row.offset);
    const oCount = overallCount.get(oKey) ?? 0;
    if (oCount === 0) return null;
    const overallMean = (overallSum.get(oKey) ?? 0) / oCount;
    return row.forwardReturn20d - overallMean;
  });
}

/**
 * Real (if approximate) walk-forward validation for the regression,
 * mirroring the graph engine's causal-ordering rule exactly: when
 * evaluating rows at `targetOffset`, only rows whose 20-session forward
 * window has already resolved by that point (offset >= targetOffset +
 * 20) are eligible to train on. A fresh model is fit at every evaluation
 * point from only that point's legitimately-available history — nothing
 * here reuses the final production model to grade itself.
 */
function evaluateWalkForward(
  rows: PriceFeatureRow[],
  vectors: number[][],
  targets: Array<number | null>,
  evaluationOffsets: number[]
): RankingModelMetrics {
  const ROUND_TRIP_COST = 0.002; // 20 bps assumed, crude and constant — not calibrated per market/broker
  const BUY_PROXY_THRESHOLD = 0.015; // a fixed stand-in for "would have been a BUY" during evaluation, since the dynamic percentile threshold only makes sense on a live cross-section

  let evaluated = 0;
  let hits = 0;
  let returnSum = 0;
  const buyReturns: number[] = [];
  const allPredicted: number[] = [];
  const allActual: number[] = [];

  const rowIndicesByOffset = new Map<number, number[]>();
  rows.forEach((row, idx) => {
    const list = rowIndicesByOffset.get(row.offset) ?? [];
    list.push(idx);
    rowIndicesByOffset.set(row.offset, list);
  });

  for (const targetOffset of evaluationOffsets) {
    const targetIndices = (rowIndicesByOffset.get(targetOffset) ?? []).filter((idx) => targets[idx] != null);
    if (targetIndices.length === 0) continue;

    const trainIndices: number[] = [];
    for (let idx = 0; idx < rows.length; idx += 1) {
      if (targets[idx] == null) continue;
      if (rows[idx].offset >= targetOffset + 20) trainIndices.push(idx);
    }
    if (trainIndices.length < MIN_TRAIN_ROWS) continue;

    const model = trainRidgeRegression(
      trainIndices.map((idx) => vectors[idx]),
      trainIndices.map((idx) => targets[idx]!)
    );

    for (const idx of targetIndices) {
      const predicted = predictOne(model, vectors[idx]);
      const actual = targets[idx]!;
      allPredicted.push(predicted);
      allActual.push(actual);

      const predictedDirection = predicted > 0 ? 1 : -1;
      const actualDirection = actual > 0 ? 1 : -1;
      if (predictedDirection === actualDirection) hits += 1;
      returnSum += actual;
      evaluated += 1;

      if (predicted >= BUY_PROXY_THRESHOLD) buyReturns.push(actual - ROUND_TRIP_COST);
    }
  }

  return {
    hitRate: evaluated > 0 ? hits / evaluated : null,
    correlation: pearsonCorrelation(allPredicted, allActual),
    averageReturn: evaluated > 0 ? returnSum / evaluated : null,
    netAverageReturn: buyReturns.length > 0 ? buyReturns.reduce((a, b) => a + b, 0) / buyReturns.length : null,
    worstBuyReturn: buyReturns.length > 0 ? Math.min(...buyReturns) : null,
    sampleCount: evaluated
  };
}

function buildFeatureContributions(vector: number[], model: RidgeModel): RankingFeatureContribution[] {
  return PRICE_FEATURE_NAMES.map((name, i) => ({
    feature: name,
    value: Number((vector[i] ?? 0).toFixed(4)),
    weight: Number((model.weights[i] ?? 0).toFixed(4)),
    contribution: Number(((vector[i] ?? 0) * (model.weights[i] ?? 0)).toFixed(4))
  })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

function buildReasons(
  predicted: number,
  probability: number,
  riskAdjustedScore: number,
  metrics: RankingModelMetrics,
  contributions: RankingFeatureContribution[]
): string[] {
  const reasons: string[] = [];

  reasons.push(
    `Ridge-regularized linear regression trained on ${PRICE_FEATURE_NAMES.length} point-in-time momentum/volatility/trend features to predict 20-session return vs. sector.`
  );

  if (metrics.sampleCount > 0) {
    const hitRatePart = metrics.hitRate != null ? `${Math.round(metrics.hitRate * 100)}% directional hit rate` : "hit rate unavailable";
    const correlationPart = metrics.correlation != null ? `, ${metrics.correlation.toFixed(2)} predicted-vs-realized correlation` : "";
    reasons.push(`Walk-forward validation: ${hitRatePart}${correlationPart} over ${metrics.sampleCount} evaluated cases.`);
  } else {
    reasons.push("Not enough historical panel data yet to run a walk-forward check for this universe.");
  }

  const topDrivers = contributions.filter((c) => Math.abs(c.contribution) > 0.0005).slice(0, 3);
  if (topDrivers.length > 0) {
    reasons.push(
      `Largest drivers: ${topDrivers.map((c) => `${c.feature} (${c.contribution >= 0 ? "+" : ""}${c.contribution.toFixed(3)})`).join(", ")}.`
    );
  }

  reasons.push(`Predicted 20-session return vs. sector: ${(predicted * 100).toFixed(1)}%.`);
  reasons.push(`Modeled probability of beating sector peers over 20 sessions: ${Math.round(probability * 100)}%.`);
  reasons.push(`Risk-adjusted score (predicted return ÷ annualized volatility): ${riskAdjustedScore.toFixed(2)}.`);

  return reasons.slice(0, 6);
}

export function buildRankingRecommendations(universe: RankingUniverseInput[]): RankingBuildResult {
  const now = new Date().toISOString();

  // 1) Same point-in-time price-feature panel the graph engine builds,
  // reused rather than recomputed so both models are trained/evaluated
  // on identical evidence.
  const allRows = universe.flatMap((entry) => buildPriceFeatureRows(entry, entry.points));
  fillRelativeStrength(allRows);

  // 2) Regression target and cross-sectional normalization of the raw
  // feature panel (whole panel at once — see normalize.ts for why).
  const targets = sectorRelativeTargets(allRows);
  const vectors = crossSectionalZScores(allRows.map((row) => row.raw));

  // 3) Walk-forward validate: retrain at each evaluation offset from
  // only causally-available data, then check the held-out predictions.
  const maxOffset = allRows.reduce((max, row) => Math.max(max, row.offset), 0);
  const availableOffsets = allRows.map((row) => row.offset);
  const evaluationOffsets = defaultEvaluationOffsets(availableOffsets, maxOffset);
  const modelMetrics = evaluateWalkForward(allRows, vectors, targets, evaluationOffsets);

  // 4) Production model: trained once on every resolved, labeled row in
  // the panel, then applied to each ticker's live (offset 0) feature
  // vector below.
  const trainIndices: number[] = [];
  allRows.forEach((row, idx) => {
    if (targets[idx] != null) trainIndices.push(idx);
  });
  const productionModel: RidgeModel | null =
    trainIndices.length >= MIN_TRAIN_ROWS
      ? trainRidgeRegression(
          trainIndices.map((idx) => vectors[idx]),
          trainIndices.map((idx) => targets[idx]!)
        )
      : null;

  const liveIndexByTicker = new Map<string, number>();
  allRows.forEach((row, idx) => {
    if (row.offset === 0) liveIndexByTicker.set(row.ticker, idx);
  });

  type Provisional = { entry: RankingUniverseInput; predicted: number | null; liveIndex: number | null };

  const provisional: Provisional[] = universe.map((entry) => {
    const liveIndex = liveIndexByTicker.get(entry.ticker) ?? null;
    if (liveIndex == null || productionModel == null) return { entry, predicted: null, liveIndex };
    return { entry, predicted: predictOne(productionModel, vectors[liveIndex]), liveIndex };
  });

  // 5) Dynamic BUY/SELL thresholds from this run's cross-sectional
  // distribution of predictions, same rationale as the graph engine —
  // "top 30% of today's predictions" is a more honest bar than a
  // hard-coded constant that never adapts to regime.
  const validPredictions = provisional.map((p) => p.predicted).filter((v): v is number => v != null);
  const enoughForDynamicThresholds = validPredictions.length >= MIN_PREDICTIONS_FOR_DYNAMIC_THRESHOLDS;
  const buyThreshold = enoughForDynamicThresholds ? percentile(validPredictions, 70)! : FALLBACK_BUY_THRESHOLD;
  const sellThreshold = enoughForDynamicThresholds ? percentile(validPredictions, 30)! : FALLBACK_SELL_THRESHOLD;

  const residualScale = productionModel && productionModel.residualStd > 1e-6 ? productionModel.residualStd : 0.05;

  const results: RankingRecommendation[] = provisional.map(({ entry, predicted, liveIndex }) => {
    if (predicted == null || liveIndex == null || productionModel == null) {
      return {
        ticker: entry.ticker,
        name: entry.name,
        market: entry.market,
        sector: entry.sector,
        industry: entry.industry,
        method: "SUPERVISED_RANKING",
        signal: "NO_DATA",
        predictedSectorRelativeReturn20d: null,
        probabilityOfOutperformance: null,
        riskAdjustedScore: null,
        confidence: 0,
        buyThreshold,
        sellThreshold,
        featureContributions: [],
        modelMetrics,
        reasons: [
          entry.points.length < 30
            ? "Not enough historical price data to build model features for this ticker."
            : "Not enough resolved historical samples across the universe yet to fit a production model."
        ],
        dataPoints: entry.points.length,
        timestamp: now,
        source: "Historical daily prices",
        disclaimer: RANKING_DISCLAIMER
      };
    }

    const liveVector = vectors[liveIndex];
    const probability = sigmoid(predicted / residualScale);

    const volatilityRaw = VOLATILITY_FEATURE_INDEX >= 0 ? allRows[liveIndex].raw[VOLATILITY_FEATURE_INDEX] : NaN;
    const volatilityFraction = Number.isFinite(volatilityRaw) ? Math.max(volatilityRaw / 100, 0.02) : 0.2;
    const riskAdjustedScore = predicted / volatilityFraction;

    const signal: RankingSignal = predicted >= buyThreshold ? "BUY" : predicted <= sellThreshold ? "SELL" : "HOLD";

    const contributions = buildFeatureContributions(liveVector, productionModel);
    const confidence = Math.max(
      0,
      Math.min(
        1,
        (productionModel.trainCorrelation != null ? Math.abs(productionModel.trainCorrelation) : 0) * 0.4 +
          Math.min(entry.points.length / 252, 1) * 0.3 +
          Math.abs(probability - 0.5) * 2 * 0.3
      )
    );

    return {
      ticker: entry.ticker,
      name: entry.name,
      market: entry.market,
      sector: entry.sector,
      industry: entry.industry,
      method: "SUPERVISED_RANKING",
      signal,
      predictedSectorRelativeReturn20d: Number(predicted.toFixed(4)),
      probabilityOfOutperformance: Number(probability.toFixed(3)),
      riskAdjustedScore: Number(riskAdjustedScore.toFixed(3)),
      confidence: Number(confidence.toFixed(3)),
      buyThreshold: Number(buyThreshold.toFixed(4)),
      sellThreshold: Number(sellThreshold.toFixed(4)),
      featureContributions: contributions.slice(0, 5),
      modelMetrics,
      reasons: buildReasons(predicted, probability, riskAdjustedScore, modelMetrics, contributions),
      dataPoints: entry.points.length,
      timestamp: now,
      source: "Historical daily prices",
      disclaimer: RANKING_DISCLAIMER
    };
  });

  return { results, modelMetrics };
}
