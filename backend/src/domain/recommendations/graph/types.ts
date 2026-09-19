import type { Market } from "../universe";

/**
 * Price-based feature order. Kept as a single source of truth so
 * normalize.ts / similarity.ts / features.ts never disagree about which
 * index means what.
 *
 *  ret20                  20-session return
 *  ret60                  60-session return
 *  ret120                 120-session return
 *  volatility20           annualized stdev of daily log returns (20d)
 *  maxDrawdown20120       max peak-to-trough drawdown over the trailing
 *                         ~120 sessions (negative number, 0 = no drawdown)
 *  distanceFrom52wHigh    (close - trailing 252-session high) / high
 *                         (negative or 0)
 *  relativeStrength20     ret20 minus the *cross-sectional* average
 *                         ret20 across the whole universe at the same
 *                         offset — how this name did versus "the tape"
 *                         at that point in time, not versus itself
 */
export const PRICE_FEATURE_NAMES = [
  "ret20",
  "ret60",
  "ret120",
  "volatility20",
  "maxDrawdown120",
  "distanceFrom52wHigh",
  "relativeStrength20"
] as const;

export type PriceFeatureName = (typeof PRICE_FEATURE_NAMES)[number];

export const FUNDAMENTAL_FEATURE_NAMES = [
  "peRatio",
  "priceToSales",
  "roe",
  "operatingMargin",
  "revenueGrowth",
  "earningsGrowth",
  "debtToEquity",
  "fcfYield"
] as const;

export type FundamentalFeatureName = (typeof FUNDAMENTAL_FEATURE_NAMES)[number];

export type FundamentalSnapshot = Record<FundamentalFeatureName, number | null>;

/**
 * A single row in the feature panel: one ticker, observed `offset`
 * trading sessions back from "now" (0 = today/live). `raw` always has
 * `PRICE_FEATURE_NAMES.length` entries, `NaN` where a feature could not
 * be computed (too little history for that window).
 *
 * `forwardReturn20d` is the realized close-to-close return from this
 * offset to 20 sessions later. It is `null` when that window hasn't
 * happened yet relative to `offset` (i.e. `offset < 20`) — those rows
 * exist only to be *targets*, never usable as training/peer evidence,
 * which is what keeps the walk-forward evaluation honest (see
 * walkForward.ts).
 */
export type PriceFeatureRow = {
  ticker: string;
  name?: string;
  market: Market;
  sector?: string;
  industry?: string;
  offset: number;
  raw: number[];
  forwardReturn20d: number | null;
};

export type GraphNeighbor = {
  ticker: string;
  name?: string;
  /** Combined price/return/sector/industry similarity (0..1) actually used to rank and weight this neighbor in the prediction. */
  similarity: number;
  /** How many sessions back this observation of the peer is from "now". 0 = the peer's current state. */
  offset: number;
  historicalForwardReturn20d: number | null;
  /**
   * Cosine similarity (0..1) of *current* fundamental profiles between
   * the target and this neighbor's ticker. Display/context only — it is
   * never part of the prediction (see features.ts's getFundamentalSnapshot
   * doc for why fundamentals can't safely enter the walk-forward-validated
   * historical panel). `null` when either side lacks fundamental data.
   */
  fundamentalSimilarity: number | null;
};

export type GraphSignal = "BUY" | "HOLD" | "SELL" | "NO_DATA";

export type GraphModelMetrics = {
  /** Fraction of walk-forward evaluations where predicted and realized direction agreed. */
  hitRate: number | null;
  /** Mean realized 20d forward return of everything the model evaluated. */
  averageReturn: number | null;
  /** Mean realized return of BUY-only calls, net of an assumed round-trip transaction cost. */
  netAverageReturn: number | null;
  /** Worst single realized return among BUY calls in the evaluated sample (a crude drawdown proxy, not a portfolio equity curve). */
  worstBuyReturn: number | null;
  sampleCount: number;
};

export type GraphRecommendation = {
  ticker: string;
  name?: string;
  market: Market;
  sector?: string;
  industry?: string;
  method: "GRAPH_KNN";
  signal: GraphSignal;
  predictedReturn20d: number | null;
  /** 0..1 */
  confidence: number;
  buyThreshold: number | null;
  sellThreshold: number | null;
  neighbors: GraphNeighbor[];
  modelMetrics: GraphModelMetrics;
  reasons: string[];
  dataPoints: number;
  timestamp: string;
  source: string;
  disclaimer: string;
};
