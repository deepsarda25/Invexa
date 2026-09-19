import { useQuery } from "@tanstack/react-query";
import { getRankingRecommendation, type RankingRecommendation } from "../api/client";

function signalClass(signal: string) {
  return `badge badge-${signal.toLowerCase()}`;
}

function pct(value: number | null, digits = 1): string {
  return value == null ? "N/A" : `${(value * 100).toFixed(digits)}%`;
}

export function RankingRecommendationCard({ ticker, token }: { ticker: string; token?: string | null }) {
  const query = useQuery({
    queryKey: ["ranking-recommendation", ticker],
    queryFn: () => getRankingRecommendation(ticker, token),
    retry: false,
    staleTime: 10 * 60 * 1000
  });

  const data: RankingRecommendation | undefined = query.data;

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="title-sm">Ranking Recommendation (Regression)</h2>
        {data && <span className={signalClass(data.signal)}>{data.signal.replace("_", " ")}</span>}
      </div>

      {query.isLoading ? (
        <div style={{ color: "var(--text-3)", padding: "1rem 0" }}>Fitting the ranking model for {ticker}…</div>
      ) : query.isError || !data ? (
        <p className="muted" style={{ padding: "0.5rem 0" }}>
          Not enough universe/price data to build a ranking signal for {ticker} right now.
        </p>
      ) : (
        <>
          <div className="recommendation-meta">
            <span>Predicted vs. sector {pct(data.predictedSectorRelativeReturn20d)}</span>
            <span>P(outperform) {data.probabilityOfOutperformance != null ? `${Math.round(data.probabilityOfOutperformance * 100)}%` : "N/A"}</span>
            <span>Confidence {Math.round(data.confidence * 100)}%</span>
            {data.sector && <span>{data.sector}</span>}
          </div>

          <dl className="recommendation-fields">
            <div>
              <dt>BUY threshold</dt>
              <dd>{pct(data.buyThreshold)}</dd>
            </div>
            <div>
              <dt>SELL threshold</dt>
              <dd>{pct(data.sellThreshold)}</dd>
            </div>
            <div>
              <dt>Risk-adjusted score</dt>
              <dd>{data.riskAdjustedScore != null ? data.riskAdjustedScore.toFixed(2) : "N/A"}</dd>
            </div>
            <div>
              <dt>Walk-forward hit rate</dt>
              <dd>{data.modelMetrics.hitRate != null ? `${Math.round(data.modelMetrics.hitRate * 100)}%` : "N/A"}</dd>
            </div>
          </dl>

          {data.featureContributions.length > 0 && (
            <div style={{ marginTop: "0.5rem" }}>
              <p className="body-sm" style={{ color: "var(--text-3)", marginBottom: "0.35rem" }}>
                Largest model drivers
              </p>
              <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-3)" }}>
                    <th style={{ padding: "0.2rem 0.4rem 0.2rem 0" }}>Feature</th>
                    <th style={{ padding: "0.2rem 0.4rem" }}>Z-score</th>
                    <th style={{ padding: "0.2rem 0.4rem" }}>Weight</th>
                    <th style={{ padding: "0.2rem 0.4rem" }}>Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {data.featureContributions.map((f) => (
                    <tr key={f.feature} style={{ borderTop: "1px solid var(--outline-variant)" }}>
                      <td style={{ padding: "0.25rem 0.4rem 0.25rem 0" }}>{f.feature}</td>
                      <td style={{ padding: "0.25rem 0.4rem" }}>{f.value.toFixed(2)}</td>
                      <td style={{ padding: "0.25rem 0.4rem" }}>{f.weight.toFixed(3)}</td>
                      <td style={{ padding: "0.25rem 0.4rem" }}>{f.contribution >= 0 ? "+" : ""}{f.contribution.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.reasons.length > 0 && (
            <ul className="recommendation-reasons">
              {data.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          <p className="recommendation-disclaimer">
            {data.source} · updated {new Date(data.timestamp).toLocaleString()}. {data.disclaimer}
          </p>
        </>
      )}
    </div>
  );
}
