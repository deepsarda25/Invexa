const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export type ApiError = {
  error: string;
};

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  token?: string | null
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Content-Type", "application/json");

  const fallbackToken = typeof window !== "undefined" ? localStorage.getItem("invexa-token") : null;
  const effectiveToken = token ?? fallbackToken;

  if (effectiveToken) {
    headers.set("Authorization", `Bearer ${effectiveToken}`);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as ApiError;
      if (body?.error) {
        message = body.error;
      }
    } catch {
      // Non-JSON response, keep fallback message.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

// ── Recommendations ──────────────────────────────────────────────────────
export type RecommendationSignal = "BUY" | "HOLD" | "SELL" | "NO_DATA";
export type RecommendationMarket = "NSE" | "BSE" | "US";
export type RecommendationDataSource = "LIVE" | "USER_PROVIDED" | "MIXED";

export type PriceRange = { low: number; high: number };

export type RecommendationTechnical = {
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  momentum20Pct: number | null;
  volatility20AnnualizedPct: number | null;
  atr14: number | null;
};

export type RecommendationFundamentals = {
  peRatio: number | null;
  pbRatio: number | null;
  roe: number | null;
  debtToEquity: number | null;
  eps: number | null;
  dividendYield: number | null;
  marketCap: number | null;
};

export type StockRecommendation = {
  ticker: string;
  name: string;
  market: RecommendationMarket;
  sector: string;
  signal: RecommendationSignal;
  score: number;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  riskRating: "LOW" | "MEDIUM" | "HIGH";
  currentPrice: number | null;
  /** Native currency the stock trades in — USD for US-market tickers, INR otherwise. */
  currency: "INR" | "USD";
  /** Only present for USD tickers: the same figures converted at a fixed assumed rate so they can be read alongside an INR portfolio. */
  inrEquivalent: {
    currentPrice: number | null;
    buyRange: PriceRange | null;
    targetRange: PriceRange | null;
    stopLoss: number | null;
    exchangeRateUsed: number;
    note: string;
  } | null;
  levels: {
    buyRange: PriceRange | null;
    targetRange: PriceRange | null;
    stopLoss: number | null;
  };
  levelBasis: string;
  horizon: {
    shortTerm: RecommendationSignal;
    swing: RecommendationSignal;
    longTerm: RecommendationSignal;
  };
  technical: RecommendationTechnical;
  fundamentals: RecommendationFundamentals;
  reasons: string[];
  dataPoints: number;
  dataSource: RecommendationDataSource;
  manualEntryAvailable: boolean;
  timestamp: string;
  source: string;
  disclaimer: string;
};

export type RecommendationListResponse = {
  results: StockRecommendation[];
  topPicksBySector: StockRecommendation[];
  weakestBySector: StockRecommendation[];
  universeSize: number;
  scoredCount: number;
  noDataCount: number;
  usdToInrRate: number;
  generatedAt: string;
  source: string;
  disclaimer: string;
};

export type ManualRecommendationInput = {
  currentPrice?: number;
  priceHistory?: Array<{ date: string; open?: number; high?: number; low?: number; close: number }>;
  technical?: Partial<RecommendationTechnical>;
  fundamentals?: Partial<RecommendationFundamentals>;
};

export function getRecommendation(ticker: string, token?: string | null) {
  return apiFetch<StockRecommendation>(`/stocks/${encodeURIComponent(ticker)}/recommendation`, {}, token);
}

/** Submits manually-entered data for a ticker Yahoo Finance has no/insufficient history for. */
export function submitManualRecommendation(ticker: string, manual: ManualRecommendationInput, token?: string | null) {
  return apiFetch<StockRecommendation>(
    `/stocks/${encodeURIComponent(ticker)}/recommendation`,
    { method: "POST", body: JSON.stringify(manual) },
    token
  );
}

export function getRecommendations(
  params: { market?: RecommendationMarket; sector?: string; signal?: RecommendationSignal | "ALL" } = {},
  token?: string | null
) {
  const query = new URLSearchParams();
  if (params.market) query.set("market", params.market);
  if (params.sector) query.set("sector", params.sector);
  if (params.signal) query.set("signal", params.signal);
  const qs = query.toString();
  return apiFetch<RecommendationListResponse>(`/recommendations${qs ? `?${qs}` : ""}`, {}, token);
}

// ── Graph-based peer recommendations ─────────────────────────────────────
// A second, independent recommender: a sector-neutralized k-nearest-neighbor
// model over normalized price + fundamental features, predicting a 20-session
// forward return from historically similar analogs (not just "peers are up").
// See GRAPH_RECOMMENDATIONS_FEATURE.md for the full write-up. Deliberately
// decoupled from StockRecommendation above — the two can disagree, and
// that's useful, not a bug.
export type GraphSignal = "BUY" | "HOLD" | "SELL" | "NO_DATA";

export type GraphNeighbor = {
  ticker: string;
  name?: string;
  /** Combined price/return/sector/industry similarity (0..1) actually used in the prediction. */
  similarity: number;
  /** Sessions back from "now" this historical analog is drawn from. 0 = live state. */
  offset: number;
  historicalForwardReturn20d: number | null;
  /** Display-only cosine similarity (0..1) of current fundamentals — never part of the prediction itself. */
  fundamentalSimilarity: number | null;
};

export type GraphModelMetrics = {
  hitRate: number | null;
  averageReturn: number | null;
  netAverageReturn: number | null;
  worstBuyReturn: number | null;
  sampleCount: number;
};

export type GraphRecommendation = {
  ticker: string;
  name?: string;
  market: RecommendationMarket;
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

export type GraphRecommendationListResponse = {
  method: "GRAPH_KNN";
  results: GraphRecommendation[];
  universeSize: number;
  scoredCount: number;
  noDataCount: number;
  modelMetrics: GraphModelMetrics | null;
  generatedAt: string;
  source: string;
  disclaimer: string;
};

export function getGraphRecommendation(ticker: string, token?: string | null) {
  return apiFetch<GraphRecommendation>(`/stocks/${encodeURIComponent(ticker)}/graph-recommendation`, {}, token);
}

export function getGraphRecommendations(
  params: { market?: RecommendationMarket; sector?: string; signal?: GraphSignal | "ALL" } = {},
  token?: string | null
) {
  const query = new URLSearchParams();
  if (params.market) query.set("market", params.market);
  if (params.sector) query.set("sector", params.sector);
  if (params.signal) query.set("signal", params.signal);
  const qs = query.toString();
  return apiFetch<GraphRecommendationListResponse>(`/graph-recommendations${qs ? `?${qs}` : ""}`, {}, token);
}

// ── Supervised ranking recommendations ───────────────────────────────────
// A third, independent recommender: a walk-forward-validated ridge
// regression trained on point-in-time price/momentum/volatility features
// to predict 20-session return relative to sector, then ranked
// cross-sectionally into BUY/HOLD/SELL. See RANKING_RECOMMENDATIONS_FEATURE
// for the write-up. Deliberately decoupled from StockRecommendation and
// GraphRecommendation above — all three can disagree, and that's useful,
// not a bug.
export type RankingSignal = "BUY" | "HOLD" | "SELL" | "NO_DATA";

export type RankingFeatureContribution = {
  feature: string;
  value: number;
  weight: number;
  contribution: number;
};

export type RankingModelMetrics = {
  hitRate: number | null;
  correlation: number | null;
  averageReturn: number | null;
  netAverageReturn: number | null;
  worstBuyReturn: number | null;
  sampleCount: number;
};

export type RankingRecommendation = {
  ticker: string;
  name?: string;
  market: RecommendationMarket;
  sector?: string;
  industry?: string;
  method: "SUPERVISED_RANKING";
  signal: RankingSignal;
  predictedSectorRelativeReturn20d: number | null;
  /** 0..1 */
  probabilityOfOutperformance: number | null;
  riskAdjustedScore: number | null;
  /** 0..1 */
  confidence: number;
  buyThreshold: number | null;
  sellThreshold: number | null;
  featureContributions: RankingFeatureContribution[];
  modelMetrics: RankingModelMetrics;
  reasons: string[];
  dataPoints: number;
  timestamp: string;
  source: string;
  disclaimer: string;
};

export type RankingRecommendationListResponse = {
  method: "SUPERVISED_RANKING";
  results: RankingRecommendation[];
  topPicksBySector: RankingRecommendation[];
  universeSize: number;
  scoredCount: number;
  noDataCount: number;
  modelMetrics: RankingModelMetrics | null;
  generatedAt: string;
  source: string;
  disclaimer: string;
};

export function getRankingRecommendation(ticker: string, token?: string | null) {
  return apiFetch<RankingRecommendation>(`/stocks/${encodeURIComponent(ticker)}/ranking-recommendation`, {}, token);
}

export function getRankingRecommendations(
  params: { market?: RecommendationMarket; sector?: string; signal?: RankingSignal | "ALL" } = {},
  token?: string | null
) {
  const query = new URLSearchParams();
  if (params.market) query.set("market", params.market);
  if (params.sector) query.set("sector", params.sector);
  if (params.signal) query.set("signal", params.signal);
  const qs = query.toString();
  return apiFetch<RankingRecommendationListResponse>(`/ranking-recommendations${qs ? `?${qs}` : ""}`, {}, token);
}

// ── Seasonal growth forecast recommendations ─────────────────────────────
// A fourth, independent recommender: compares the company's revenue,
// earnings, EPS, free cash flow, and price against every prior year
// available for the same calendar month (not just one anchor
// comparison), plus an industry-median and peer read on price momentum.
// See GROWTH_RECOMMENDATIONS_FEATURE for the write-up.
export type GrowthSignal = "BUY" | "HOLD" | "SELL" | "NO_DATA";

export type GrowthModelMetrics = {
  hitRate: number | null;
  averageRealizedGrowthPercent: number | null;
  sampleCount: number;
};

export type MetricSeasonalSummary = {
  evaluatedMonthGrowthPercent: number | null;
  evaluatedMonthSampleCount: number;
  overallGrowthPercent: number | null;
  overallSampleCount: number;
  trendSlopePerYear: number | null;
  consistency: number;
};

export type SeasonalYoYPoint = {
  period: string;
  previousPeriod: string;
  month: number;
  year: number;
  currentValue: number;
  previousValue: number;
  growthPercent: number;
};

export type MonthlySeasonalProfile = {
  month: number;
  sampleCount: number;
  meanGrowthPercent: number | null;
  medianGrowthPercent: number | null;
  stdevGrowthPercent: number | null;
  consistency: number;
  latestGrowthPercent: number | null;
  latestYear: number | null;
  trendSlopePerYear: number | null;
  tStatistic: number | null;
  isNotable: boolean;
};

export type MonthHighlight = {
  month: number;
  monthName: string;
  meanGrowthPercent: number;
  stdevGrowthPercent: number | null;
  sampleCount: number;
  consistency: number;
  isNotable: boolean;
};

// Directly answers "in which months does this stock see the most ups and
// downs": best/worst/most-volatile/most-consistent calendar month, drawn
// from the full 12-month price-seasonality panel.
export type SeasonalityInsights = {
  bestMonth: MonthHighlight | null;
  worstMonth: MonthHighlight | null;
  mostVolatileMonth: MonthHighlight | null;
  mostConsistentMonth: MonthHighlight | null;
  seasonalSwingPercent: number | null;
  monthsWithEnoughData: number;
  hasReliableSeasonality: boolean;
};

export type GrowthForecast = {
  ticker: string;
  name?: string;
  market: RecommendationMarket;
  sector?: string;
  method: "SEASONAL_GROWTH";
  evaluatedPeriod: string;
  forecastPeriod: string;
  signal: GrowthSignal;
  score: number;
  confidence: number;
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
  priceSeasonalPoints: SeasonalYoYPoint[];
  priceSeasonalByMonth: MonthlySeasonalProfile[];
  priceSeasonality: SeasonalityInsights;
  modelMetrics: GrowthModelMetrics;
  reasons: string[];
  dataPoints: number;
  timestamp: string;
  source: string;
  disclaimer: string;
};

export type GrowthForecastListResponse = {
  method: "SEASONAL_GROWTH";
  results: GrowthForecast[];
  topPicksBySector: GrowthForecast[];
  universeSize: number;
  scoredCount: number;
  noDataCount: number;
  evaluatedPeriod: string;
  generatedAt: string;
  source: string;
  disclaimer: string;
};

export function getGrowthRecommendation(ticker: string, token?: string | null) {
  return apiFetch<GrowthForecast>(`/stocks/${encodeURIComponent(ticker)}/growth-recommendation`, {}, token);
}

export function getGrowthRecommendations(
  params: { market?: RecommendationMarket; sector?: string; signal?: GrowthSignal | "ALL" } = {},
  token?: string | null
) {
  const query = new URLSearchParams();
  if (params.market) query.set("market", params.market);
  if (params.sector) query.set("sector", params.sector);
  if (params.signal) query.set("signal", params.signal);
  const qs = query.toString();
  return apiFetch<GrowthForecastListResponse>(`/growth-recommendations${qs ? `?${qs}` : ""}`, {}, token);
}

export type QuotesResponse = { quotes: Array<{ ticker: string; price: number | null }> };

/**
 * On-demand live quotes for a handful of tickers, regardless of whether the
 * real-time price worker is actively streaming them. Used by "Recently
 * Viewed" so it doesn't depend on the websocket price feed, which only
 * covers actively-held/ordered tickers.
 */
export function getQuotes(tickers: string[], token?: string | null) {
  if (tickers.length === 0) return Promise.resolve<QuotesResponse>({ quotes: [] });
  const qs = new URLSearchParams({ tickers: tickers.join(",") }).toString();
  return apiFetch<QuotesResponse>(`/stocks/quotes?${qs}`, {}, token);
}

// ── Leagues ──────────────────────────────────────────────────────────────
// Leagues rank members on percentage return since they joined, so joining
// never disturbs the portfolio you already trade.

export type League = {
  id: string;
  name: string;
  description: string | null;
  joinCode: string;
  ownerId: string;
  ownerUsername: string;
  isOwner: boolean;
  isOpen: boolean;
  maxMembers: number | null;
  memberCount: number;
  createdAt: string;
  joinedAt?: string;
};

export type LeaderboardRow = {
  rank: number;
  userId: string;
  username: string;
  isYou: boolean;
  isOwner: boolean;
  joinedAt: string;
  baselineValue: number;
  currentValue: number;
  returnAmount: number;
  returnPct: number;
};

export type LeaderboardResponse = {
  league: League;
  leaderboard: LeaderboardRow[];
  you: LeaderboardRow | null;
  updatedAt: string;
};

export function getMyLeagues(token?: string | null) {
  return apiFetch<{ leagues: League[] }>("/leagues", {}, token);
}

export function createLeague(
  input: { name: string; description?: string; maxMembers?: number | null },
  token?: string | null
) {
  return apiFetch<{ league: League }>("/leagues", { method: "POST", body: JSON.stringify(input) }, token);
}

export function joinLeague(code: string, token?: string | null) {
  return apiFetch<{ league: League; alreadyMember: boolean; message: string }>(
    "/leagues/join",
    { method: "POST", body: JSON.stringify({ code }) },
    token
  );
}

export function getLeagueLeaderboard(leagueId: string, token?: string | null) {
  return apiFetch<LeaderboardResponse>(`/leagues/${leagueId}/leaderboard`, {}, token);
}

export function regenerateLeagueCode(leagueId: string, token?: string | null) {
  return apiFetch<{ joinCode: string; message: string }>(
    `/leagues/${leagueId}/regenerate-code`,
    { method: "POST" },
    token
  );
}

export function updateLeague(
  leagueId: string,
  patch: { name?: string; description?: string | null; isOpen?: boolean; maxMembers?: number | null },
  token?: string | null
) {
  return apiFetch<{ league: League }>(`/leagues/${leagueId}`, { method: "PATCH", body: JSON.stringify(patch) }, token);
}

export function leaveLeague(leagueId: string, token?: string | null) {
  return apiFetch<{ left: boolean }>(`/leagues/${leagueId}/leave`, { method: "POST" }, token);
}

export function removeLeagueMember(leagueId: string, userId: string, token?: string | null) {
  return apiFetch<{ removed: boolean }>(`/leagues/${leagueId}/members/${userId}`, { method: "DELETE" }, token);
}

export function deleteLeague(leagueId: string, token?: string | null) {
  return apiFetch<{ deleted: boolean }>(`/leagues/${leagueId}`, { method: "DELETE" }, token);
}
