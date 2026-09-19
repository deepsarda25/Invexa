import { Elysia, t } from "elysia";
import { redis } from "../lib/redis";
import { marketAdapter } from "../domain/market/adapter";
import { normalizeTicker } from "../domain/market/tickerSymbols";
import { resolveMarket } from "../domain/market/marketHours";
import { runWithConcurrencyLimit } from "../domain/recommendations/recommendationEngine";
import { getFundamentalSnapshot } from "../domain/recommendations/graph/features";
import { buildGraphRecommendations, GRAPH_DISCLAIMER, type GraphUniverseInput } from "../domain/recommendations/graph/graphRecommendationEngine";
import type { FundamentalSnapshot, GraphRecommendation } from "../domain/recommendations/graph/types";
import { getCachedProfile } from "../lib/profileCache";
import { RECOMMENDATION_UNIVERSE, SECTORS, getUniverse, type Market, type UniverseEntry } from "../domain/recommendations/universe";

/**
 * Graph-based peer recommendations — a second, independent recommender
 * that sits next to `recommendations.ts` (the heuristic engine) and never
 * imports from or mutates it. See
 * `backend/src/domain/recommendations/graph/graphRecommendationEngine.ts`
 * for the actual model (sector-neutralized k-NN over price + fundamental
 * features, with a real walk-forward check) and
 * `GRAPH_RECOMMENDATIONS_FEATURE.md` for the write-up.
 *
 * Building the graph needs price history for the *entire* universe (a
 * stock's peers/historical analogs have to be scored too), so history is
 * cached the same way the heuristic engine caches its own per-ticker
 * fetches, just under separate keys.
 */

const HISTORY_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000; // ~400 days — enough for a 250-bar-offset historical panel plus 120d lookback features
const HISTORY_CACHE_TTL_SECONDS = 15 * 60;
const RESULT_CACHE_TTL_SECONDS = 15 * 60;
const HISTORY_CONCURRENCY = 5; // stay conservative against Yahoo Finance rate limits
const FUNDAMENTALS_CONCURRENCY = 5;

function inferMarket(ticker: string): Market {
  return resolveMarket(ticker);
}

async function loadHistoryCached(entry: UniverseEntry): Promise<GraphUniverseInput> {
  const cacheKey = `graph-history:${entry.ticker}`;
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
    console.error(`[graph-recommendations] Failed to fetch history for ${entry.ticker}:`, err?.message ?? err);
    return { ticker, name: entry.name, market: entry.market, sector: entry.sector, points: [] };
  }
}

async function loadUniverseHistory(entries: UniverseEntry[]): Promise<GraphUniverseInput[]> {
  return runWithConcurrencyLimit(entries, HISTORY_CONCURRENCY, loadHistoryCached);
}

async function loadFundamentals(entries: UniverseEntry[]): Promise<Map<string, FundamentalSnapshot>> {
  const map = new Map<string, FundamentalSnapshot>();
  await runWithConcurrencyLimit(entries, FUNDAMENTALS_CONCURRENCY, async (entry) => {
    const ticker = normalizeTicker(entry.ticker);
    map.set(ticker, await getFundamentalSnapshot(entry.ticker));
  });
  return map;
}

/**
 * `UniverseEntry` only carries a coarse `sector` — the finer `industry`
 * classification used by the similarity graph comes from Yahoo's asset
 * profile, reusing the same 24h-cached `getCachedProfile` the heuristic
 * engine and stock-profile page already rely on (no extra Yahoo call
 * volume beyond what the app already makes).
 */
async function loadIndustries(entries: UniverseEntry[]): Promise<Map<string, string | undefined>> {
  const map = new Map<string, string | undefined>();
  await runWithConcurrencyLimit(entries, FUNDAMENTALS_CONCURRENCY, async (entry) => {
    const ticker = normalizeTicker(entry.ticker);
    try {
      const profile = await getCachedProfile(entry.ticker);
      map.set(ticker, profile?.industry && profile.industry !== "N/A" ? profile.industry : undefined);
    } catch {
      map.set(ticker, undefined);
    }
  });
  return map;
}

