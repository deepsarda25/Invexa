import type { Market } from "../universe";

export type RankingSignal = "BUY" | "HOLD" | "SELL" | "NO_DATA";

export type RankingModelMetrics = {
  /** Fraction of walk-forward evaluations where predicted and realized direction of the sector-relative return agreed. */
  hitRate: number | null;
  /** Pearson correlation between predicted and realized sector-relative 20d returns, across every walk-forward evaluation. */
  correlation: number | null;
  /** Mean realized sector-relative 20d return across everything the model evaluated. */
  averageReturn: number | null;
  /** Mean realized sector-relative return of BUY-proxy calls, net of an assumed round-trip transaction cost. */
  netAverageReturn: number | null;
  /** Worst single realized sector-relative return among BUY-proxy calls in the evaluated sample. */
  worstBuyReturn: number | null;
  sampleCount: number;
};

export type RankingFeatureContribution = {
  feature: string;
  /** Cross-sectionally z-scored feature value used by the model. */
  value: number;
  weight: number;
  /** value * weight — this feature's share of the raw prediction, before the bias term. */
  contribution: number;
};

export type RankingRecommendation = {
  ticker: string;
  name?: string;
  market: Market;
  sector?: string;
  industry?: string;
  method: "SUPERVISED_RANKING";
  signal: RankingSignal;
  /** Predicted 20-session return relative to the stock's own sector (not an absolute price forecast). */
  predictedSectorRelativeReturn20d: number | null;
  /** 0..1 — calibrated from the production model's in-sample residual spread, not a frequentist guarantee. */
  probabilityOfOutperformance: number | null;
  /** predictedSectorRelativeReturn20d divided by the stock's own annualized volatility (as a fraction). */
  riskAdjustedScore: number | null;
  /** 0..1 */
  confidence: number;
  buyThreshold: number | null;
  sellThreshold: number | null;
  /** Top features driving this prediction, most influential first. */
  featureContributions: RankingFeatureContribution[];
  modelMetrics: RankingModelMetrics;
  reasons: string[];
  dataPoints: number;
  timestamp: string;
  source: string;
  disclaimer: string;
};
