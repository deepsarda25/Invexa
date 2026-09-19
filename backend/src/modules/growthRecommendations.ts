import { Elysia, t } from "elysia";
import { redis } from "../lib/redis";
import { marketAdapter } from "../domain/market/adapter";
import { normalizeTicker } from "../domain/market/tickerSymbols";
import { resolveMarket } from "../domain/market/marketHours";
import { runWithConcurrencyLimit } from "../domain/recommendations/recommendationEngine";
import {
  assignGrowthSignals,
  buildGrowthForecast,
  EMPTY_SEASONALITY_INSIGHTS,
  GROWTH_DISCLAIMER,
  type GrowthBuildResult,
  type GrowthUniverseInput
} from "../domain/recommendations/growth/growthForecastEngine";
import { getFundamentalHistory } from "../domain/recommendations/growth/fundamentalsData";
import type { PeriodValue } from "../domain/recommendations/growth/seasonalAnalysis";
import type { GrowthForecast } from "../domain/recommendations/growth/types";
import { RECOMMENDATION_UNIVERSE, SECTORS, getUniverse, type Market, type UniverseEntry } from "../domain/recommendations/universe";

/**
 * Seasonal growth recommendations — the fourth, independent recommender,
 * next to `recommendations.ts` (heuristic), `graphRecommendations.ts`
 * (k-NN), and `rankingRecommendations.ts` (supervised ranking). See
 * `backend/src/domain/recommendations/growth/growthForecastEngine.ts`
 * for the model itself.
 *
 * History depth here is deliberately much longer than the other three
 * engines (~8 years vs. ~400 days) because the entire point of this
 * engine is comparing every calendar month against every year
 * available — a shallow window would defeat it before it starts.
 * Fetched at monthly ("1mo") granularity directly from Yahoo rather than
 * resampled from daily candles, and cached under its own keys so this
 * engine's (much longer, much less frequently changing) history never
 * competes with the shorter-window caches the other three engines use.
 */

const PRICE_HISTORY_LOOKBACK_MS = 8 * 365 * 24 * 60 * 60 * 1000; // ~8 years
const PRICE_HISTORY_CACHE_TTL_SECONDS = 12 * 60 * 60; // monthly candles change slowly; cache generously
const RESULT_CACHE_TTL_SECONDS = 60 * 60;
const FETCH_CONCURRENCY = 4; // longer-range history requests are heavier than the other engines' — stay conservative

function inferMarket(ticker: string): Market {
  return resolveMarket(ticker);
}

