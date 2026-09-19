import type { Market } from "../universe";
import {
  buildSeasonalityInsights,
  buildSeasonalProfile,
  buildSeasonalYoYPoints,
  medianAggregateSeries,
  monthName,
  seasonalGrowthEstimate,
  type PeriodValue,
  type SeasonalityInsights,
  type SeasonalProfile
} from "./seasonalAnalysis";
import type { FundamentalMetricSeries } from "./fundamentalsData";
import type { GrowthForecast, GrowthModelMetrics, GrowthSignal, MetricSeasonalSummary } from "./types";

/**
 * A fourth, independent recommender. Where the heuristic engine screens
 * on technicals/fundamentals, the graph engine predicts from similar
 * historical peer setups, and the ranking engine predicts sector-relative
 * return from a fitted regression, this engine asks a different
 * question entirely: "compared with this same calendar month in every
 * prior year available — for the company, its industry, and its
 * peers — is this name's growth trajectory currently favorable?"
 *
 * The core design choice, stated plainly: rather than anchoring on one
 * evaluation month and comparing it to the same month one and two years
 * back (three data points), this engine builds the *entire* seasonal
 * panel — every calendar month against every year the data covers — for
 * every metric, then targets the specific evaluation month from that
 * larger panel. That is strictly more information for the same tickers,
 * and it is what lets the engine tell a genuinely seasonal name (strong
 * every Q4, weak every summer) from one whose growth doesn't depend on
 * the calendar at all.
 *
 * Data-granularity honesty: revenue/earnings/EPS/free-cash-flow only
 * exist at annual cadence in Yahoo Finance's free API (see
 * fundamentalsData.ts), so their seasonal panels are necessarily
 * shallow (a handful of YoY points, mostly in one fiscal-year-end
 * month). Price has genuine multi-year *monthly* granularity, so the
 * "every month against every year" panel is deepest and most useful
 * there — which is also why price seasonality gets its own detailed
 * output (`priceSeasonalPoints` / `priceSeasonalByMonth`) rather than
 * being collapsed into a single number like the fundamentals are.
 */

export const GROWTH_DISCLAIMER =
  "Experimental seasonal, multi-metric growth forecast: compares the company's revenue, earnings, EPS, free cash flow, and price against every prior year available for the same calendar month (not just one anchor comparison), alongside an industry-median and peer read on price. Annual fundamentals are matched to a point-in-time-safe period using an assumed reporting lag, and EPS is approximated from current share count. Not personalized financial or investment advice — do your own research or consult a licensed advisor before trading.";

export type GrowthUniverseInput = {
  ticker: string;
  name?: string;
  market: Market;
  sector?: string;
  /** Monthly close price series, ideally spanning several years — see growthRecommendations.ts for how this is fetched (Yahoo's native "1mo" interval, not a manual daily resample). */
  monthlyPrices: PeriodValue[];
  fundamentals: FundamentalMetricSeries;
};

const MIN_MONTHLY_POINTS_FOR_PRICE_SEASONALITY = 15; // ~14 months minimum to have at least 2 same-calendar-month comparisons somewhere
const MIN_PREDICTIONS_FOR_DYNAMIC_THRESHOLDS = 5;
const FALLBACK_BUY_SCORE_THRESHOLD = 65;
const FALLBACK_SELL_SCORE_THRESHOLD = 35;

