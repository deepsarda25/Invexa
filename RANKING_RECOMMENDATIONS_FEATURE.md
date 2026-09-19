# Supervised Ranking Recommendation Feature (ridge regression + walk-forward)

This is the **third**, independent stock recommender in Invexa. It sits
next to the heuristic engine (`RECOMMENDATIONS_FEATURE.md`) and the graph
k-NN engine (`GRAPH_RECOMMENDATIONS_FEATURE.md`) without modifying
either. All three can and will disagree on the same ticker — that's by
design, not a bug to reconcile.

## Why a third model

The heuristic engine encodes analyst-style rules by hand. The graph
engine predicts from how similar historical setups actually turned out.
Neither of those is quite "the target should be explicit: given all data
available on date `t`, predict the stock's risk-adjusted return over the
next 20 trading days, then rank." This engine treats the problem as
exactly that — a time-series forecasting and cross-sectional ranking
problem — with a real, fitted, walk-forward-validated model behind it
rather than a third set of hand-tuned weights.

## The model

- **Target**: 20-session forward return, relative to the stock's own
  sector at the same point in time (`sectorRelativeReturn20d`). This is
  what stops the model from recommending everything just because the
  whole market — or the whole sector — is rallying.
- **Features**: the same seven point-in-time price/return/volatility
  features the graph engine already builds (`ret20`, `ret60`, `ret120`,
  `volatility20`, `maxDrawdown120`, `distanceFrom52wHigh`,
  `relativeStrength20`) — reused directly from `graph/features.ts` rather
  than re-derived, so both models are trained and judged on identical
  evidence.
- **Model**: ridge-regularized linear regression, trained with batch
  gradient descent (`ranking/model.ts`). For a handful of engineered,
  standardized features and a JavaScript-only runtime with no Python
  model service available, this is the right-sized model — an
  LSTM/Transformer here would mean more parameters than signal.
- **Fundamentals are deliberately excluded from training**, for the
  identical reason the graph engine excludes them: Yahoo Finance's free
  API only has *current* fundamentals, no point-in-time history, so using
  today's P/E to "explain" a return from months ago would be look-ahead
  bias baked into a model instead of a scoring formula.
- **Validation**: real walk-forward evaluation (`evaluateWalkForward` in
  `rankingEngine.ts`) — a fresh model is retrained at each evaluation
  offset using only rows whose 20-session outcome had already resolved
  by that point, mirroring the graph engine's causal-ordering rule
  exactly. `modelMetrics` (hit rate, predicted-vs-realized correlation,
  average/net/worst returns) comes from that check, not an assumed
  number.
- **Ranking**: BUY/HOLD/SELL thresholds are set from the *live*
  cross-sectional distribution of predictions each run (70th/30th
  percentile), the same approach the graph engine uses, rather than a
  constant that never adapts to regime.
- **Explainability**: each result carries `featureContributions` — the
  z-scored feature value times its learned weight — so a user can see
  which inputs actually drove a specific call, not just the headline
  number.

## API surface

- `GET /ranking-recommendations/meta`
- `GET /ranking-recommendations?market=&sector=&signal=`
- `GET /stocks/:ticker/ranking-recommendation`

Response shapes mirror the existing heuristic/graph list and detail
responses (`results`, `topPicksBySector`, `universeSize`, `scoredCount`,
`noDataCount`, `modelMetrics`, `disclaimer`).

## Frontend

- `RankingRecommendationCard` — third card on a stock's Research page,
  next to the heuristic and k-NN cards.
- `RecommendationsPanel` — third tab ("Ranking model") next to
  "Heuristic" and "Graph analysis" on the Market Recommendations screen,
  with the same market/sector/signal filters and a top-pick-per-sector
  view.

## Naming

Per the terminal's existing convention of stating what a signal actually
is rather than a generic label, two headings were renamed for clarity:

- The heuristic engine's card heading: **"Recommendation" → "Heuristic,
  rules-based screening signal derived Recommendation."**
- The graph engine's card heading: **"Graph Recommendation (k-NN)" →
  "K-NN Recommendation."**

The new engine's card follows the same pattern: **"Ranking Recommendation
(Regression)."**
