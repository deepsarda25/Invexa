import { Elysia, t } from "elysia";
import { redis } from "../lib/redis";
import { marketAdapter } from "../domain/market/adapter";
import { normalizeTicker } from "../domain/market/tickerSymbols";
import { resolveMarket } from "../domain/market/marketHours";
import { runWithConcurrencyLimit } from "../domain/recommendations/recommendationEngine";
import { buildRankingRecommendations, RANKING_DISCLAIMER, type RankingUniverseInput } from "../domain/recommendations/ranking/rankingEngine";
import type { RankingRecommendation } from "../domain/recommendations/ranking/types";
import { RECOMMENDATION_UNIVERSE, SECTORS, getUniverse, type Market, type UniverseEntry } from "../domain/recommendations/universe";

/**
 * Supervised ranking recommendations — a third, independent recommender
 * that sits next to `recommendations.ts` (the heuristic engine) and
 * `graphRecommendations.ts` (the k-NN peer engine), and never imports
 * from or mutates either. See
 * `backend/src/domain/recommendations/ranking/rankingEngine.ts` for the
 * actual model (a walk-forward-validated ridge regression predicting
 * sector-relative 20-session return).
 *
 * Like the graph module, scoring one ticker still needs price history
 * for the whole curated universe (the regression is trained across all
 * of it), so history is cached the same way, just under its own keys —
 * kept independent on purpose so this engine's cache churn never
 * competes with or gets invalidated by the graph engine's.
 */

const HISTORY_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000; // ~400 days — matches the graph engine's panel depth
const HISTORY_CACHE_TTL_SECONDS = 15 * 60;
const RESULT_CACHE_TTL_SECONDS = 15 * 60;
const HISTORY_CONCURRENCY = 5; // stay conservative against Yahoo Finance rate limits

function inferMarket(ticker: string): Market {
  return resolveMarket(ticker);
}

async function loadHistoryCached(entry: UniverseEntry): Promise<RankingUniverseInput> {
  const cacheKey = `ranking-history:${entry.ticker}`;
  const ticker = normalizeTicker(entry.ticker);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const points = JSON.parse(cached);
      return { ticker, name: entry.name, market: entry.market, sector: entry.sector, points };
    }
  } catch {
    // cache miss/parse failure — fall through and fetch live
  }

  try {
    const points = await marketAdapter.getHistoricalPrices(entry.ticker, new Date(Date.now() - HISTORY_LOOKBACK_MS), "1d");
    if (points && points.length > 0) {
      await redis.setex(cacheKey, HISTORY_CACHE_TTL_SECONDS, JSON.stringify(points)).catch(() => undefined);
    }
    return { ticker, name: entry.name, market: entry.market, sector: entry.sector, points: points ?? [] };
  } catch (err: any) {
    console.error(`[ranking-recommendations] Failed to fetch history for ${entry.ticker}:`, err?.message ?? err);
    return { ticker, name: entry.name, market: entry.market, sector: entry.sector, points: [] };
  }
}

async function loadUniverseHistory(entries: UniverseEntry[]): Promise<RankingUniverseInput[]> {
  return runWithConcurrencyLimit(entries, HISTORY_CONCURRENCY, loadHistoryCached);
}

async function computeRankingForUniverse(entries: UniverseEntry[]): Promise<RankingRecommendation[]> {
  const universe = await loadUniverseHistory(entries);
  const { results } = buildRankingRecommendations(universe);
  return results;
}

/** Resolves a single ticker's history for the live single-stock endpoint, reusing the universe cache when the ticker is curated. */
async function resolveTarget(ticker: string): Promise<UniverseEntry> {
  const known = RECOMMENDATION_UNIVERSE.find((e) => normalizeTicker(e.ticker) === ticker);
  return (known ?? { ticker, name: ticker, market: inferMarket(ticker), sector: "Unclassified" }) as UniverseEntry;
}