function toPeriod(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function nextYearPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return `${year + 1}-${String(month).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 2): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function summarize(profile: SeasonalProfile, evaluationMonth: number): MetricSeasonalSummary {
  const monthProfile = profile.byMonth[evaluationMonth - 1];
  const estimate = seasonalGrowthEstimate(profile, evaluationMonth);
  return {
    evaluatedMonthGrowthPercent: estimate != null ? round(estimate) : null,
    evaluatedMonthSampleCount: monthProfile?.sampleCount ?? 0,
    overallGrowthPercent: profile.overall.recencyWeightedGrowthPercent != null ? round(profile.overall.recencyWeightedGrowthPercent) : null,
    overallSampleCount: profile.overall.sampleCount,
    trendSlopePerYear: monthProfile?.trendSlopePerYear != null ? round(monthProfile.trendSlopePerYear) : null,
    consistency: round(monthProfile?.sampleCount ? monthProfile.consistency : profile.overall.consistency, 3)
  };
}

const EMPTY_SUMMARY: MetricSeasonalSummary = {
  evaluatedMonthGrowthPercent: null,
  evaluatedMonthSampleCount: 0,
  overallGrowthPercent: null,
  overallSampleCount: 0,
  trendSlopePerYear: null,
  consistency: 0
};

export const EMPTY_SEASONALITY_INSIGHTS: SeasonalityInsights = {
  bestMonth: null,
  worstMonth: null,
  mostVolatileMonth: null,
  mostConsistentMonth: null,
  seasonalSwingPercent: null,
  monthsWithEnoughData: 0,
  hasReliableSeasonality: false
};

/**
 * Walk-forward check for the price seasonal signal specifically — the
 * only metric here with enough monthly history to evaluate honestly.
 * At each of several past cutoffs, the seasonal profile is rebuilt using
 * only periods up to that cutoff (see `buildSeasonalProfile`'s
 * `asOfPeriod`), a prediction is made for the *next* occurrence of that
 * calendar month, and it's checked against what actually happened —
 * exactly the causal-ordering discipline the graph and ranking engines
 * already apply, adapted to a seasonal signal instead of a peer/
 * regression one.
 */
function evaluatePriceSeasonalWalkForward(monthlyPrices: PeriodValue[]): GrowthModelMetrics {
  const sorted = [...monthlyPrices].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  if (sorted.length < 30) return { hitRate: null, averageRealizedGrowthPercent: null, sampleCount: 0 };

  const byPeriod = new Map(sorted.map((row) => [row.period, row.value]));
  const allPoints = buildSeasonalYoYPoints(sorted);
  // Evaluate against the later ~40% of history, thinned to at most 12
  // checks, so this stays cheap per request while still covering
  // several different calendar months and years.
  const evaluationCandidates = allPoints.slice(Math.floor(allPoints.length * 0.6));
  const thinStep = Math.max(1, Math.floor(evaluationCandidates.length / 12));
  const evaluationPoints = evaluationCandidates.filter((_, i) => i % thinStep === 0);

  let evaluated = 0;
  let hits = 0;
  let realizedSum = 0;

  for (const target of evaluationPoints) {
    // "as of" the period right before this target's own current period,
    // so the profile used to predict it never sees the target itself.
    const asOfIndex = sorted.findIndex((row) => row.period === target.previousPeriod);
    if (asOfIndex < 0) continue;
    const asOfPeriod = sorted[asOfIndex].period;

    const profile = buildSeasonalProfile(sorted, asOfPeriod);
    const predicted = seasonalGrowthEstimate(profile, target.month);
    if (predicted == null) continue;

    const actual = target.growthPercent;
    const predictedDirection = predicted > 0 ? 1 : -1;
    const actualDirection = actual > 0 ? 1 : -1;
    if (predictedDirection === actualDirection) hits += 1;
    realizedSum += actual;
    evaluated += 1;
  }

  return {
    hitRate: evaluated > 0 ? hits / evaluated : null,
    averageRealizedGrowthPercent: evaluated > 0 ? round(realizedSum / evaluated) : null,
    sampleCount: evaluated
  };
}

function buildReasons(
  revenue: MetricSeasonalSummary,
  earnings: MetricSeasonalSummary,
  eps: MetricSeasonalSummary,
  fcf: MetricSeasonalSummary,
  price: MetricSeasonalSummary,
  industryPrice: MetricSeasonalSummary,
  peerAveragePrice: MetricSeasonalSummary,
  relativeGrowth: number,
  metrics: GrowthModelMetrics,
  seasonality: SeasonalityInsights,
  evaluationMonth: number
): string[] {
  const reasons: string[] = [];

  if (revenue.evaluatedMonthGrowthPercent != null) {
    reasons.push(
      `Revenue seasonal growth for this period: ${revenue.evaluatedMonthGrowthPercent}% (${revenue.evaluatedMonthSampleCount} comparable year${revenue.evaluatedMonthSampleCount === 1 ? "" : "s"}).`
    );
  }
  if (earnings.evaluatedMonthGrowthPercent != null) {
    reasons.push(`Earnings seasonal growth for this period: ${earnings.evaluatedMonthGrowthPercent}%.`);
  }
  if (eps.evaluatedMonthGrowthPercent != null) {
    reasons.push(`EPS seasonal growth (approximate, current share count applied historically): ${eps.evaluatedMonthGrowthPercent}%.`);
  }
  if (fcf.evaluatedMonthGrowthPercent != null) {
    reasons.push(`Free cash flow seasonal growth: ${fcf.evaluatedMonthGrowthPercent}%.`);
  }
  if (price.evaluatedMonthGrowthPercent != null) {
    reasons.push(
      `Price has averaged ${price.evaluatedMonthGrowthPercent}% growth in this specific calendar month across ${price.evaluatedMonthSampleCount} prior year${price.evaluatedMonthSampleCount === 1 ? "" : "s"} (consistency ${Math.round(price.consistency * 100)}%).`
    );
  }
  if (price.trendSlopePerYear != null) {
    reasons.push(
      price.trendSlopePerYear > 0
        ? "This calendar month's price growth has been accelerating year over year."
        : "This calendar month's price growth has been decelerating year over year."
    );
  }

  // "In which months does this stock see the most ups and downs" —
  // answered directly, from the full 12-month panel rather than just the
  // one month being evaluated.
  if (seasonality.bestMonth && seasonality.worstMonth) {
    reasons.push(
      `Historically strongest calendar month: ${seasonality.bestMonth.monthName} (${seasonality.bestMonth.meanGrowthPercent > 0 ? "+" : ""}${round(seasonality.bestMonth.meanGrowthPercent)}%, ${seasonality.bestMonth.sampleCount}yr). Weakest: ${seasonality.worstMonth.monthName} (${round(seasonality.worstMonth.meanGrowthPercent)}%, ${seasonality.worstMonth.sampleCount}yr).`
    );
  }
  if (seasonality.mostVolatileMonth) {
    reasons.push(
      `Most volatile calendar month (biggest swings either direction): ${seasonality.mostVolatileMonth.monthName} (σ ${seasonality.mostVolatileMonth.stdevGrowthPercent != null ? round(seasonality.mostVolatileMonth.stdevGrowthPercent) : "N/A"}%).`
    );
  }
  if (seasonality.bestMonth?.month === evaluationMonth) {
    reasons.push(`The month being evaluated (${monthName(evaluationMonth)}) has historically been this stock's strongest calendar month — a seasonal tailwind, if the pattern holds.`);
  } else if (seasonality.worstMonth?.month === evaluationMonth) {
    reasons.push(`The month being evaluated (${monthName(evaluationMonth)}) has historically been this stock's weakest calendar month — a seasonal headwind, if the pattern holds.`);
  }
  if (seasonality.bestMonth && !seasonality.hasReliableSeasonality) {
    reasons.push("None of the individual calendar months clear a basic significance bar yet — treat month-by-month differences as suggestive, not proven.");
  }

  if (industryPrice.evaluatedMonthGrowthPercent != null) {
    reasons.push(`Industry-median price seasonal growth for this period: ${industryPrice.evaluatedMonthGrowthPercent}%.`);
  }
  if (relativeGrowth > 0) {
    reasons.push(`The company is seasonally outgrowing its industry by approximately ${round(relativeGrowth)} percentage points.`);
  } else if (relativeGrowth < 0) {
    reasons.push(`The company is seasonally underperforming its industry by approximately ${round(Math.abs(relativeGrowth))} percentage points.`);
  }
  if (peerAveragePrice.evaluatedMonthGrowthPercent != null) {
    reasons.push(`Peer average seasonal price growth for this period: ${peerAveragePrice.evaluatedMonthGrowthPercent}%.`);
  }
  if (metrics.sampleCount > 0 && metrics.hitRate != null) {
    reasons.push(`Walk-forward check on price seasonality: ${Math.round(metrics.hitRate * 100)}% directional hit rate over ${metrics.sampleCount} historical evaluations.`);
  }

  return reasons.slice(0, 10);
}