async function computeGraphForUniverse(entries: UniverseEntry[]): Promise<GraphRecommendation[]> {
  const [universe, fundamentals, industries] = await Promise.all([
    loadUniverseHistory(entries),
    loadFundamentals(entries),
    loadIndustries(entries)
  ]);
  const universeWithIndustry = universe.map((u) => ({ ...u, industry: industries.get(u.ticker) }));
  const { results } = buildGraphRecommendations(universeWithIndustry, fundamentals);
  return results;
}

/** Resolves a single ticker's history for the live single-stock endpoint, reusing the universe cache when the ticker is curated. */
async function resolveTarget(ticker: string): Promise<UniverseEntry> {
  const known = RECOMMENDATION_UNIVERSE.find((e) => normalizeTicker(e.ticker) === ticker);
  return (known ?? { ticker, name: ticker, market: inferMarket(ticker), sector: "Unclassified" }) as UniverseEntry;
}

export const graphRecommendationsModule = new Elysia()
  .get("/graph-recommendations/meta", () => ({
    method: "GRAPH_KNN",
    markets: ["NSE", "BSE", "US"],
    sectors: SECTORS,
    signals: ["BUY", "HOLD", "SELL", "NO_DATA"],
    disclaimer: GRAPH_DISCLAIMER
  }))
  .get(
    "/graph-recommendations",
    async ({ query }) => {
      const cacheKey = `graph-recommendations:v2:${query.market ?? "ALL"}:${query.sector ?? "ALL"}`;

      const universeEntries = getUniverse({
        market: query.market as Market | undefined,
        sector: query.sector as any
      });

      let results: GraphRecommendation[];
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        try {
          results = JSON.parse(cached);
        } catch {
          results = await computeGraphForUniverse(universeEntries);
          await redis.setex(cacheKey, RESULT_CACHE_TTL_SECONDS, JSON.stringify(results)).catch(() => undefined);
        }
      } else {
        results = await computeGraphForUniverse(universeEntries);
        await redis.setex(cacheKey, RESULT_CACHE_TTL_SECONDS, JSON.stringify(results)).catch(() => undefined);
      }

      const filtered = query.signal && query.signal !== "ALL" ? results.filter((r) => r.signal === query.signal) : results;
      const sorted = [...filtered].sort((a, b) => (b.predictedReturn20d ?? -Infinity) - (a.predictedReturn20d ?? -Infinity));

      return {
        method: "GRAPH_KNN" as const,
        results: sorted,
        universeSize: universeEntries.length,
        scoredCount: results.filter((r) => r.signal !== "NO_DATA").length,
        noDataCount: results.filter((r) => r.signal === "NO_DATA").length,
        modelMetrics: results[0]?.modelMetrics ?? null,
        generatedAt: new Date().toISOString(),
        source: "Historical daily prices",
        disclaimer: GRAPH_DISCLAIMER
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
  // Live lookup for any ticker — curated or not. Historical analogs/peers
  // are always drawn from the curated universe's panel; an uncurated
  // ticker is scored *against* that panel without expanding it.
  .get(
    "/stocks/:ticker/graph-recommendation",
    async ({ params }) => {
      const ticker = normalizeTicker(params.ticker);
      const targetEntry = await resolveTarget(ticker);

      const peerEntries = RECOMMENDATION_UNIVERSE.filter((e) => normalizeTicker(e.ticker) !== ticker);
      const allEntries = [targetEntry, ...peerEntries];

      const results = await computeGraphForUniverse(allEntries);
      const target = results.find((r) => r.ticker === ticker);

      return (
        target ?? {
          ticker,
          market: targetEntry.market,
          method: "GRAPH_KNN",
          signal: "NO_DATA",
          predictedReturn20d: null,
          confidence: 0,
          buyThreshold: null,
          sellThreshold: null,
          neighbors: [],
          modelMetrics: { hitRate: null, averageReturn: null, netAverageReturn: null, worstBuyReturn: null, sampleCount: 0 },
          reasons: ["Could not build a graph prediction for this ticker."],
          dataPoints: 0,
          timestamp: new Date().toISOString(),
          source: "Historical daily prices",
          disclaimer: GRAPH_DISCLAIMER
        }
      );
    },
    { params: t.Object({ ticker: t.String({ minLength: 1 }) }) }
  );
