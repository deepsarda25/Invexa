import type { Market } from "../universe";
import type { MonthlySeasonalProfile, SeasonalityInsights, SeasonalYoYPoint } from "./seasonalAnalysis";

export type GrowthSignal = "BUY" | "HOLD" | "SELL" | "NO_DATA";

export type GrowthModelMetrics = {
  /** Fraction of walk-forward evaluations where the price-seasonal signal's predicted direction matched the realized one. */
  hitRate: number | null;
  /** Pearson-style directional correlation isn't computed here (too few points per ticker to be meaningful); hitRate and averageReturn are the honest metrics available from a single ticker's own seasonal history. */
  averageRealizedGrowthPercent: number | null;
  sampleCount: number;
};

export type MetricSeasonalSummary = {
  /** Growth-% estimate for the specific calendar month being evaluated (seasonally targeted; see seasonalGrowthEstimate). */
  evaluatedMonthGrowthPercent: number | null;
  /** How many prior years of the *same calendar month* back this estimate, specifically. */
  evaluatedMonthSampleCount: number;
  /** Cross-month, recency-weighted growth signal — used as a fallback and as a broader "overall trajectory" cross-check. */
  overallGrowthPercent: number | null;
  overallSampleCount: number;
  trendSlopePerYear: number | null;
  consistency: number;
};

export type GrowthForecast = {
  ticker: string;
  name?: string;
  market: Market;
  /** Reuses the app's existing sector taxonomy as the industry grouping key (see universe.ts) — no separate industry classification is fetched for this engine. */
  sector?: string;
  method: "SEASONAL_GROWTH";
  evaluatedPeriod: string; // YYYY-MM
  forecastPeriod: string; // YYYY-MM, one year after evaluatedPeriod
  signal: GrowthSignal;
  score: number; // 0..100
  confidence: number; // 0..1
  predictedGrowthPercent: number | null;
  buyThreshold: number | null;
  sellThreshold: number | null;

  revenue: MetricSeasonalSummary;
  earnings: MetricSeasonalSummary;
  eps: MetricSeasonalSummary;
  freeCashFlow: MetricSeasonalSummary;
  price: MetricSeasonalSummary;
  industryPrice: MetricSeasonalSummary;
  peerAveragePrice: MetricSeasonalSummary;

  /** Every YoY point behind the company's own price seasonal profile — the full "every month vs every year" panel, for transparency/charting. */
  priceSeasonalPoints: SeasonalYoYPoint[];
  /** Per-calendar-month price seasonality (all 12 months), so a caller can see e.g. "this name is historically strong in Q4." */
  priceSeasonalByMonth: MonthlySeasonalProfile[];
  /** Directly answers "in which months does this stock see the most ups and downs": best/worst/most-volatile/most-consistent calendar month, from price history. */
  priceSeasonality: SeasonalityInsights;

  modelMetrics: GrowthModelMetrics;
  reasons: string[];
  dataPoints: number;
  timestamp: string;
  source: string;
  disclaimer: string;
};
