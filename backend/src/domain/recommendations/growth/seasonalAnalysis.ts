/**
 * Generic, metric-agnostic seasonal year-over-year analysis.
 *
 * The starting design for this engine compared a single evaluation month
 * against the same month one and two years back (three data points). The
 * enhancement here: given *any* monthly time series, compare *every*
 * calendar month against *every* prior year that's available for that
 * same month, not just the one month being evaluated. That turns "three
 * anchored comparisons" into a full seasonal panel — e.g. for eight years
 * of monthly prices, up to seven YoY points per calendar month, 84 points
 * total — which is what actually lets the engine (a) target the specific
 * calendar month being evaluated with real sample size instead of n=2,
 * (b) detect whether a name is genuinely seasonal (strong every
 * September, weak every February), and (c) measure whether a given
 * month's growth is accelerating or decelerating across years via a real
 * trend line instead of a single year-over-year delta.
 */

export type PeriodValue = { period: string; value: number };

export type SeasonalYoYPoint = {
  /** "current" period, YYYY-MM */
  period: string;
  previousPeriod: string;
  month: number; // 1-12
  year: number;
  currentValue: number;
  previousValue: number;
  growthPercent: number;
};

export type MonthlySeasonalProfile = {
  month: number; // 1-12
  sampleCount: number;
  meanGrowthPercent: number | null;
  medianGrowthPercent: number | null;
  stdevGrowthPercent: number | null;
  /** 0..1 — fraction of this month's YoY points sharing the sign of the median. */
  consistency: number;
  latestGrowthPercent: number | null;
  latestYear: number | null;
  /** Slope of growth-percent vs. year from a least-squares fit over this month's own YoY points — positive means this specific calendar month's growth has been accelerating year over year, negative means decelerating. Null with fewer than 3 points (a slope from 2 points is just the single delta again, not a trend). */
  trendSlopePerYear: number | null;
  /** mean / (stdev / sqrt(n)) — a one-sample t-statistic testing "is this month's average growth distinguishable from zero, given how much it varies year to year." Null below 2 samples or when stdev is 0. This is a plain significance heuristic, not a rigorous test (no small-sample correction) — treat it as "worth a second look" rather than proof. */
  tStatistic: number | null;
  /** True only when |tStatistic| clears a modest bar (>= 1.5) AND there are at least 3 years of this specific month to back it — the two together are what separate "looks seasonal" from "three lucky/unlucky years." */
  isNotable: boolean;
};

export type SeasonalProfile = {
  points: SeasonalYoYPoint[];
  /** Always length 12, index 0 = January, regardless of data coverage (empty months have sampleCount 0 and null stats). */
  byMonth: MonthlySeasonalProfile[];
  overall: {
    sampleCount: number;
    meanGrowthPercent: number | null;
    medianGrowthPercent: number | null;
    /** Mean growth weighted toward more recent years (exponential decay by year distance) — a single "current trajectory" number that isn't dominated by a stale early year the way a flat average can be. */
    recencyWeightedGrowthPercent: number | null;
    consistency: number;
    yearsSpanned: number;
  };
};

export function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid];
}

export function mean(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  return clean.length ? clean.reduce((sum, v) => sum + v, 0) / clean.length : null;
}

export function stdev(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return null;
  const m = mean(clean)!;
  const variance = clean.reduce((sum, v) => sum + (v - m) ** 2, 0) / clean.length;
  return Math.sqrt(variance);
}

/** Simple least-squares slope of y against x. Returns null for fewer than 3 points or zero x-variance. */
export function linearSlope(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}

function parsePeriod(period: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  return { year, month };
}

function formatPeriod(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function calculateGrowthPercent(currentValue: number, previousValue: number): number | null {
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue) || previousValue === 0) return null;
  return ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
}

/**
 * Builds every available year-over-year comparison in `series`: for each
 * period present, if the same calendar month exactly one year earlier is
 * also present, that's a YoY point. Unlike a single anchored comparison,
 * this uses the *entire* history the series has to offer.
 */
