# Seasonal Growth Forecast Recommendation Feature

The **fourth**, independent stock recommender in Invexa, alongside the
heuristic engine (`RECOMMENDATIONS_FEATURE.md`), the graph k-NN engine
(`GRAPH_RECOMMENDATIONS_FEATURE.md`), and the supervised ranking engine
(`RANKING_RECOMMENDATIONS_FEATURE.md`). All four are independent and can
disagree on the same ticker.

## The core enhancement: every month against every year, not one anchor

The starting design compared a single evaluation month against the same
month one and two years back — three data points per metric. This
engine instead builds the **entire seasonal panel**: every calendar
month compared against every prior year that has data for that same
month. For eight years of monthly prices that's up to seven year-over-
year points per calendar month, ~84 points total, instead of three.

That larger panel is what lets the engine:

1. **Target the evaluated month with real sample size.** `byMonth[m]`
   carries a mean, median, standard deviation, directional consistency,
   and (with ≥3 years of that specific month) a trend slope — not just
   the single most recent delta.
2. **Detect genuine seasonality.** A name that's reliably strong every
   September and weak every February shows up as different `byMonth`
   profiles per month; a name whose growth doesn't depend on the
   calendar shows roughly uniform profiles across months. (One
   consequence, confirmed by a sanity check while building this: a
   purely periodic seasonal pattern — the *same* December rally every
   single year — produces an *identical* YoY growth rate no matter which
   month you start from. That's expected and correct: comparing a full
   12-month cycle to the previous 12-month cycle is exactly what cancels
   out calendar-position noise. Real seasonal *edge* shows up as the
   month-to-month profiles diverging over time, not as differing in a
   single snapshot — which is why the trend slope per month, not just
   the mean, matters.)
3. **Measure acceleration honestly.** `trendSlopePerYear` is a real
   least-squares fit of that month's growth against year, not a single
   year's delta relabeled as a "trend."

See `backend/src/domain/recommendations/growth/seasonalAnalysis.ts` for
the implementation — it's metric-agnostic and reused for revenue,
earnings, EPS, free cash flow, price, and the synthetic industry series.

## Multi-metric, per the design note this engine follows

- **Company fundamentals**: revenue, earnings (net income), EPS, and
  free cash flow, each run through the seasonal panel, then blended
  30% / 30% / 20% / 20% into a fundamental growth score (weights
  renormalized over whichever metrics actually have data for a given
  ticker).
- **Price momentum**: the company's own price seasonal panel — this is
  where the "every month vs. every year" enhancement is deepest, since
  price is the one series with genuine multi-year monthly granularity.
- **Industry**: peers' price series median-aggregated period-by-period
  (industry *median* growth, not mean — the explicit refinement the
  design note calls for) and run through the same seasonal panel.
- **Peers**: each same-sector peer's own price seasonal estimate for the
  evaluated month, averaged.
- **Final blend**: fundamentals 70% / price momentum 20% / peer+industry
  10%, again renormalized over available components, converted to a
  0–100 score with a relative-growth term (company vs. industry) and an
  acceleration bonus from the trend slope.

## "In which months does this stock see the most ups and downs" — answered directly

Beyond the per-month profile, the engine now surfaces four explicit
highlights from that panel (`buildSeasonalityInsights` in
`seasonalAnalysis.ts`), each requiring at least 2 years of that specific
calendar month before it's eligible — a single lucky/unlucky year can't
crown itself "the best month":

- **Best month** — highest average YoY growth.
- **Worst month** — lowest average YoY growth.
- **Most volatile month** — highest standard deviation of YoY growth,
  i.e. the biggest swings *in either direction*. This is "most ups and
  downs" read literally, as distinct from "best" or "worst" on average —
  a month can be wildly volatile without being the best or the worst on
  average.
- **Most consistent month** — highest directional consistency
  (tie-broken by lower spread), for contrast with the volatile one.
- **Seasonal swing** — best month's mean minus worst month's mean, a
  single number for "how much does the calendar matter for this name."

Each calendar month also now carries a plain significance heuristic: a
one-sample t-statistic (`mean / (stdev / sqrt(n))`) and an `isNotable`
flag (|t| ≥ 1.5 and at least 3 years of that month). This is a modest
bar, not a rigorous statistical test — no small-sample correction is
applied — but it's the difference between "the highest number happened
to be June" and "June's pattern holds up given how much it varies."
`hasReliableSeasonality` is only true when at least one eligible month
clears that bar; when it isn't, the forecast says so explicitly instead
of presenting a best/worst month as settled fact, and confidence is
nudged down slightly (×0.9) to reflect that the seasonal read is weaker
evidence.

When the evaluated month itself is the historical best or worst month,
the forecast calls that out directly ("a seasonal tailwind/headwind, if
the pattern holds") — tying the general seasonality picture back to the
specific call being made right now.

The stock Research card visualizes this on the 12-month strip: a solid
green/red ring marks the best/worst month, a dashed ring marks the most
volatile one, and cell color intensity scales with the size of the
average move.



## Data-granularity honesty

Yahoo Finance's free API only exposes ~4 years of *annual* fundamentals
and ~4 quarters of *quarterly* fundamentals — not enough quarterly
history for a genuine multi-year seasonal comparison. This engine uses
the annual cadence for revenue/earnings/EPS/free cash flow (which is
also just how those numbers are actually reported) and reserves the
full monthly "every month vs. every year" treatment for price, where
years of real monthly granularity exist. EPS specifically is
approximated as `netIncome / currentSharesOutstanding` applied across
history, since a historical share-count series isn't available — this
is stated in the forecast's own `reasons` field, not hidden.

## Look-ahead bias

Annual fundamentals are matched to a period using the fiscal `endDate`
plus an assumed 75-day reporting lag (`fundamentalsData.ts`), so a
report is never treated as "known" before it would realistically have
been public — the same principle the design note requires ("a Q1 2026
report published on May 30, 2026 is forbidden data for a May 15
evaluation").

## Validation

Real walk-forward validation on the price seasonal signal specifically
(`evaluatePriceSeasonalWalkForward`): at several past cutoffs, the
seasonal profile is rebuilt using only periods up to that cutoff, a
prediction is made for the next occurrence of that calendar month, and
checked against what actually happened. Fundamentals have too few
annual points per ticker for a meaningful walk-forward and are not
included in `modelMetrics` — stated directly in code rather than
fabricating a metric from n=3.

## Dynamic thresholds

BUY/SELL are assigned from the 70th/30th percentile of this run's
cross-sectional score distribution (`assignGrowthSignals`), the same
approach the graph and ranking engines use, rather than the fixed
65/35 score cutoff — falling back to the fixed cutoff only when a run
doesn't have enough scored names for a percentile to mean anything
(e.g. the single-ticker endpoint).

## API surface

- `GET /growth-recommendations/meta`
- `GET /growth-recommendations?market=&sector=&signal=`
- `GET /stocks/:ticker/growth-recommendation`

## Frontend

- `GrowthRecommendationCard` — fourth card on a stock's Research page,
  including a 12-month seasonality strip highlighting the evaluated
  month.
- `RecommendationsPanel` — fourth tab ("Seasonal growth"), with the same
  market/sector/signal filters and a top-pick-per-sector view.