export type GrowthBuildResult = {
  forecast: GrowthForecast;
  rawScore: number;
};

/**
 * Builds one ticker's forecast. `peers` should be same-sector universe
 * entries (their monthly price series only — see the module-level
 * comment on why peer/industry fundamentals aren't fetched per request).
 * `evaluationDate` anchors both which calendar month is being targeted
 * and (via each series' own periods) what's causally available.
 */
export function buildGrowthForecast(
  target: GrowthUniverseInput,
  peers: GrowthUniverseInput[],
  evaluationDate: Date
): GrowthBuildResult {
  const now = new Date().toISOString();
  const evaluatedPeriod = toPeriod(evaluationDate);
  const evaluationMonth = evaluationDate.getMonth() + 1;
  const forecastPeriod = nextYearPeriod(evaluatedPeriod);

  const revenueProfile = buildSeasonalProfile(target.fundamentals.revenue, evaluatedPeriod);
  const earningsProfile = buildSeasonalProfile(target.fundamentals.netIncome, evaluatedPeriod);
  const epsProfile = buildSeasonalProfile(target.fundamentals.eps, evaluatedPeriod);
  const fcfProfile = buildSeasonalProfile(target.fundamentals.freeCashFlow, evaluatedPeriod);

  const hasEnoughPriceHistory = target.monthlyPrices.length >= MIN_MONTHLY_POINTS_FOR_PRICE_SEASONALITY;
  const priceProfile = hasEnoughPriceHistory ? buildSeasonalProfile(target.monthlyPrices, evaluatedPeriod) : null;

  const revenue = summarize(revenueProfile, evaluationMonth);
  const earnings = summarize(earningsProfile, evaluationMonth);
  const eps = summarize(epsProfile, evaluationMonth);
  const freeCashFlow = summarize(fcfProfile, evaluationMonth);
  const price = priceProfile ? summarize(priceProfile, evaluationMonth) : EMPTY_SUMMARY;
  const priceSeasonality = priceProfile ? buildSeasonalityInsights(priceProfile.byMonth) : EMPTY_SEASONALITY_INSIGHTS;

  // Industry (median-aggregated peer prices) and individual peer average —
  // price-only, deliberately: fetching full annual fundamentals for every
  // peer on every request would multiply Yahoo Finance call volume across
  // an entire sector for a single ticker's page, the same
  // rate-limit-consciousness the graph and ranking engines already apply.
  const peerSeriesList = peers.map((p) => p.monthlyPrices).filter((s) => s.length >= MIN_MONTHLY_POINTS_FOR_PRICE_SEASONALITY);
  const industrySeries = medianAggregateSeries(peerSeriesList);
  const industryProfile = industrySeries.length >= MIN_MONTHLY_POINTS_FOR_PRICE_SEASONALITY ? buildSeasonalProfile(industrySeries, evaluatedPeriod) : null;
  const industryPrice = industryProfile ? summarize(industryProfile, evaluationMonth) : EMPTY_SUMMARY;

  const peerEvaluatedGrowths = peerSeriesList
    .map((series) => seasonalGrowthEstimate(buildSeasonalProfile(series, evaluatedPeriod), evaluationMonth))
    .filter((v): v is number => v != null);
  const peerAverageGrowthPercent = peerEvaluatedGrowths.length
    ? round(peerEvaluatedGrowths.reduce((a, b) => a + b, 0) / peerEvaluatedGrowths.length)
    : null;
  const peerAveragePrice: MetricSeasonalSummary = {
    ...EMPTY_SUMMARY,
    evaluatedMonthGrowthPercent: peerAverageGrowthPercent,
    evaluatedMonthSampleCount: peerEvaluatedGrowths.length
  };

  const modelMetrics = priceProfile
    ? evaluatePriceSeasonalWalkForward(target.monthlyPrices)
    : { hitRate: null, averageRealizedGrowthPercent: null, sampleCount: 0 };

  const dataPoints = target.monthlyPrices.length + revenueProfile.points.length + earningsProfile.points.length + fcfProfile.points.length;

  const noUsableData =
    revenue.evaluatedMonthGrowthPercent == null &&
    earnings.evaluatedMonthGrowthPercent == null &&
    eps.evaluatedMonthGrowthPercent == null &&
    freeCashFlow.evaluatedMonthGrowthPercent == null &&
    price.evaluatedMonthGrowthPercent == null;

  if (noUsableData) {
    const forecast: GrowthForecast = {
      ticker: target.ticker,
      name: target.name,
      market: target.market,
      sector: target.sector,
      method: "SEASONAL_GROWTH",
      evaluatedPeriod,
      forecastPeriod,
      signal: "NO_DATA",
      score: 0,
      confidence: 0,
      predictedGrowthPercent: null,
      buyThreshold: null,
      sellThreshold: null,
      revenue,
      earnings,
      eps,
      freeCashFlow,
      price,
      industryPrice,
      peerAveragePrice,
      priceSeasonalPoints: [],
      priceSeasonalByMonth: [],
      priceSeasonality: EMPTY_SEASONALITY_INSIGHTS,
      modelMetrics,
      reasons: ["Not enough year-over-year history across price and fundamentals to build a seasonal forecast for this ticker."],
      dataPoints,
      timestamp: now,
      source: "Historical annual fundamentals + monthly prices",
      disclaimer: GROWTH_DISCLAIMER
    };
    return { forecast, rawScore: 0 };
  }

  // Multi-metric fundamental blend, per the design note this engine
  // follows: revenue 30% / earnings 30% / EPS 20% / free cash flow 20%.
  // Missing metrics are dropped and the remaining weights renormalized
  // rather than silently treated as 0% growth.
  const fundamentalTerms: Array<{ value: number; weight: number }> = [];
  if (revenue.evaluatedMonthGrowthPercent != null) fundamentalTerms.push({ value: revenue.evaluatedMonthGrowthPercent, weight: 0.3 });
  if (earnings.evaluatedMonthGrowthPercent != null) fundamentalTerms.push({ value: earnings.evaluatedMonthGrowthPercent, weight: 0.3 });
  if (eps.evaluatedMonthGrowthPercent != null) fundamentalTerms.push({ value: eps.evaluatedMonthGrowthPercent, weight: 0.2 });
  if (freeCashFlow.evaluatedMonthGrowthPercent != null) fundamentalTerms.push({ value: freeCashFlow.evaluatedMonthGrowthPercent, weight: 0.2 });
  const fundamentalWeightSum = fundamentalTerms.reduce((sum, t) => sum + t.weight, 0);
  const fundamentalGrowthScore =
    fundamentalWeightSum > 0 ? fundamentalTerms.reduce((sum, t) => sum + t.value * t.weight, 0) / fundamentalWeightSum : null;

  const priceMomentumGrowth = price.evaluatedMonthGrowthPercent;
  const peerIndustryGrowth =
    industryPrice.evaluatedMonthGrowthPercent != null && peerAverageGrowthPercent != null
      ? (industryPrice.evaluatedMonthGrowthPercent + peerAverageGrowthPercent) / 2
      : industryPrice.evaluatedMonthGrowthPercent ?? peerAverageGrowthPercent;

  // Final blend, per the design note: fundamentals 70% / price momentum
  // 20% / peer+industry 10%, again renormalized over whichever
  // components are actually available for this ticker.
  const finalTerms: Array<{ value: number; weight: number }> = [];
  if (fundamentalGrowthScore != null) finalTerms.push({ value: fundamentalGrowthScore, weight: 0.7 });
  if (priceMomentumGrowth != null) finalTerms.push({ value: priceMomentumGrowth, weight: 0.2 });
  if (peerIndustryGrowth != null) finalTerms.push({ value: peerIndustryGrowth, weight: 0.1 });
  const finalWeightSum = finalTerms.reduce((sum, t) => sum + t.weight, 0);
  const predictedGrowthPercent = finalWeightSum > 0 ? finalTerms.reduce((sum, t) => sum + t.value * t.weight, 0) / finalWeightSum : 0;

  const relativeGrowth =
    priceMomentumGrowth != null && industryPrice.evaluatedMonthGrowthPercent != null
      ? priceMomentumGrowth - industryPrice.evaluatedMonthGrowthPercent
      : 0;

  const accelerationBonus = price.trendSlopePerYear != null ? clamp(price.trendSlopePerYear, -10, 10) : 0;

  const rawScore = 50 + predictedGrowthPercent * 1.5 + relativeGrowth * 0.75 + accelerationBonus * 0.5;
  const score = Math.round(clamp(rawScore, 0, 100));

  // Confidence: how many of the five metrics actually had data, how deep
  // the price seasonal panel is (more calendar-month/year pairs = more
  // trustworthy), and the evaluated month's own consistency — then a
  // small penalty when no individual month's pattern clears the
  // significance bar, since that means the "best/worst month" story is
  // more likely noise than a durable calendar effect.
  const availableMetrics = [revenue, earnings, eps, freeCashFlow, price].filter((m) => m.evaluatedMonthGrowthPercent != null).length;
  const priceDepthScore = priceProfile ? Math.min(priceProfile.overall.sampleCount / 24, 1) : 0;
  const rawConfidence = (availableMetrics / 5) * 0.4 + priceDepthScore * 0.35 + (price.consistency ?? 0) * 0.25;
  const reliabilityMultiplier = priceProfile && !priceSeasonality.hasReliableSeasonality ? 0.9 : 1;
  const confidence = round(clamp(rawConfidence * reliabilityMultiplier, 0, 1), 3);

  const forecast: GrowthForecast = {
    ticker: target.ticker,
    name: target.name,
    market: target.market,
    sector: target.sector,
    method: "SEASONAL_GROWTH",
    evaluatedPeriod,
    forecastPeriod,
    signal: "HOLD", // placeholder — the batch caller assigns the real signal from cross-sectional score thresholds, see growthRecommendations.ts
    score,
    confidence,
    predictedGrowthPercent: round(predictedGrowthPercent),
    buyThreshold: null,
    sellThreshold: null,
    revenue,
    earnings,
    eps,
    freeCashFlow,
    price,
    industryPrice,
    peerAveragePrice,
    priceSeasonalPoints: priceProfile?.points ?? [],
    priceSeasonalByMonth: priceProfile?.byMonth ?? [],
    priceSeasonality,
    modelMetrics,
    reasons: buildReasons(
      revenue,
      earnings,
      eps,
      freeCashFlow,
      price,
      industryPrice,
      peerAveragePrice,
      relativeGrowth,
      modelMetrics,
      priceSeasonality,
      evaluationMonth
    ),
    dataPoints,
    timestamp: now,
    source: "Historical annual fundamentals + monthly prices",
    disclaimer: GROWTH_DISCLAIMER
  };

  return { forecast, rawScore: score };
}

