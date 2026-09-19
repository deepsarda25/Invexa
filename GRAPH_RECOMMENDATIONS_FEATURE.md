# Graph-Based Peer Recommendation Feature (v2: sector-neutralized k-NN)

This is the second, independent stock recommender in Invexa, sitting next
to the heuristic engine (`RECOMMENDATIONS_FEATURE.md`) without modifying
it. It replaces an earlier prototype that called itself "graph analysis"
but was mostly pairwise price correlation + sector tagging + recent
momentum with hard-coded weights and thresholds.

**This version is a genuine sector-neutralized, feature-based
k-nearest-neighbor model with a real (if scoped) walk-forward
validation.** It predicts a stock's 20-session forward return from how
*historically similar setups* — anywhere in the universe, at any past
point in time, not just "this stock's current peers" — actually turned
out, rather than assuming "correlated peers are up" is itself a reason to
buy.

## Why the rewrite, in one paragraph

Correlation and sector membership tell you two things move together, not
that either is a good trade, and using a fixed `68/42` cutoff — or fixed
`75%/25%` edge weights — has no statistical basis. The redesign fixes
this by: (1) building similarity from multiple normalized price and
sector/industry features rather than raw correlation, (2) sector-
neutralizing so "the whole sector is up" doesn't look like idiosyncratic
strength, (3) predicting from peers' **realized historical forward
returns**, not their current momentum, (4) setting BUY/SELL thresholds
from the live cross-sectional distribution of predictions instead of a
constant, and (5) actually checking, with a walk-forward test computed
from real price history, whether any of this has had predictive value —
instead of asserting that it does.

## The one thing I did *not* fake, and why

The original design asked for peers' "historically observed forward
returns" and a walk-forward evaluator. Doing that honestly for a
**fundamentals-aware** model requires point-in-time historical
fundamentals (what was the P/E four months ago, not today) — a dataset
neither Yahoo Finance's free API nor this app has. Using *today's*
fundamentals to help "explain" a stock's price move from months ago would
be look-ahead bias, just a subtler version of the exact problem this
rewrite exists to fix.

So the model is split honestly:

- **Price-based features** (returns, volatility, drawdown, distance from
  52-week high, cross-sectional relative strength) *do* have real
  history — the app already fetches ~400 days of daily OHLC per ticker.
  These get a genuine, checkable walk-forward test (see below).
- **Fundamentals** (P/E, margins, growth, leverage, FCF yield) enter only
  the **live** similarity graph, purely as a *display/context* similarity
  score on each shown neighbor (`fundamentalSimilarity`) — never the
  predicted return, and never validated historically, because that
  validation isn't possible without data this app doesn't have. Building
  a point-in-time fundamentals database is real future work; pretending
  to validate one now would just move the dishonesty, not remove it.

## How the model works

```
price history (≈400 sessions/ticker)
    ↓
feature panel, built at many historical "offsets" (bars back from now)
  ret20, ret60, ret120, volatility20, maxDrawdown120,
  distanceFrom52wHigh, relativeStrength20 (this name's ret20 vs.
  the universe's average ret20 at that same offset)
    ↓
cross-sectional z-score normalization (whole panel, every offset)
    ↓
sector neutralization (subtract each sector's own mean per feature)
    ↓
similarity(i, j) = 45% price-feature cosine + 25% return-profile cosine
                  + 15% sector match + 15% industry match
    ↓
walk-forward evaluation (offset-based causal ordering, see below)
    ↓
live k-NN prediction per ticker:
  peerVote = Σ(similarity² × peer's realized forward return) / Σ(similarity²)
  predictedReturn20d = 70% peerVote + 20% own 20d momentum + 10% market regime
    ↓
BUY/HOLD/SELL from this run's live 70th/30th percentile of predictions
```

### No-look-ahead rule

Every row in the panel is addressed by **offset** — sessions back from
"now" — rather than a calendar date (there's no persisted, date-indexed
historical store yet; see Known Limitations). A row's `forwardReturn20d`
is the realized return from that offset to 20 sessions later, and it's
only populated when that window has actually elapsed. The walk-forward
evaluator enforces: when scoring a target at `offset = o`, only candidate
rows with `offset ≥ o + 20` (i.e. whose own outcome had already resolved
by the time the target is being evaluated) are eligible peers. Live
predictions use the same rule with `o = 0`.

### What the walk-forward check actually proves — and doesn't

`modelMetrics` (`hitRate`, `averageReturn`, `netAverageReturn`,
`worstBuyReturn`, `sampleCount`) is computed for real, from the same
panel, with transaction costs deducted from the BUY-only return. We
sanity-checked the evaluator two ways before trusting it:

- On synthetic data with a genuine trend split (half the names drifting
  up, half down), it correctly clustered each name with its own trend
  and reported an ~88% hit rate.
- On pure random-walk noise with **no** signal, it correctly reported an
  ~48% hit rate — i.e. it does not fabricate apparent skill where none
  exists.

The honest caveat: because every row comes from one universe-wide price
snapshot, this validates "does the k-NN logic have signal within the
market regimes covered by the last ~400 sessions," not "does it hold up
across independent, never-before-seen market regimes collected over
calendar time." The latter is the real bar for a `HIGH`-confidence
production model and requires accumulating genuinely new out-of-sample
days as the app runs — a natural next step, not something a single
snapshot can produce.

## Files

