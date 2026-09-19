import { useQuery } from "@tanstack/react-query";
import { getGrowthRecommendation, type GrowthForecast, type MetricSeasonalSummary, type MonthlySeasonalProfile } from "../api/client";

function signalClass(signal: string) {
  return `badge badge-${signal.toLowerCase()}`;
}

function pct(value: number | null): string {
  return value == null ? "N/A" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function MetricRow({ label, summary }: { label: string; summary: MetricSeasonalSummary }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {pct(summary.evaluatedMonthGrowthPercent)}
        {summary.evaluatedMonthSampleCount > 0 && (
          <span style={{ color: "var(--text-3)", fontSize: "0.7rem" }}> ({summary.evaluatedMonthSampleCount}yr)</span>
        )}
      </dd>
    </div>
  );
}

function cellBackground(g: number | null): string {
  if (g == null) return "var(--surface-variant)";
  const intensity = Math.min(Math.abs(g) / 12, 1); // saturate the color by ~12%+ average moves
  return g >= 0
    ? `color-mix(in srgb, var(--positive, #1f7a4d) ${10 + intensity * 35}%, transparent)`
    : `color-mix(in srgb, var(--negative, #b3261e) ${10 + intensity * 35}%, transparent)`;
}

/** Best/worst get a solid ring, the most-volatile month gets a dashed one — the strip answers "which months move the most" at a glance instead of only in the text below it. */
function cellBorder(month: MonthlySeasonalProfile, seasonality: GrowthForecast["priceSeasonality"], isEvaluated: boolean): string {
  if (seasonality.bestMonth?.month === month.month) return "2px solid var(--positive, #1f7a4d)";
  if (seasonality.worstMonth?.month === month.month) return "2px solid var(--negative, #b3261e)";
  if (seasonality.mostVolatileMonth?.month === month.month) return "2px dashed var(--text-3)";
  if (isEvaluated) return "2px solid var(--primary, #6750a4)";
  return "1px solid var(--outline-variant)";
}

export function GrowthRecommendationCard({ ticker, token }: { ticker: string; token?: string | null }) {
  const query = useQuery({
    queryKey: ["growth-recommendation", ticker],
    queryFn: () => getGrowthRecommendation(ticker, token),
    retry: false,
    staleTime: 30 * 60 * 1000
  });

  const data: GrowthForecast | undefined = query.data;
  const seasonality = data?.priceSeasonality;
  const evaluatedMonth = data ? Number(data.evaluatedPeriod.split("-")[1]) : null;

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="title-sm">Seasonal Growth Recommendation</h2>
        {data && <span className={signalClass(data.signal)}>{data.signal.replace("_", " ")}</span>}
      </div>

      {query.isLoading ? (
        <div style={{ color: "var(--text-3)", padding: "1rem 0" }}>Comparing every year on record for {ticker}…</div>
      ) : query.isError || !data ? (
        <p className="muted" style={{ padding: "0.5rem 0" }}>
          Not enough multi-year price/fundamentals history to build a seasonal forecast for {ticker} right now.
        </p>
      ) : (
        <>
          <div className="recommendation-meta">
            <span>Predicted growth {pct(data.predictedGrowthPercent)}</span>
            <span>Score {data.score}/100</span>
            <span>Confidence {Math.round(data.confidence * 100)}%</span>
            <span>
              {data.evaluatedPeriod} → {data.forecastPeriod}
            </span>
          </div>

          <dl className="recommendation-fields">
            <MetricRow label="Revenue (YoY, this month)" summary={data.revenue} />
            <MetricRow label="Earnings (YoY, this month)" summary={data.earnings} />
            <MetricRow label="EPS (approx., YoY)" summary={data.eps} />
            <MetricRow label="Free cash flow (YoY)" summary={data.freeCashFlow} />
            <MetricRow label="Price (this calendar month)" summary={data.price} />
            <MetricRow label="Industry median price" summary={data.industryPrice} />
          </dl>

          {seasonality && (seasonality.bestMonth || seasonality.worstMonth) && (
            <div
              style={{
                marginTop: "0.6rem",
                padding: "0.5rem 0.65rem",
                borderRadius: "8px",
                background: "var(--surface-variant)",
                fontSize: "0.78rem",
                lineHeight: 1.5
              }}
            >
              <div>
                <strong style={{ color: "var(--positive, #1f7a4d)" }}>▲ Best month:</strong> {seasonality.bestMonth?.monthName} (
                {pct(seasonality.bestMonth?.meanGrowthPercent ?? null)}, {seasonality.bestMonth?.sampleCount}yr)
                {"  "}
                <strong style={{ color: "var(--negative, #b3261e)" }}>▼ Worst month:</strong> {seasonality.worstMonth?.monthName} (
                {pct(seasonality.worstMonth?.meanGrowthPercent ?? null)}, {seasonality.worstMonth?.sampleCount}yr)
              </div>
              {seasonality.mostVolatileMonth && (
                <div style={{ color: "var(--text-3)", marginTop: "0.15rem" }}>
                  Most volatile: {seasonality.mostVolatileMonth.monthName} (σ {seasonality.mostVolatileMonth.stdevGrowthPercent?.toFixed(1) ?? "N/A"}%) ·
                  Seasonal swing: {seasonality.seasonalSwingPercent != null ? `${seasonality.seasonalSwingPercent.toFixed(1)} pts` : "N/A"}
                </div>
              )}
              {!seasonality.hasReliableSeasonality && (
                <div style={{ color: "var(--text-3)", marginTop: "0.15rem", fontStyle: "italic" }}>
                  No month clears a basic significance bar yet — read these as suggestive, not proven.
                </div>
              )}
            </div>
          )}

          {data.priceSeasonalByMonth.some((m) => m.sampleCount > 0) && (
            <div style={{ marginTop: "0.6rem" }}>
              <p className="body-sm" style={{ color: "var(--text-3)", marginBottom: "0.35rem" }}>
                Price seasonality by calendar month — solid ring = best/worst, dashed = most volatile
              </p>
              <div style={{ display: "flex", gap: "0.2rem", flexWrap: "wrap" }}>
                {data.priceSeasonalByMonth.map((m) => {
                  const isEvaluated = m.month === evaluatedMonth;
                  const g = m.meanGrowthPercent;
                  return (
                    <div
                      key={m.month}
                      title={
                        g == null
                          ? "No data"
                          : `${MONTH_NAMES[m.month - 1]}: ${g.toFixed(1)}% avg over ${m.sampleCount}yr${m.stdevGrowthPercent != null ? `, σ ${m.stdevGrowthPercent.toFixed(1)}%` : ""}${m.isNotable ? " · statistically notable" : ""}`
                      }
                      style={{
                        flex: "1 0 6.5%",
                        minWidth: "2.6rem",
                        textAlign: "center",
                        borderRadius: "6px",
                        padding: "0.3rem 0.1rem",
                        background: cellBackground(g),
                        border: seasonality ? cellBorder(m, seasonality, isEvaluated) : "1px solid var(--outline-variant)",
                        fontSize: "0.68rem"
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{MONTH_NAMES[m.month - 1]}</div>
                      <div>{g == null ? "—" : `${g >= 0 ? "+" : ""}${g.toFixed(0)}%`}</div>
                    </div>
                  );
                })}
              </div>
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