export function buildSeasonalYoYPoints(series: PeriodValue[]): SeasonalYoYPoint[] {
  const byPeriod = new Map<string, number>();
  for (const row of series) {
    if (Number.isFinite(row.value)) byPeriod.set(row.period, row.value);
  }

  const points: SeasonalYoYPoint[] = [];
  for (const [period, currentValue] of byPeriod.entries()) {
    const parsed = parsePeriod(period);
    if (!parsed) continue;
    const previousPeriod = formatPeriod(parsed.year - 1, parsed.month);
    const previousValue = byPeriod.get(previousPeriod);
    if (previousValue == null) continue;
    const growthPercent = calculateGrowthPercent(currentValue, previousValue);
    if (growthPercent == null) continue;
    points.push({
      period,
      previousPeriod,
      month: parsed.month,
      year: parsed.year,
      currentValue,
      previousValue,
      growthPercent
    });
  }

  return points.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

const RECENCY_DECAY = 0.75; // per year — recent years count noticeably more without letting one outlier year dominate

function buildMonthlyProfile(month: number, monthPoints: SeasonalYoYPoint[]): MonthlySeasonalProfile {
  if (monthPoints.length === 0) {
    return {
      month,
      sampleCount: 0,
      meanGrowthPercent: null,
      medianGrowthPercent: null,
      stdevGrowthPercent: null,
      consistency: 0,
      latestGrowthPercent: null,
      latestYear: null,
      trendSlopePerYear: null,
      tStatistic: null,
      isNotable: false
    };
  }

  const sorted = [...monthPoints].sort((a, b) => a.year - b.year);
  const growthValues = sorted.map((p) => p.growthPercent);
  const med = median(growthValues);
  const expectedSign = (med ?? 0) >= 0 ? 1 : -1;
  const consistency = growthValues.filter((g) => (g >= 0 ? 1 : -1) === expectedSign).length / growthValues.length;
  const meanValue = mean(growthValues);
  const stdevValue = stdev(growthValues);
  const tStatistic =
    meanValue != null && stdevValue != null && stdevValue > 0 && sorted.length >= 2
      ? meanValue / (stdevValue / Math.sqrt(sorted.length))
      : null;
  const isNotable = tStatistic != null && Math.abs(tStatistic) >= 1.5 && sorted.length >= 3;

  return {
    month,
    sampleCount: sorted.length,
    meanGrowthPercent: meanValue,
    medianGrowthPercent: med,
    stdevGrowthPercent: stdevValue,
    consistency,
    latestGrowthPercent: sorted[sorted.length - 1].growthPercent,
    latestYear: sorted[sorted.length - 1].year,
    trendSlopePerYear: linearSlope(
      sorted.map((p) => p.year),
      growthValues
    ),
    tStatistic,
    isNotable
  };
}

/**
 * The full seasonal analysis for one metric series: every YoY point the
 * data supports, a per-calendar-month profile for all 12 months, and an
 * overall cross-month summary. `asOfPeriod`, if given, discards any
 * period strictly after it first — this is what keeps a walk-forward
 * evaluation (see growthForecastEngine.ts) honest: a profile "as of"
 * some past month never sees data that hadn't happened yet.
 */
export function buildSeasonalProfile(series: PeriodValue[], asOfPeriod?: string): SeasonalProfile {
  const filtered = asOfPeriod ? series.filter((row) => row.period <= asOfPeriod) : series;
  const points = buildSeasonalYoYPoints(filtered);

  const byMonth: MonthlySeasonalProfile[] = [];
  for (let m = 1; m <= 12; m += 1) {
    byMonth.push(buildMonthlyProfile(m, points.filter((p) => p.month === m)));
  }

  const allGrowth = points.map((p) => p.growthPercent);
  const overallMedian = median(allGrowth);
  const expectedSign = (overallMedian ?? 0) >= 0 ? 1 : -1;
  const consistency = allGrowth.length > 0 ? allGrowth.filter((g) => (g >= 0 ? 1 : -1) === expectedSign).length / allGrowth.length : 0;

  const years = points.map((p) => p.year);
  const latestYear = years.length ? Math.max(...years) : null;
  let recencyWeightedGrowthPercent: number | null = null;
  if (latestYear != null && points.length > 0) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const p of points) {
      const weight = RECENCY_DECAY ** (latestYear - p.year);
      weightedSum += weight * p.growthPercent;
      weightTotal += weight;
    }
    recencyWeightedGrowthPercent = weightTotal > 0 ? weightedSum / weightTotal : null;
  }

  return {
    points,
    byMonth,
    overall: {
      sampleCount: points.length,
      meanGrowthPercent: mean(allGrowth),
      medianGrowthPercent: overallMedian,
      recencyWeightedGrowthPercent,
      consistency,
      yearsSpanned: years.length ? Math.max(...years) - Math.min(...years) + 1 : 0
    }
  };
}

/**
 * The single number the forecast engine actually uses for a given
 * calendar month: prefer that month's own seasonal signal when there's
 * enough history to trust it (>= `minMonthSamples` YoY points), fall
 * back to the recency-weighted cross-month signal otherwise. This is the
 * "target the evaluated month specifically, but don't pretend n=1 is a
 * pattern" rule.
 */
export function seasonalGrowthEstimate(profile: SeasonalProfile, evaluationMonth: number, minMonthSamples = 2): number | null {
  const monthProfile = profile.byMonth[evaluationMonth - 1];
  if (monthProfile && monthProfile.sampleCount >= minMonthSamples && monthProfile.meanGrowthPercent != null) {
    return monthProfile.meanGrowthPercent;
  }
  return profile.overall.recencyWeightedGrowthPercent ?? monthProfile?.latestGrowthPercent ?? null;
}

/**
 * Median-aggregates several series into one synthetic series, period by
 * period. Used to build an "industry" series from its member peers'
 * series without one large-cap peer dominating the way a mean would —
 * exactly the "industry median growth, not only average growth"
 * refinement.
 */