```
backend/src/domain/recommendations/graph/
├── types.ts                    shared types (FeatureRow, GraphNeighbor, GraphRecommendation, GraphModelMetrics, ...)
├── features.ts                 price feature construction across historical offsets + fundamentals fetch (cached)
├── normalize.ts                cross-sectional z-scores, sector neutralization, percentile()
├── similarity.ts                cosine similarity + the 45/25/15/15 blended edge weight
├── knnPredictor.ts             weighted k-NN prediction from a candidate pool of historical analogs
├── walkForward.ts              the no-look-ahead walk-forward evaluator
└── graphRecommendationEngine.ts orchestrator: builds the panel, runs walk-forward, produces live predictions + dynamic thresholds

backend/src/modules/graphRecommendations.ts   Elysia routes (unchanged endpoints, new response shape)
frontend/src/components/GraphRecommendationCard.tsx   per-ticker card (predicted return, confidence, analog table, walk-forward stats)
frontend/src/components/RecommendationsPanel.tsx       Heuristic / Graph analysis toggle, GraphRecommendationTile
frontend/src/api/client.ts                             GraphRecommendation / GraphNeighbor / GraphModelMetrics types + client functions
```

## API

Same three endpoints as before, new response shape:

```
GET /graph-recommendations/meta
GET /graph-recommendations?market=NSE|BSE|US&sector=<sector>&signal=BUY|HOLD|SELL|NO_DATA|ALL
GET /stocks/:ticker/graph-recommendation
```

```json
{
  "ticker": "AAPL",
  "method": "GRAPH_KNN",
  "signal": "BUY",
  "predictedReturn20d": 0.0461,
  "confidence": 0.926,
  "buyThreshold": 0.031,
  "sellThreshold": -0.018,
  "neighbors": [
    {
      "ticker": "MSFT",
      "similarity": 0.91,
      "offset": 46,
      "historicalForwardReturn20d": 0.083,
      "fundamentalSimilarity": 0.78
    }
  ],
  "modelMetrics": {
    "hitRate": 0.61,
    "averageReturn": 0.021,
    "netAverageReturn": 0.014,
    "worstBuyReturn": -0.09,
    "sampleCount": 412
  },
  "reasons": [
    "6 historical peer analogs matched above the similarity threshold.",
    "Those analogs realized an average 20-session forward return of 6.1%.",
    "Model prediction blends peer analogs (70%), the stock's own 20-session momentum (20%), and market regime (10%).",
    "Broad market regime term is currently supportive (1.8%).",
    "Closest analogs drawn from: MSFT, GOOGL, NVDA.",
    "Predicted 20-session forward return: 4.6%."
  ]
}
```

## Caching (unchanged pattern from v1)

Price history per ticker: `graph-history:<ticker>`, 15 min. Fundamentals:
`graph-fundamentals:<ticker>`, 24h (matches the heuristic engine's own
profile cache TTL). Full computed result sets:
`graph-recommendations:v2:<market>:<sector>`, 15 min. Concurrency capped
at 5 for both history and fundamentals fetches.

## What I deliberately did *not* build yet, and why

Following the original doc's own suggested ordering (its step 9): an
**ensemble** combining this model with the heuristic engine should only
be built once both have *independent, measured* out-of-sample reliability
— which neither has yet (this model's walk-forward is single-snapshot;
the heuristic engine has never been backtested at all). Wiring an
ensemble today would mean inventing the "reliability" weights the
formula needs, which is exactly the kind of unjustified constant this
whole rewrite exists to remove. Once there's a real, calendar-time
accumulated track record for both models, the ensemble formula from the
original doc is a reasonable next step.

## Known limitations (stated plainly)

- **Offset ≠ calendar date.** All tickers' offsets are anchored to their
  own most-recent close from a single fetch, not a shared calendar. This
  is a reasonable approximation for a same-snapshot cross-sectional
  comparison but is not equivalent to a proper date-indexed panel — see
  above.
- **Single-snapshot validation.** `modelMetrics` will look the same every
  time it's recomputed from the same ~400-day window until the app
  accumulates new sessions over time. A production-grade validation needs
  genuinely new, sequentially-arriving out-of-sample days.
- **Fundamentals are context, not signal.** `fundamentalSimilarity` never
  affects `predictedReturn20d` or `signal` — by design, for the reasons
  above.
- **Neighbor list is deduplicated by ticker.** Early testing surfaced the
  same company appearing several times in the shown analog list (e.g.
  `SUNPHARMA.NS` at three different historical offsets) — cosmetically
  repetitive, but also a real problem: those rows are highly
  autocorrelated snapshots of one company's own history, not independent
  peer evidence, so letting them fill most of the neighbor slots quietly
  narrowed the peer set to 2-3 companies while looking like N analogs
  (pseudo-replication). `knnPredictor.ts` now keeps only each ticker's
  single closest-matching historical analog before ranking, both for the
  live display and inside the walk-forward evaluator.
- **Transaction cost (20 bps round-trip) and the "would-have-been-BUY"
  proxy threshold (2% predicted return) used inside the evaluator are
  fixed assumptions**, not calibrated to any specific broker or market —
  same category of caveat as the heuristic engine's own assumptions.
- **No portfolio-level backtest.** `netAverageReturn`/`worstBuyReturn` are
  per-call statistics on independent BUY calls, not an equity curve with
  position sizing, overlap handling, or turnover — the original doc
  correctly flagged this same gap in its own sample evaluator.
