import YahooFinance from "yahoo-finance2";
import { redis } from "../../../lib/redis";
import { toYahooSymbol } from "../../market/tickerSymbols";
import type { OhlcPoint } from "../../market/adapter";
import type { Market } from "../universe";
import { PRICE_FEATURE_NAMES, FUNDAMENTAL_FEATURE_NAMES, type FundamentalSnapshot, type PriceFeatureRow } from "./types";

const yahooFinance = new YahooFinance();

const RET_INDEX = { ret20: 0, ret60: 1, ret120: 2, volatility20: 3, maxDrawdown120: 4, distanceFrom52wHigh: 5, relativeStrength20: 6 };

/** Bars-back offsets to build the historical feature panel at, capped to keep compute bounded. */
const MAX_OFFSET = 250;
const OFFSET_STEP = 3;

export function generateOffsets(closesLength: number): number[] {
  const maxUsableOffset = Math.min(MAX_OFFSET, closesLength - 21); // need anchor-20 for ret20's own lookback via forwardReturn resolution, see below
  if (maxUsableOffset < 0) return [0].filter((o) => o < closesLength);
  const offsets = new Set<number>([0]);
  for (let o = OFFSET_STEP; o <= maxUsableOffset; o += OFFSET_STEP) offsets.add(o);
  return Array.from(offsets).sort((a, b) => a - b);
}

function closesOf(points: OhlcPoint[]): number[] {
  return points.map((p) => p.close).filter((c) => Number.isFinite(c) && c > 0);
}

function retN(closes: number[], anchor: number, n: number): number {
  const from = anchor - n;
  if (from < 0) return NaN;
  if (closes[from] <= 0) return NaN;
  return closes[anchor] / closes[from] - 1;
}

function volatility20At(closes: number[], anchor: number): number {
  const from = anchor - 20;
  if (from < 0) return NaN;
  const window = closes.slice(from, anchor + 1);
  const logReturns: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    if (window[i - 1] > 0 && window[i] > 0) logReturns.push(Math.log(window[i] / window[i - 1]));
  }
  if (logReturns.length < 2) return NaN;
  const avg = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - avg) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function maxDrawdown120At(closes: number[], anchor: number): number {
  const from = Math.max(0, anchor - 120);
  const window = closes.slice(from, anchor + 1);
  if (window.length < 5) return NaN;
  let peak = window[0];
  let worst = 0;
  for (const price of window) {
    if (price > peak) peak = price;
    const drawdown = peak > 0 ? price / peak - 1 : 0;
    if (drawdown < worst) worst = drawdown;
  }
  return worst * 100; // percentage, negative
}

function distanceFrom52wHighAt(closes: number[], anchor: number): number {
  const from = Math.max(0, anchor - 252);
  const window = closes.slice(from, anchor + 1);
  if (window.length < 5) return NaN;
  const high = Math.max(...window);
  if (high <= 0) return NaN;
  return ((closes[anchor] - high) / high) * 100; // percentage, <= 0
}

/**
 * Builds one row per offset for a single ticker. `relativeStrength20` is
 * left as `NaN` here — it's a *cross-sectional* feature (this name's
 * ret20 vs everyone else's ret20 at the same offset), so it can only be
 * filled in once the whole universe's rows exist. See
 * `fillRelativeStrength` below, called once by the engine after every
 * ticker's rows are built.
 */
export function buildPriceFeatureRows(
  entry: { ticker: string; name?: string; market: Market; sector?: string; industry?: string },
  points: OhlcPoint[]
): PriceFeatureRow[] {
  const closes = closesOf(points);
  const offsets = generateOffsets(closes.length);
  const rows: PriceFeatureRow[] = [];

  for (const offset of offsets) {
    const anchor = closes.length - 1 - offset;
    if (anchor < 0) continue;

    const raw = new Array(PRICE_FEATURE_NAMES.length).fill(NaN);
    raw[RET_INDEX.ret20] = retN(closes, anchor, 20);
    raw[RET_INDEX.ret60] = retN(closes, anchor, 60);
    raw[RET_INDEX.ret120] = retN(closes, anchor, 120);
    raw[RET_INDEX.volatility20] = volatility20At(closes, anchor);
    raw[RET_INDEX.maxDrawdown120] = maxDrawdown120At(closes, anchor);
    raw[RET_INDEX.distanceFrom52wHigh] = distanceFrom52wHighAt(closes, anchor);
    raw[RET_INDEX.relativeStrength20] = NaN; // filled in cross-sectionally later

    const forwardAnchor = anchor + 20;
    const forwardReturn20d = forwardAnchor < closes.length && closes[anchor] > 0 ? closes[forwardAnchor] / closes[anchor] - 1 : null;

    rows.push({
      ticker: entry.ticker,
      name: entry.name,
      market: entry.market,
      sector: entry.sector,
      industry: entry.industry,
      offset,
      raw,
      forwardReturn20d
    });
  }

  return rows;
}