function toMonthlyPeriodSeries(points: Array<{ time: string; close: number }>): PeriodValue[] {
  const byPeriod = new Map<string, number>();
  for (const point of points) {
    const date = new Date(point.time);
    if (Number.isNaN(date.getTime()) || !Number.isFinite(point.close)) continue;
    const period = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    byPeriod.set(period, point.close); // last candle wins if Yahoo ever returns more than one row per calendar month
  }
  return Array.from(byPeriod.entries())
    .map(([period, value]) => ({ period, value }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

async function loadMonthlyPricesCached(entry: UniverseEntry): Promise<PeriodValue[]> {
  const cacheKey = `growth-monthly-prices:${entry.ticker}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // fall through to a live fetch
  }

  try {
    const points = await marketAdapter.getHistoricalPrices(entry.ticker, new Date(Date.now() - PRICE_HISTORY_LOOKBACK_MS), "1mo");
    const series = toMonthlyPeriodSeries(points ?? []);
    await redis.setex(cacheKey, PRICE_HISTORY_CACHE_TTL_SECONDS, JSON.stringify(series)).catch(() => undefined);
    return series;
  } catch (err: any) {
    console.error(`[growth-recommendations] Failed to fetch monthly prices for ${entry.ticker}:`, err?.message ?? err);
    return [];
  }
}

async function loadUniverseInput(entry: UniverseEntry): Promise<GrowthUniverseInput> {
  const [monthlyPrices, fundamentals] = await Promise.all([loadMonthlyPricesCached(entry), getFundamentalHistory(entry.ticker)]);
  return {
    ticker: normalizeTicker(entry.ticker),
    name: entry.name,
    market: entry.market,
    sector: entry.sector,
    monthlyPrices,
    fundamentals
  };
}

async function computeGrowthForUniverse(entries: UniverseEntry[], evaluationDate: Date): Promise<GrowthForecast[]> {
  const universe = await runWithConcurrencyLimit(entries, FETCH_CONCURRENCY, loadUniverseInput);
  const bySector = new Map<string, GrowthUniverseInput[]>();
  for (const entry of universe) {
    const key = entry.sector ?? "Unclassified";
    const list = bySector.get(key) ?? [];
    list.push(entry);
    bySector.set(key, list);
  }

  const built: GrowthBuildResult[] = universe.map((entry) => {
    const peers = (bySector.get(entry.sector ?? "Unclassified") ?? []).filter((p) => p.ticker !== entry.ticker);
    return buildGrowthForecast(entry, peers, evaluationDate);
  });

  return assignGrowthSignals(built);
}

async function resolveTarget(ticker: string): Promise<UniverseEntry> {
  const known = RECOMMENDATION_UNIVERSE.find((e) => normalizeTicker(e.ticker) === ticker);
  return (known ?? { ticker, name: ticker, market: inferMarket(ticker), sector: "Unclassified" }) as UniverseEntry;
}

const EMPTY_MODEL_METRICS = { hitRate: null, averageRealizedGrowthPercent: null, sampleCount: 0 };
const EMPTY_METRIC_SUMMARY = {
  evaluatedMonthGrowthPercent: null,
  evaluatedMonthSampleCount: 0,
  overallGrowthPercent: null,
  overallSampleCount: 0,
  trendSlopePerYear: null,
  consistency: 0
};

function noDataForecast(ticker: string, market: Market, evaluationDate: Date): GrowthForecast {
  const evaluatedPeriod = `${evaluationDate.getFullYear()}-${String(evaluationDate.getMonth() + 1).padStart(2, "0")}`;
  const [year, month] = evaluatedPeriod.split("-").map(Number);
  return {
    ticker,
    market,
    method: "SEASONAL_GROWTH",
    evaluatedPeriod,
    forecastPeriod: `${year + 1}-${String(month).padStart(2, "0")}`,
    signal: "NO_DATA",
    score: 0,
    confidence: 0,
    predictedGrowthPercent: null,
    buyThreshold: null,
    sellThreshold: null,
    revenue: EMPTY_METRIC_SUMMARY,
    earnings: EMPTY_METRIC_SUMMARY,
    eps: EMPTY_METRIC_SUMMARY,
    freeCashFlow: EMPTY_METRIC_SUMMARY,
    price: EMPTY_METRIC_SUMMARY,
    industryPrice: EMPTY_METRIC_SUMMARY,
    peerAveragePrice: EMPTY_METRIC_SUMMARY,
    priceSeasonalPoints: [],
    priceSeasonalByMonth: [],
    priceSeasonality: EMPTY_SEASONALITY_INSIGHTS,
    modelMetrics: EMPTY_MODEL_METRICS,
    reasons: ["Could not build a seasonal growth forecast for this ticker."],
    dataPoints: 0,
    timestamp: new Date().toISOString(),
    source: "Historical annual fundamentals + monthly prices",
    disclaimer: GROWTH_DISCLAIMER
  };
}

export const growthRecommendationsModule = new Elysia()
  .get("/growth-recommendations/meta", () => ({
    method: "SEASONAL_GROWTH",
    markets: ["NSE", "BSE", "US"],
    sectors: SECTORS,
    signals: ["BUY", "HOLD", "SELL", "NO_DATA"],
    disclaimer: GROWTH_DISCLAIMER
  }))
  .get(
    "/growth-recommendations",
    async ({ query }) => {
      const evaluationDate = new Date();
      const cacheKey = `growth-recommendations:v1:${query.market ?? "ALL"}:${query.sector ?? "ALL"}:${evaluationDate.getFullYear()}-${evaluationDate.getMonth() + 1}`;

      const universeEntries = getUniverse({
        market: query.market as Market | undefined,
        sector: query.sector as any
      });

      let results: GrowthForecast[];
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        try {
          results = JSON.parse(cached);
        } catch {
          results = await computeGrowthForUniverse(universeEntries, evaluationDate);
          await redis.setex(cacheKey, RESULT_CACHE_TTL_SECONDS, JSON.stringify(results)).catch(() => undefined);
        }
      } else {
        results = await computeGrowthForUniverse(universeEntries, evaluationDate);
        await redis.setex(cacheKey, RESULT_CACHE_TTL_SECONDS, JSON.stringify(results)).catch(() => undefined);
      }

      const filtered = query.signal && query.signal !== "ALL" ? results.filter((r) => r.signal === query.signal) : results;
      const sorted = [...filtered].sort((a, b) => (b.predictedGrowthPercent ?? -Infinity) - (a.predictedGrowthPercent ?? -Infinity));

      const bestPerSector = new Map<string, GrowthForecast>();
      for (const rec of sorted) {
        const key = `${rec.market}:${rec.sector ?? "Unclassified"}`;
        if (!bestPerSector.has(key) && rec.signal !== "NO_DATA") bestPerSector.set(key, rec);
      }

      return {
        method: "SEASONAL_GROWTH" as const,
        results: sorted,
        topPicksBySector: Array.from(bestPerSector.values()),
        universeSize: universeEntries.length,
        scoredCount: results.filter((r) => r.signal !== "NO_DATA").length,
        noDataCount: results.filter((r) => r.signal === "NO_DATA").length,
        evaluatedPeriod: `${evaluationDate.getFullYear()}-${String(evaluationDate.getMonth() + 1).padStart(2, "0")}`,
        generatedAt: new Date().toISOString(),
        source: "Historical annual fundamentals + monthly prices",
        disclaimer: GROWTH_DISCLAIMER
      };
    },
    {
      query: t.Object({
        market: t.Optional(t.Union([t.Literal("NSE"), t.Literal("BSE"), t.Literal("US")])),
        sector: t.Optional(t.String()),
        signal: t.Optional(
          t.Union([t.Literal("BUY"), t.Literal("HOLD"), t.Literal("SELL"), t.Literal("NO_DATA"), t.Literal("ALL")])
        )
      })
    }
  )
  .get(
    "/stocks/:ticker/growth-recommendation",
    async ({ params }) => {
      const ticker = normalizeTicker(params.ticker);
      const targetEntry = await resolveTarget(ticker);
      const evaluationDate = new Date();

      const sectorPeers = RECOMMENDATION_UNIVERSE.filter(
        (e) => normalizeTicker(e.ticker) !== ticker && e.sector === targetEntry.sector
      );
      const allEntries = [targetEntry, ...sectorPeers];

      const results = await computeGrowthForUniverse(allEntries, evaluationDate);
      const target = results.find((r) => r.ticker === ticker);

      return target ?? noDataForecast(ticker, targetEntry.market, evaluationDate);
    },
    { params: t.Object({ ticker: t.String({ minLength: 1 }) }) }
  );
