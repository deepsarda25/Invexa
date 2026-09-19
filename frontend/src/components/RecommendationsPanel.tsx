import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getRecommendations,
  getGraphRecommendations,
  getRankingRecommendations,
  getGrowthRecommendations,
  type RecommendationMarket,
  type RecommendationSignal,
  type StockRecommendation,
  type GraphRecommendation,
  type GraphSignal,
  type RankingRecommendation,
  type RankingSignal,
  type GrowthForecast,
  type GrowthSignal
} from "../api/client";

function fmtMoney(value: number | null, currency: "INR" | "USD") {
  if (value == null) return "N/A";
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

function RecommendationTile({ item }: { item: StockRecommendation }) {
  return (
    <article className={`recommendation-card signal-${item.signal.toLowerCase()}`}>
      <div className="recommendation-card-top">
        <div>
          <strong style={{ display: "block" }}>{item.ticker}</strong>
          <span style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>{item.name}</span>
        </div>
        <span className={`badge badge-${item.signal.toLowerCase()}`}>{item.signal.replace("_", " ")}</span>
      </div>

      <div className="recommendation-meta">
        <span>{item.market}</span>
        <span>{item.sector}</span>
        <span>Score {item.score}/100</span>
        <span>Risk {item.riskRating}</span>
      </div>

      <dl className="recommendation-fields">
        <div>
          <dt>Price</dt>
          <dd>
            {fmtMoney(item.currentPrice, item.currency)}
            {item.inrEquivalent && (
              <span style={{ display: "block", fontSize: "0.68rem", color: "var(--text-3)", fontWeight: 400 }}>
                ≈ {fmtMoney(item.inrEquivalent.currentPrice, "INR")}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Buy range</dt>
          <dd>
            {item.levels.buyRange
              ? `${fmtMoney(item.levels.buyRange.low, item.currency)} – ${fmtMoney(item.levels.buyRange.high, item.currency)}`
              : item.signal === "SELL"
                ? "n/a (Sell)"
                : "N/A"}
          </dd>
        </div>
        <div>
          <dt>{item.signal === "SELL" ? "Downside target" : "Target"}</dt>
          <dd>
            {item.levels.targetRange
              ? `${fmtMoney(item.levels.targetRange.low, item.currency)} – ${fmtMoney(item.levels.targetRange.high, item.currency)}`
              : "N/A"}
          </dd>
        </div>
        <div>
          <dt>{item.signal === "SELL" ? "Invalidation" : "Stop-loss"}</dt>
          <dd>{fmtMoney(item.levels.stopLoss, item.currency)}</dd>
        </div>
      </dl>

      {item.reasons.length > 0 && (
        <ul className="recommendation-reasons">
          {item.reasons.slice(0, 3).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <span style={{ fontSize: "0.68rem", color: "var(--text-3)" }}>
        Updated {new Date(item.timestamp).toLocaleTimeString()} · {item.source}
      </span>
    </article>
  );
}

function pctOrNA(value: number | null, digits = 1): string {
  return value == null ? "N/A" : `${(value * 100).toFixed(digits)}%`;
}

function GraphRecommendationTile({ item }: { item: GraphRecommendation }) {
  return (
    <article className={`recommendation-card signal-${item.signal.toLowerCase()}`}>
      <div className="recommendation-card-top">
        <div>
          <strong style={{ display: "block" }}>{item.ticker}</strong>
          <span style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>{item.name ?? item.sector}</span>
        </div>
        <span className={`badge badge-${item.signal.toLowerCase()}`}>{item.signal.replace("_", " ")}</span>
      </div>

      <div className="recommendation-meta">
        <span>{item.market}</span>
        <span>{item.sector}</span>
        <span>Predicted 20d {pctOrNA(item.predictedReturn20d)}</span>
        <span>Confidence {Math.round(item.confidence * 100)}%</span>
      </div>

      <dl className="recommendation-fields">
        <div>
          <dt>BUY threshold</dt>
          <dd>{pctOrNA(item.buyThreshold)}</dd>
        </div>
        <div>
          <dt>SELL threshold</dt>
          <dd>{pctOrNA(item.sellThreshold)}</dd>
        </div>
        <div>
          <dt>Analogs matched</dt>
          <dd>{item.neighbors.length}</dd>
        </div>
        <div>
          <dt>Walk-forward hit rate</dt>
          <dd>{item.modelMetrics.hitRate != null ? `${Math.round(item.modelMetrics.hitRate * 100)}%` : "N/A"}</dd>
        </div>
      </dl>

      {item.reasons.length > 0 && (
        <ul className="recommendation-reasons">
          {item.reasons.slice(0, 3).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <span style={{ fontSize: "0.68rem", color: "var(--text-3)" }}>
        Updated {new Date(item.timestamp).toLocaleTimeString()} · {item.source}
      </span>
    </article>
  );
}

function RankingRecommendationTile({ item }: { item: RankingRecommendation }) {
  return (
    <article className={`recommendation-card signal-${item.signal.toLowerCase()}`}>
      <div className="recommendation-card-top">
        <div>
          <strong style={{ display: "block" }}>{item.ticker}</strong>
          <span style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>{item.name ?? item.sector}</span>
        </div>
        <span className={`badge badge-${item.signal.toLowerCase()}`}>{item.signal.replace("_", " ")}</span>
      </div>

      <div className="recommendation-meta">
        <span>{item.market}</span>
        <span>{item.sector}</span>
        <span>Vs. sector {pctOrNA(item.predictedSectorRelativeReturn20d)}</span>
        <span>P(outperform) {item.probabilityOfOutperformance != null ? `${Math.round(item.probabilityOfOutperformance * 100)}%` : "N/A"}</span>
      </div>

      <dl className="recommendation-fields">
        <div>
          <dt>BUY threshold</dt>
          <dd>{pctOrNA(item.buyThreshold)}</dd>
        </div>
        <div>
          <dt>SELL threshold</dt>
          <dd>{pctOrNA(item.sellThreshold)}</dd>
        </div>
        <div>
          <dt>Risk-adjusted score</dt>
          <dd>{item.riskAdjustedScore != null ? item.riskAdjustedScore.toFixed(2) : "N/A"}</dd>
        </div>
        <div>
          <dt>Walk-forward hit rate</dt>
          <dd>{item.modelMetrics.hitRate != null ? `${Math.round(item.modelMetrics.hitRate * 100)}%` : "N/A"}</dd>
        </div>
      </dl>

      {item.reasons.length > 0 && (
        <ul className="recommendation-reasons">
          {item.reasons.slice(0, 3).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <span style={{ fontSize: "0.68rem", color: "var(--text-3)" }}>
        Updated {new Date(item.timestamp).toLocaleTimeString()} · {item.source}
      </span>
    </article>
  );
}

function GrowthRecommendationTile({ item }: { item: GrowthForecast }) {
  return (
    <article className={`recommendation-card signal-${item.signal.toLowerCase()}`}>
      <div className="recommendation-card-top">
        <div>
          <strong style={{ display: "block" }}>{item.ticker}</strong>
          <span style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>{item.name ?? item.sector}</span>
        </div>
        <span className={`badge badge-${item.signal.toLowerCase()}`}>{item.signal.replace("_", " ")}</span>
      </div>

      <div className="recommendation-meta">
        <span>{item.market}</span>
        <span>{item.sector}</span>
        <span>Predicted growth {item.predictedGrowthPercent != null ? `${item.predictedGrowthPercent > 0 ? "+" : ""}${item.predictedGrowthPercent.toFixed(1)}%` : "N/A"}</span>
        <span>Score {item.score}/100</span>
      </div>

      <dl className="recommendation-fields">
        <div>
          <dt>Revenue YoY (this month)</dt>
          <dd>{item.revenue.evaluatedMonthGrowthPercent != null ? `${item.revenue.evaluatedMonthGrowthPercent.toFixed(1)}%` : "N/A"}</dd>
        </div>
        <div>
          <dt>Price YoY (this month)</dt>
          <dd>{item.price.evaluatedMonthGrowthPercent != null ? `${item.price.evaluatedMonthGrowthPercent.toFixed(1)}%` : "N/A"}</dd>
        </div>
        <div>
          <dt>Industry median</dt>
          <dd>{item.industryPrice.evaluatedMonthGrowthPercent != null ? `${item.industryPrice.evaluatedMonthGrowthPercent.toFixed(1)}%` : "N/A"}</dd>
        </div>
        <div>
          <dt>Walk-forward hit rate</dt>
          <dd>{item.modelMetrics.hitRate != null ? `${Math.round(item.modelMetrics.hitRate * 100)}%` : "N/A"}</dd>
        </div>
      </dl>

      {item.priceSeasonality.bestMonth && item.priceSeasonality.worstMonth && (
        <div style={{ fontSize: "0.72rem", color: "var(--text-3)" }}>
          Best: {item.priceSeasonality.bestMonth.monthName} ({item.priceSeasonality.bestMonth.meanGrowthPercent > 0 ? "+" : ""}
          {item.priceSeasonality.bestMonth.meanGrowthPercent.toFixed(0)}%) · Worst: {item.priceSeasonality.worstMonth.monthName} (
          {item.priceSeasonality.worstMonth.meanGrowthPercent.toFixed(0)}%)
        </div>
      )}

      {item.reasons.length > 0 && (
        <ul className="recommendation-reasons">
          {item.reasons.slice(0, 3).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <span style={{ fontSize: "0.68rem", color: "var(--text-3)" }}>
        {item.evaluatedPeriod} → {item.forecastPeriod} · {item.source}
      </span>
    </article>
  );
}

export function RecommendationsPanel({ onTrade }: { onTrade?: (ticker: string) => void }) {
  const [method, setMethod] = useState<"heuristic" | "graph" | "ranking" | "growth">("heuristic");
  const [market, setMarket] = useState<RecommendationMarket | "">("");
  const [sector, setSector] = useState<string>("");
  const [signal, setSignal] = useState<RecommendationSignal | "ALL">("ALL");
  const [view, setView] = useState<"top-picks" | "all">("top-picks");

  const heuristicQuery = useQuery({
    queryKey: ["recommendations", market, sector, signal],
    queryFn: () => getRecommendations({ market: market || undefined, sector: sector || undefined, signal }),
    enabled: method === "heuristic",
    staleTime: 5 * 60 * 1000
  });

  const graphQuery = useQuery({
    queryKey: ["graph-recommendations", market, sector, signal],
    queryFn: () =>
      getGraphRecommendations({ market: market || undefined, sector: sector || undefined, signal: signal as GraphSignal | "ALL" }),
    enabled: method === "graph",
    staleTime: 5 * 60 * 1000
  });

  const rankingQuery = useQuery({
    queryKey: ["ranking-recommendations", market, sector, signal],
    queryFn: () =>
      getRankingRecommendations({ market: market || undefined, sector: sector || undefined, signal: signal as RankingSignal | "ALL" }),
    enabled: method === "ranking",
    staleTime: 5 * 60 * 1000
  });

  const growthQuery = useQuery({
    queryKey: ["growth-recommendations", market, sector, signal],
    queryFn: () =>
      getGrowthRecommendations({ market: market || undefined, sector: sector || undefined, signal: signal as GrowthSignal | "ALL" }),
    enabled: method === "growth",
    staleTime: 15 * 60 * 1000
  });

  const query = method === "heuristic" ? heuristicQuery : method === "graph" ? graphQuery : method === "ranking" ? rankingQuery : growthQuery;

  const sectors = Array.from(
    new Set(
      (method === "heuristic"
        ? heuristicQuery.data?.results
        : method === "graph"
          ? graphQuery.data?.results
          : method === "ranking"
            ? rankingQuery.data?.results
            : growthQuery.data?.results
      )?.map((r) => r.sector) ?? []
    )
  ).sort();

  const heuristicDisplayed =
    view === "top-picks" ? heuristicQuery.data?.topPicksBySector ?? [] : heuristicQuery.data?.results ?? [];
  // The graph model has no per-sector "top pick" grouping (a stock's score
  // there depends on the whole peer graph, not just its own sector), so
  // "Top pick / sector" falls back to "All results" sorted by score.
  const graphDisplayed = graphQuery.data?.results ?? [];
  const rankingDisplayed =
    view === "top-picks" ? rankingQuery.data?.topPicksBySector ?? [] : rankingQuery.data?.results ?? [];
  const growthDisplayed =
    view === "top-picks" ? growthQuery.data?.topPicksBySector ?? [] : growthQuery.data?.results ?? [];

  return (
    <div className="card recommendations-panel">
      <div className="card-header" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h2 className="title-sm">Market Recommendations</h2>
          <p className="body-sm" style={{ color: "var(--text-3)", margin: "0.2rem 0 0" }}>
            {method === "heuristic"
              ? `Technical + fundamental screening across NSE, BSE and US, sector by sector. US prices show in USD, with an INR-equivalent alongside (fixed assumed rate: 1 USD = ${heuristicQuery.data?.usdToInrRate ?? 95} INR).`
              : method === "graph"
                ? "Graph-based peer screening: scores each ticker from how its correlated/sector peers are trending. Independent of the other models — they can and will disagree."
                : method === "ranking"
                  ? "Supervised ranking model: a walk-forward-validated regression trained on price/momentum/volatility features, predicting 20-session return vs. sector. Independent of the other models — they can and will disagree."
                  : "Seasonal growth forecast: compares revenue, earnings, EPS, free cash flow, and price against every prior year available for the same calendar month — not just one anchor comparison — plus an industry-median and peer read. Independent of the other models — they can and will disagree."}
          </p>
        </div>
        <div className="recommendation-filters">
          <div style={{ display: "flex", gap: "0.3rem" }}>
            <button
              className="btn-sm"
              style={{
                background: method === "heuristic" ? "var(--primary-container)" : "var(--surface-variant)",
                color: method === "heuristic" ? "var(--on-primary, #fff)" : "var(--on-surface-variant)",
                border: "none"
              }}
              onClick={() => setMethod("heuristic")}
            >
              Heuristic
            </button>
            <button
              className="btn-sm"
              style={{
                background: method === "graph" ? "var(--primary-container)" : "var(--surface-variant)",
                color: method === "graph" ? "var(--on-primary, #fff)" : "var(--on-surface-variant)",
                border: "none"
              }}
              onClick={() => setMethod("graph")}
            >
              Graph analysis
            </button>
            <button
              className="btn-sm"
              style={{
                background: method === "ranking" ? "var(--primary-container)" : "var(--surface-variant)",
                color: method === "ranking" ? "var(--on-primary, #fff)" : "var(--on-surface-variant)",
                border: "none"
              }}
              onClick={() => setMethod("ranking")}
            >
              Ranking model
            </button>
            <button
              className="btn-sm"
              style={{
                background: method === "growth" ? "var(--primary-container)" : "var(--surface-variant)",
                color: method === "growth" ? "var(--on-primary, #fff)" : "var(--on-surface-variant)",
                border: "none"
              }}
              onClick={() => setMethod("growth")}
            >
              Seasonal growth
            </button>
          </div>
          <select className="form-select" value={market} onChange={(e) => setMarket(e.target.value as any)}>
            <option value="">All markets</option>
            <option value="NSE">NSE (India)</option>
            <option value="BSE">BSE (India)</option>
            <option value="US">US Market</option>
          </select>
          <select className="form-select" value={sector} onChange={(e) => setSector(e.target.value)}>
            <option value="">All sectors</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className="form-select" value={signal} onChange={(e) => setSignal(e.target.value as any)}>
            <option value="ALL">All signals</option>
            <option value="BUY">Buy</option>
            <option value="HOLD">Hold</option>
            <option value="SELL">Sell</option>
          </select>
          {(method === "heuristic" || method === "ranking" || method === "growth") && (
            <div style={{ display: "flex", gap: "0.3rem" }}>
              <button
                className="btn-sm"
                style={{
                  background: view === "top-picks" ? "var(--primary-container)" : "var(--surface-variant)",
                  color: view === "top-picks" ? "var(--on-primary, #fff)" : "var(--on-surface-variant)",
                  border: "none"
                }}
                onClick={() => setView("top-picks")}
              >
                Top pick / sector
              </button>
              <button
                className="btn-sm"
                style={{
                  background: view === "all" ? "var(--primary-container)" : "var(--surface-variant)",
                  color: view === "all" ? "var(--on-primary, #fff)" : "var(--on-surface-variant)",
                  border: "none"
                }}
                onClick={() => setView("all")}
              >
                All results
              </button>
            </div>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <div style={{ color: "var(--text-3)", padding: "1rem 0" }}>
          {method === "heuristic"
            ? "Screening the universe…"
            : method === "graph"
              ? "Building the peer graph…"
              : method === "ranking"
                ? "Fitting the ranking model…"
                : "Comparing every year on record…"}
        </div>
      ) : query.isError ? (
        <p className="muted" style={{ padding: "0.5rem 0" }}>Could not load recommendations right now.</p>
      ) : method === "heuristic" ? (
        heuristicDisplayed.length === 0 ? (
          <p className="muted" style={{ padding: "0.5rem 0" }}>No names match these filters.</p>
        ) : (
          <div className="recommendation-grid">
            {heuristicDisplayed.map((item: StockRecommendation) => (
              <div key={`${item.market}-${item.ticker}`} onClick={() => onTrade?.(item.ticker)} style={{ cursor: onTrade ? "pointer" : "default" }}>
                <RecommendationTile item={item} />
              </div>
            ))}
          </div>
        )
      ) : method === "graph" ? (
        graphDisplayed.length === 0 ? (
          <p className="muted" style={{ padding: "0.5rem 0" }}>No names match these filters.</p>
        ) : (
          <div className="recommendation-grid">
            {graphDisplayed.map((item) => (
              <div key={`${item.market}-${item.ticker}`} onClick={() => onTrade?.(item.ticker)} style={{ cursor: onTrade ? "pointer" : "default" }}>
                <GraphRecommendationTile item={item} />
              </div>
            ))}
          </div>
        )
      ) : method === "ranking" ? (
        rankingDisplayed.length === 0 ? (
          <p className="muted" style={{ padding: "0.5rem 0" }}>No names match these filters.</p>
        ) : (
          <div className="recommendation-grid">
            {rankingDisplayed.map((item: RankingRecommendation) => (
              <div key={`${item.market}-${item.ticker}`} onClick={() => onTrade?.(item.ticker)} style={{ cursor: onTrade ? "pointer" : "default" }}>
                <RankingRecommendationTile item={item} />
              </div>
            ))}
          </div>
        )
      ) : growthDisplayed.length === 0 ? (
        <p className="muted" style={{ padding: "0.5rem 0" }}>No names match these filters.</p>
      ) : (
        <div className="recommendation-grid">
          {growthDisplayed.map((item: GrowthForecast) => (
            <div key={`${item.market}-${item.ticker}`} onClick={() => onTrade?.(item.ticker)} style={{ cursor: onTrade ? "pointer" : "default" }}>
              <GrowthRecommendationTile item={item} />
            </div>
          ))}
        </div>
      )}

      {method === "heuristic" && heuristicQuery.data && heuristicQuery.data.noDataCount > 0 && (
        <p className="body-sm" style={{ color: "var(--text-3)", marginTop: "0.5rem" }}>
          {heuristicQuery.data.noDataCount} of {heuristicQuery.data.universeSize} tracked names had no usable live data
          this pass — open a stock's Research page to enter data for it manually.
        </p>
      )}
      {method === "graph" && graphQuery.data && graphQuery.data.noDataCount > 0 && (
        <p className="body-sm" style={{ color: "var(--text-3)", marginTop: "0.5rem" }}>
          {graphQuery.data.noDataCount} of {graphQuery.data.universeSize} tracked names had too little price history
          to place in the graph this pass.
        </p>
      )}
      {method === "ranking" && rankingQuery.data && rankingQuery.data.noDataCount > 0 && (
        <p className="body-sm" style={{ color: "var(--text-3)", marginTop: "0.5rem" }}>
          {rankingQuery.data.noDataCount} of {rankingQuery.data.universeSize} tracked names had too little resolved
          history for the model to score this pass.
        </p>
      )}
      {method === "growth" && growthQuery.data && growthQuery.data.noDataCount > 0 && (
        <p className="body-sm" style={{ color: "var(--text-3)", marginTop: "0.5rem" }}>
          {growthQuery.data.noDataCount} of {growthQuery.data.universeSize} tracked names had too little multi-year
          price/fundamentals history for a seasonal forecast this pass.
        </p>
      )}

      <p className="recommendation-disclaimer">
        {method === "heuristic"
          ? `${heuristicQuery.data ? `Scored ${heuristicQuery.data.scoredCount} of ${heuristicQuery.data.universeSize} tracked names · ` : ""}${
              heuristicQuery.data?.disclaimer ??
              "Heuristic, rules-based screening signal. Not personalized financial advice — do your own research before trading."
            }`
          : method === "graph"
            ? `${graphQuery.data ? `Scored ${graphQuery.data.scoredCount} of ${graphQuery.data.universeSize} tracked names · ` : ""}${
                graphQuery.data?.disclaimer ??
                "Graph-based peer screening signal. Not personalized financial advice — do your own research before trading."
              }`
            : method === "ranking"
              ? `${rankingQuery.data ? `Scored ${rankingQuery.data.scoredCount} of ${rankingQuery.data.universeSize} tracked names · ` : ""}${
                  rankingQuery.data?.disclaimer ??
                  "Supervised ranking model signal. Not personalized financial advice — do your own research before trading."
                }`
              : `${growthQuery.data ? `Scored ${growthQuery.data.scoredCount} of ${growthQuery.data.universeSize} tracked names · ` : ""}${
                  growthQuery.data?.disclaimer ??
                  "Seasonal growth forecast signal. Not personalized financial advice — do your own research before trading."
                }`}
      </p>
    </div>
  );
}