/**
 * Assigns BUY/HOLD/SELL from the cross-sectional distribution of raw
 * scores in this run, the same dynamic-threshold approach the graph and
 * ranking engines use, rather than the fixed 65/35 score cutoff. Falls
 * back to the fixed cutoff when there aren't enough scored names in this
 * run to make a percentile meaningful (e.g. the single-ticker endpoint).
 */
export function assignGrowthSignals(built: GrowthBuildResult[]): GrowthForecast[] {
  const validScores = built.filter((b) => b.forecast.signal !== "NO_DATA").map((b) => b.rawScore);
  const enoughForDynamicThresholds = validScores.length >= MIN_PREDICTIONS_FOR_DYNAMIC_THRESHOLDS;

  const sorted = [...validScores].sort((a, b) => a - b);
  const percentile = (p: number): number => {
    if (sorted.length === 0) return p >= 50 ? FALLBACK_BUY_SCORE_THRESHOLD : FALLBACK_SELL_SCORE_THRESHOLD;
    const rank = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sorted[lower];
    const weight = rank - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  };

  const buyThreshold = enoughForDynamicThresholds ? percentile(70) : FALLBACK_BUY_SCORE_THRESHOLD;
  const sellThreshold = enoughForDynamicThresholds ? percentile(30) : FALLBACK_SELL_SCORE_THRESHOLD;

  return built.map(({ forecast, rawScore }) => {
    if (forecast.signal === "NO_DATA") return forecast;
    const signal: GrowthSignal = rawScore >= buyThreshold ? "BUY" : rawScore <= sellThreshold ? "SELL" : "HOLD";
    return { ...forecast, signal, buyThreshold: round(buyThreshold), sellThreshold: round(sellThreshold) };
  });
}