export function medianAggregateSeries(seriesList: PeriodValue[][]): PeriodValue[] {
  const byPeriod = new Map<string, number[]>();
  for (const series of seriesList) {
    for (const row of series) {
      if (!Number.isFinite(row.value)) continue;
      const list = byPeriod.get(row.period) ?? [];
      list.push(row.value);
      byPeriod.set(row.period, list);
    }
  }
  const result: PeriodValue[] = [];
  for (const [period, values] of byPeriod.entries()) {
    const m = median(values);
    if (m != null) result.push({ period, value: m });
  }
  return result.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? `Month ${month}`;
}

export type MonthHighlight = {
  month: number;
  monthName: string;
  meanGrowthPercent: number;
  stdevGrowthPercent: number | null;
  sampleCount: number;
  consistency: number;
  isNotable: boolean;
};

/**
 * "In which months does this stock see the most ups and downs" — answered
 * directly, from the per-calendar-month profiles that
 * `buildSeasonalProfile` already computes:
 *
 * - `bestMonth` / `worstMonth`: highest and lowest average YoY growth —
 *   the calendar months this name has historically gone up the most /
 *   down the most.
 * - `mostVolatileMonth`: highest standard deviation of YoY growth — the
 *   month with the biggest swings *either direction*, which is "most ups
 *   and downs" read literally rather than "best" or "worst" on average.
 * - `mostConsistentMonth`: highest directional consistency (tie-broken by
 *   lower spread) — the most dependable month, for contrast.
 *
 * Only months with at least `minSamples` years of data are eligible, so
 * a single lucky/unlucky year can't crown itself "the best month" — and
 * `hasReliableSeasonality` is false unless at least one eligible month
 * also clears the `isNotable` significance bar, so the headline can be
 * shown alongside an honest "this may just be noise" caveat when it
 * should be.
 */
export type SeasonalityInsights = {
  bestMonth: MonthHighlight | null;
  worstMonth: MonthHighlight | null;
  mostVolatileMonth: MonthHighlight | null;
  mostConsistentMonth: MonthHighlight | null;
  /** bestMonth's mean minus worstMonth's mean — the overall amplitude of this name's seasonality, in percentage points. */
  seasonalSwingPercent: number | null;
  /** How many of the 12 calendar months have at least `minSamples` years of history behind them. */
  monthsWithEnoughData: number;
  /** True only when at least one eligible month's pattern clears the significance bar in MonthlySeasonalProfile.isNotable. */
  hasReliableSeasonality: boolean;
};

function toHighlight(profile: MonthlySeasonalProfile): MonthHighlight | null {
  if (profile.meanGrowthPercent == null) return null;
  return {
    month: profile.month,
    monthName: monthName(profile.month),
    meanGrowthPercent: profile.meanGrowthPercent,
    stdevGrowthPercent: profile.stdevGrowthPercent,
    sampleCount: profile.sampleCount,
    consistency: profile.consistency,
    isNotable: profile.isNotable
  };
}

export function buildSeasonalityInsights(byMonth: MonthlySeasonalProfile[], minSamples = 2): SeasonalityInsights {
  const eligible = byMonth.filter((m) => m.sampleCount >= minSamples && m.meanGrowthPercent != null);

  if (eligible.length === 0) {
    return {
      bestMonth: null,
      worstMonth: null,
      mostVolatileMonth: null,
      mostConsistentMonth: null,
      seasonalSwingPercent: null,
      monthsWithEnoughData: 0,
      hasReliableSeasonality: false
    };
  }

  const best = eligible.reduce((a, b) => (b.meanGrowthPercent! > a.meanGrowthPercent! ? b : a));
  const worst = eligible.reduce((a, b) => (b.meanGrowthPercent! < a.meanGrowthPercent! ? b : a));

  const withVolatility = eligible.filter((m) => m.stdevGrowthPercent != null);
  const mostVolatile =
    withVolatility.length > 0 ? withVolatility.reduce((a, b) => (b.stdevGrowthPercent! > a.stdevGrowthPercent! ? b : a)) : null;

  const mostConsistent = eligible.reduce((a, b) => {
    if (b.consistency !== a.consistency) return b.consistency > a.consistency ? b : a;
    const bStdev = b.stdevGrowthPercent ?? Infinity;
    const aStdev = a.stdevGrowthPercent ?? Infinity;
    return bStdev < aStdev ? b : a;
  });

  return {
    bestMonth: toHighlight(best),
    worstMonth: toHighlight(worst),
    mostVolatileMonth: mostVolatile ? toHighlight(mostVolatile) : null,
    mostConsistentMonth: toHighlight(mostConsistent),
    seasonalSwingPercent: best.meanGrowthPercent! - worst.meanGrowthPercent!,
    monthsWithEnoughData: eligible.length,
    hasReliableSeasonality: eligible.some((m) => m.isNotable)
  };
}