/**
 * Cross-sectional pass: for every offset present in the panel, computes
 * the mean ret20 across every row at that offset (a crude proxy for "how
 * the market/regime was doing at that point in time") and subtracts it
 * from each row's own ret20 to get relativeStrength20. Mutates in place.
 */
export function fillRelativeStrength(rows: PriceFeatureRow[]): void {
  const sumByOffset = new Map<number, number>();
  const countByOffset = new Map<number, number>();

  for (const row of rows) {
    const ret20 = row.raw[RET_INDEX.ret20];
    if (!Number.isFinite(ret20)) continue;
    sumByOffset.set(row.offset, (sumByOffset.get(row.offset) ?? 0) + ret20);
    countByOffset.set(row.offset, (countByOffset.get(row.offset) ?? 0) + 1);
  }

  for (const row of rows) {
    const ret20 = row.raw[RET_INDEX.ret20];
    if (!Number.isFinite(ret20)) continue;
    const count = countByOffset.get(row.offset) ?? 0;
    if (count === 0) continue;
    const marketMean = (sumByOffset.get(row.offset) ?? 0) / count;
    row.raw[RET_INDEX.relativeStrength20] = ret20 - marketMean;
  }
}

const FUNDAMENTALS_CACHE_TTL_SECONDS = 24 * 60 * 60;

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetches the extra fundamental fields the heuristic engine's `getProfile`
 * doesn't expose (growth, margins, price-to-sales, FCF yield). Cached
 * separately (24h, matching the profile cache's own TTL) so the graph
 * screen doesn't double the Yahoo Finance call volume of the heuristic
 * screen. Only ever used for the *live* (offset 0) similarity graph — see
 * graphRecommendationEngine.ts for why fundamentals never enter the
 * walk-forward-validated historical panel.
 */
export async function getFundamentalSnapshot(ticker: string): Promise<FundamentalSnapshot> {
  const cacheKey = `graph-fundamentals:${ticker}`;
  const empty: FundamentalSnapshot = Object.fromEntries(FUNDAMENTAL_FEATURE_NAMES.map((n) => [n, null])) as FundamentalSnapshot;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // fall through to a live fetch
  }

  try {
    const symbol = toYahooSymbol(ticker);
    const summary = await yahooFinance.quoteSummary(symbol, {
      modules: ["summaryDetail", "financialData"]
    });

    const detail: any = summary.summaryDetail;
    const financials: any = summary.financialData;

    const marketCap = finite(detail?.marketCap);
    const totalRevenue = finite(financials?.totalRevenue);
    const freeCashflow = finite(financials?.freeCashflow);

    const snapshot: FundamentalSnapshot = {
      peRatio: finite(detail?.trailingPE),
      priceToSales:
        finite(detail?.priceToSalesTrailing12Months) ??
        (marketCap != null && totalRevenue != null && totalRevenue !== 0 ? marketCap / totalRevenue : null),
      roe: financials?.returnOnEquity != null ? Number((financials.returnOnEquity * 100).toFixed(2)) : null,
      operatingMargin: financials?.operatingMargins != null ? Number((financials.operatingMargins * 100).toFixed(2)) : null,
      revenueGrowth: financials?.revenueGrowth != null ? Number((financials.revenueGrowth * 100).toFixed(2)) : null,
      earningsGrowth: financials?.earningsGrowth != null ? Number((financials.earningsGrowth * 100).toFixed(2)) : null,
      debtToEquity: finite(financials?.debtToEquity) != null ? Number((finite(financials?.debtToEquity)! / 100).toFixed(2)) : null,
      fcfYield: marketCap != null && marketCap !== 0 && freeCashflow != null ? Number(((freeCashflow / marketCap) * 100).toFixed(2)) : null
    };

    await redis.setex(cacheKey, FUNDAMENTALS_CACHE_TTL_SECONDS, JSON.stringify(snapshot)).catch(() => undefined);
    return snapshot;
  } catch {
    return empty;
  }
}