export const rankingRecommendationsModule = new Elysia()
  .get("/ranking-recommendations/meta", () => ({
    method: "SUPERVISED_RANKING",
    markets: ["NSE", "BSE", "US"],
    sectors: SECTORS,
    signals: ["BUY", "HOLD", "SELL", "NO_DATA"],
    disclaimer: RANKING_DISCLAIMER
  }))
  .get(
    "/ranking-recommendations",
    async ({ query }) => {
      const cacheKey = `ranking-recommendations:v1:${query.market ?? "ALL"}:${query.sector ?? "ALL"}`;

      const universeEntries = getUniverse({
        market: query.market as Market | undefined,
        sector: query.sector as any
      });

      let results: RankingRecommendation[];
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        try {
          results = JSON.parse(cached);
        } catch {
          results = await computeRankingForUniverse(universeEntries);
          await redis.setex(cacheKey, RESULT_CACHE_TTL_SECONDS, JSON.stringify(results)).catch(() => undefined);
        }
      } else {
        results = await computeRankingForUniverse(universeEntries);
        await redis.setex(cacheKey, RESULT_CACHE_TTL_SECONDS, JSON.stringify(results)).catch(() => undefined);
      }

      const filtered = query.signal && query.signal !== "ALL" ? results.filter((r) => r.signal === query.signal) : results;
      const sorted = [...filtered].sort(
        (a, b) => (b.predictedSectorRelativeReturn20d ?? -Infinity) - (a.predictedSectorRelativeReturn20d ?? -Infinity)
      );

      const bestPerSector = new Map<string, RankingRecommendation>();
      for (const rec of sorted) {
        const key = `${rec.market}:${rec.sector ?? "Unclassified"}`;
        if (!bestPerSector.has(key) && rec.signal !== "NO_DATA") bestPerSector.set(key, rec);
      }

      return {
        method: "SUPERVISED_RANKING" as const,
        results: sorted,
        topPicksBySector: Array.from(bestPerSector.values()),
        universeSize: universeEntries.length,
        scoredCount: results.filter((r) => r.signal !== "NO_DATA").length,
        noDataCount: results.filter((r) => r.signal === "NO_DATA").length,
        modelMetrics: results[0]?.modelMetrics ?? null,
        generatedAt: new Date().toISOString(),
        source: "Historical daily prices",
        disclaimer: RANKING_DISCLAIMER
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
  // Live lookup for any ticker — curated or not. Historical training rows
  // are always drawn from the curated universe's panel; an uncurated
  // ticker is scored *against* that panel without expanding it.
  .get(
    "/stocks/:ticker/ranking-recommendation",
    async ({ params }) => {
      const ticker = normalizeTicker(params.ticker);
      const targetEntry = await resolveTarget(ticker);

      const peerEntries = RECOMMENDATION_UNIVERSE.filter((e) => normalizeTicker(e.ticker) !== ticker);
      const allEntries = [targetEntry, ...peerEntries];

      const results = await computeRankingForUniverse(allEntries);
      const target = results.find((r) => r.ticker === ticker);

      return (
        target ?? {
          ticker,
          market: targetEntry.market,
          method: "SUPERVISED_RANKING",
          signal: "NO_DATA",
          predictedSectorRelativeReturn20d: null,
          probabilityOfOutperformance: null,
          riskAdjustedScore: null,
          confidence: 0,
          buyThreshold: null,
          sellThreshold: null,
          featureContributions: [],
          modelMetrics: { hitRate: null, correlation: null, averageReturn: null, netAverageReturn: null, worstBuyReturn: null, sampleCount: 0 },
          reasons: ["Could not build a ranking prediction for this ticker."],
          dataPoints: 0,
          timestamp: new Date().toISOString(),
          source: "Historical daily prices",
          disclaimer: RANKING_DISCLAIMER
        }
      );
    },
    { params: t.Object({ ticker: t.String({ minLength: 1 }) }) }
  );
