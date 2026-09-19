import { useQuery } from "@tanstack/react-query";
import { getGraphRecommendation, type GraphRecommendation } from "../api/client";

function signalClass(signal: string) {
  return `badge badge-${signal.toLowerCase()}`;
}

function pct(value: number | null, digits = 1): string {
  return value == null ? "N/A" : `${(value * 100).toFixed(digits)}%`;
}

export function GraphRecommendationCard({ ticker, token }: { ticker: string; token?: string | null }) {
  const query = useQuery({
    queryKey: ["graph-recommendation", ticker],
    queryFn: () => getGraphRecommendation(ticker, token),
    retry: false,
    staleTime: 10 * 60 * 1000
  });

  const data: GraphRecommendation | undefined = query.data;

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="title-sm">K-NN Recommendation</h2>
        {data && <span className={signalClass(data.signal)}>{data.signal.replace("_", " ")}</span>}
      </div>

      {query.isLoading ? (
        <div style={{ color: "var(--text-3)", padding: "1rem 0" }}>Finding historical analogs for {ticker}…</div>
      ) : query.isError || !data ? (
        <p className="muted" style={{ padding: "0.5rem 0" }}>
          Not enough peer/price data to build a graph signal for {ticker} right now.
        </p>
      ) : (
        <>
          <div className="recommendation-meta">
            <span>Predicted 20d return {pct(data.predictedReturn20d)}</span>
            <span>Confidence {Math.round(data.confidence * 100)}%</span>
            {data.sector && <span>{data.sector}</span>}
            {data.industry && <span>{data.industry}</span>}
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
              <dt>Walk-forward hit rate</dt>
              <dd>{data.modelMetrics.hitRate != null ? `${Math.round(data.modelMetrics.hitRate * 100)}%` : "N/A"}</dd>
            </div>
            <div>
              <dt>Walk-forward samples</dt>
              <dd>{data.modelMetrics.sampleCount}</dd>
            </div>
          </dl>

          {data.neighbors.length > 0 && (
            <div style={{ marginTop: "0.5rem" }}>
              <p className="body-sm" style={{ color: "var(--text-3)", marginBottom: "0.35rem" }}>
                Closest historical analogs
              </p>
              <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-3)" }}>
                    <th style={{ padding: "0.2rem 0.4rem 0.2rem 0" }}>Ticker</th>
                    <th style={{ padding: "0.2rem 0.4rem" }}>Similarity</th>
                    <th style={{ padding: "0.2rem 0.4rem" }}>Fund. sim.</th>
                    <th style={{ padding: "0.2rem 0.4rem" }}>Realized 20d</th>
                    <th style={{ padding: "0.2rem 0.4rem" }}>Sessions ago</th>
                  </tr>
                </thead>
                <tbody>
                  {data.neighbors.map((n, i) => (
                    <tr key={`${n.ticker}-${n.offset}-${i}`} style={{ borderTop: "1px solid var(--outline-variant)" }}>
                      <td style={{ padding: "0.25rem 0.4rem 0.25rem 0" }}>{n.ticker}</td>
                      <td style={{ padding: "0.25rem 0.4rem" }}>{(n.similarity * 100).toFixed(0)}%</td>
                      <td style={{ padding: "0.25rem 0.4rem" }}>
                        {n.fundamentalSimilarity != null ? `${(n.fundamentalSimilarity * 100).toFixed(0)}%` : "N/A"}
                      </td>
                      <td style={{ padding: "0.25rem 0.4rem" }}>{pct(n.historicalForwardReturn20d)}</td>
                      <td style={{ padding: "0.25rem 0.4rem" }}>{n.offset}</td>
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
