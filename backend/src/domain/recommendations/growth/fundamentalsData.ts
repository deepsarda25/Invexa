import YahooFinance from "yahoo-finance2";
import { redis } from "../../../lib/redis";
import { toYahooSymbol } from "../../market/tickerSymbols";
import type { PeriodValue } from "./seasonalAnalysis";

const yahooFinance = new YahooFinance();

/**
 * Annual, not quarterly. Yahoo Finance's free `quoteSummary` endpoint
 * only exposes the trailing ~4 quarters of quarterly statements — not
 * enough years of quarterly history to run a genuine multi-year seasonal
 * comparison. Its annual statement history goes back further (typically
 * ~4 fiscal years), which is exactly the cadence real revenue/earnings/
 * EPS/free-cash-flow growth is reported at anyway. Price, by contrast,
 * has genuine multi-year monthly granularity — that's where the "every
 * calendar month against every year" seasonal analysis in
 * seasonalAnalysis.ts does its most useful work. This module is honest
 * about that asymmetry rather than fabricating monthly fundamentals that
 * don't exist.
 */
export type FundamentalMetricSeries = {
  revenue: PeriodValue[];
  netIncome: PeriodValue[];
  eps: PeriodValue[];
  freeCashFlow: PeriodValue[];
};

const EMPTY_FUNDAMENTALS: FundamentalMetricSeries = { revenue: [], netIncome: [], eps: [], freeCashFlow: [] };

const FUNDAMENTALS_CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Annual filings are not published the instant the fiscal year ends —
 * typically 45-90 days later. Yahoo's history rows only carry the fiscal
 * `endDate`, not the actual filing/publish date, so a fixed conservative
 * lag is added before a row is considered "known" as of a given
 * evaluation date. This is the same look-ahead-bias safeguard the design
 * note for this engine calls out explicitly: a report should never be
 * used to score a date before it was actually public.
 */
const ASSUMED_REPORTING_LAG_DAYS = 75;

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function periodOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The period this row is safe to use starting from — fiscal end date plus the assumed reporting lag. */
function knownAsOfPeriod(endDate: Date): string {
  const knownFrom = new Date(endDate.getTime() + ASSUMED_REPORTING_LAG_DAYS * 24 * 60 * 60 * 1000);
  return periodOf(knownFrom);
}

/**
 * Fetches annual revenue, net income, free cash flow, and an
 * approximate EPS series for a ticker.
 *
 * EPS caveat, stated plainly: Yahoo's free annual statements don't carry
 * a historical shares-outstanding series, so annual EPS here is
 * approximated as `netIncome / currentSharesOutstanding` — the current
 * share count applied across all historical years. That understates EPS
 * growth for a company that has bought back or issued significant stock,
 * since the real historical denominator would have differed. Flagged as
 * an approximation in the result's `reasons` by the caller, not silently
 * presented as precise.
 */
export async function getFundamentalHistory(ticker: string): Promise<FundamentalMetricSeries> {
  const cacheKey = `growth-fundamentals:${ticker}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // fall through to a live fetch
  }

  try {
    const symbol = toYahooSymbol(ticker);
    const summary = await yahooFinance.quoteSummary(symbol, {
      modules: ["incomeStatementHistory", "cashflowStatementHistory", "defaultKeyStatistics"]
    });

    const incomeRows: any[] = (summary as any).incomeStatementHistory?.incomeStatementHistory ?? [];
    const cashflowRows: any[] = (summary as any).cashflowStatementHistory?.cashflowStatementHistory ?? [];
    const sharesOutstanding = finite((summary as any).defaultKeyStatistics?.sharesOutstanding);

    const revenue: PeriodValue[] = [];
    const netIncome: PeriodValue[] = [];
    const eps: PeriodValue[] = [];

    for (const row of incomeRows) {
      const endDate = toDate(row?.endDate);
      if (!endDate) continue;
      const period = knownAsOfPeriod(endDate);

      const totalRevenue = finite(row?.totalRevenue);
      if (totalRevenue != null) revenue.push({ period, value: totalRevenue });

      const income = finite(row?.netIncome);
      if (income != null) {
        netIncome.push({ period, value: income });
        if (sharesOutstanding != null && sharesOutstanding !== 0) {
          eps.push({ period, value: income / sharesOutstanding });
        }
      }
    }

    const freeCashFlow: PeriodValue[] = [];
    for (const row of cashflowRows) {
      const endDate = toDate(row?.endDate);
      if (!endDate) continue;
      const period = knownAsOfPeriod(endDate);

      const operatingCashFlow = finite(row?.totalCashFromOperatingActivities);
      const capex = finite(row?.capitalExpenditures); // Yahoo reports this as a negative number
      if (operatingCashFlow != null && capex != null) {
        freeCashFlow.push({ period, value: operatingCashFlow + capex });
      } else if (operatingCashFlow != null) {
        freeCashFlow.push({ period, value: operatingCashFlow });
      }
    }

    const result: FundamentalMetricSeries = { revenue, netIncome, eps, freeCashFlow };
    await redis.setex(cacheKey, FUNDAMENTALS_CACHE_TTL_SECONDS, JSON.stringify(result)).catch(() => undefined);
    return result;
  } catch {
    return EMPTY_FUNDAMENTALS;
  }
}
