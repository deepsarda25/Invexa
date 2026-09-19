import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLeague,
  deleteLeague,
  getLeagueLeaderboard,
  getMyLeagues,
  joinLeague,
  leaveLeague,
  regenerateLeagueCode,
  removeLeagueMember,
  updateLeague,
  type LeaderboardRow,
  type League
} from "../api/client";

type Props = {
  token: string;
};

const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

/** Medal colours for the top three, falling back to plain text below that. */
function rankBadge(rank: number) {
  if (rank === 1) return { label: "1", background: "#d4af37", color: "#1a1400" };
  if (rank === 2) return { label: "2", background: "#b8bcc4", color: "#16181c" };
  if (rank === 3) return { label: "3", background: "#c07c48", color: "#1c1004" };
  return null;
}

/**
 * The join code, shown big and monospaced with a one-tap copy.
 *
 * Codes exist to be passed to other people, so the copy affordance is the
 * primary action here — reading six characters off a screen and retyping
 * them into a phone is exactly where invites get abandoned.
 */
function JoinCodeBox({ code, onRegenerate, canRegenerate }: { code: string; onRegenerate?: () => void; canRegenerate: boolean }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Clipboard access is denied in some browsers/contexts — the code is
      // on screen in full, so this is a convenience, not the only route.
      setCopied(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        padding: "0.75rem 1rem",
        borderRadius: "0.6rem",
        border: "1px dashed var(--outline-variant)",
        background: "var(--surface-2, transparent)"
      }}
    >
      <div>
        <div className="label-sm" style={{ color: "var(--text-3)" }}>Invite code</div>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "1.6rem",
            letterSpacing: "0.35em",
            fontWeight: 700,
            marginTop: "0.15rem"
          }}
        >
          {code}
        </div>
      </div>
      <div style={{ display: "flex", gap: "0.5rem", marginLeft: "auto" }}>
        <button className="btn-sm" onClick={() => void copy()}>{copied ? "Copied" : "Copy code"}</button>
        {canRegenerate && onRegenerate && (
          <button className="btn-sm" onClick={onRegenerate} title="Invalidates the current code">
            New code
          </button>
        )}
      </div>
    </div>
  );
}

function Leaderboard({
  rows,
  league,
  onRemove
}: {
  rows: LeaderboardRow[];
  league: League;
  onRemove: (userId: string, username: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="muted" style={{ padding: "0.75rem 0" }}>No members yet.</p>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th style={{ width: "3.5rem" }}>Rank</th>
          <th>Member</th>
          <th>Return</th>
          <th>Gain / Loss</th>
          <th>Portfolio Value</th>
          {league.isOwner && <th></th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const badge = rankBadge(row.rank);
          return (
            <tr
              key={row.userId}
              style={
                row.isYou
                  ? { background: "var(--primary-container, rgba(120,140,255,0.08))" }
                  : undefined
              }
            >
              <td>
                {badge ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "1.6rem",
                      height: "1.6rem",
                      borderRadius: "50%",
                      fontWeight: 700,
                      fontSize: "0.8rem",
                      background: badge.background,
                      color: badge.color
                    }}
                  >
                    {badge.label}
                  </span>
                ) : (
                  <span style={{ color: "var(--text-3)" }}>{row.rank}</span>
                )}
              </td>
              <td>
                <strong>{row.username}</strong>
                {row.isYou && <span className="badge" style={{ marginLeft: "0.4rem" }}>You</span>}
                {row.isOwner && (
                  <span className="badge" style={{ marginLeft: "0.4rem" }}>Owner</span>
                )}
                <div style={{ color: "var(--text-3)", fontSize: "0.72rem" }}>
                  Joined {new Date(row.joinedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </div>
              </td>
              <td className={row.returnPct >= 0 ? "good" : "bad"} style={{ fontWeight: 600 }}>
                {pct(row.returnPct)}
              </td>
              <td className={row.returnAmount >= 0 ? "good" : "bad"}>
                {row.returnAmount >= 0 ? "+" : "−"}
                {inr(Math.abs(row.returnAmount))}
              </td>
              <td>{inr(row.currentValue)}</td>
              {league.isOwner && (
                <td>
                  {!row.isOwner && (
                    <button className="btn-sm" onClick={() => onRemove(row.userId, row.username)}>
                      Remove
                    </button>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function LeaguePanel({ token }: Props) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const leaguesQuery = useQuery({
    queryKey: ["leagues", token],
    queryFn: () => getMyLeagues(token),
    refetchInterval: 60_000
  });

  const leagues = leaguesQuery.data?.leagues ?? [];

  // Keep a valid selection without fighting the user: only auto-select when
  // nothing is selected, or when the selected league has gone away (left or
  // deleted). Re-selecting on every refetch would yank them back to the top
  // of the list mid-browse.
  useEffect(() => {
    if (leagues.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !leagues.some((l) => l.id === selectedId)) {
      setSelectedId(leagues[0].id);
    }
  }, [leagues, selectedId]);

  const leaderboardQuery = useQuery({
    queryKey: ["league-leaderboard", selectedId],
    queryFn: () => getLeagueLeaderboard(selectedId!, token),
    enabled: Boolean(selectedId),
    refetchInterval: 20_000
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["leagues"] });
    void queryClient.invalidateQueries({ queryKey: ["league-leaderboard"] });
  };

  const joinMutation = useMutation({
    mutationFn: (code: string) => joinLeague(code, token),
    onSuccess: (data) => {
      setJoinCodeInput("");
      setSelectedId(data.league.id);
      setNotice({ kind: "ok", text: data.message });
      refreshAll();
    },
    onError: (err: Error) => setNotice({ kind: "err", text: err.message })
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createLeague({ name: newName, description: newDescription || undefined }, token),
    onSuccess: (data) => {
      setNewName("");
      setNewDescription("");
      setShowCreate(false);
      setSelectedId(data.league.id);
      setNotice({ kind: "ok", text: `${data.league.name} created — share code ${data.league.joinCode} to invite others.` });
      refreshAll();
    },
    onError: (err: Error) => setNotice({ kind: "err", text: err.message })
  });

  const regenerateMutation = useMutation({
    mutationFn: (leagueId: string) => regenerateLeagueCode(leagueId, token),
    onSuccess: (data) => {
      setNotice({ kind: "ok", text: data.message });
      refreshAll();
    },
    onError: (err: Error) => setNotice({ kind: "err", text: err.message })
  });

  const leaveMutation = useMutation({
    mutationFn: (leagueId: string) => leaveLeague(leagueId, token),
    onSuccess: () => {
      setSelectedId(null);
      setNotice({ kind: "ok", text: "You've left the league." });
      refreshAll();
    },
    onError: (err: Error) => setNotice({ kind: "err", text: err.message })
  });

  const deleteMutation = useMutation({
    mutationFn: (leagueId: string) => deleteLeague(leagueId, token),
    onSuccess: () => {
      setSelectedId(null);
      setNotice({ kind: "ok", text: "League deleted." });
      refreshAll();
    },
    onError: (err: Error) => setNotice({ kind: "err", text: err.message })
  });

  const removeMemberMutation = useMutation({
    mutationFn: ({ leagueId, userId }: { leagueId: string; userId: string }) =>
      removeLeagueMember(leagueId, userId, token),
    onSuccess: () => {
      setNotice({ kind: "ok", text: "Member removed." });
      refreshAll();
    },
    onError: (err: Error) => setNotice({ kind: "err", text: err.message })
  });

  const toggleOpenMutation = useMutation({
    mutationFn: ({ leagueId, isOpen }: { leagueId: string; isOpen: boolean }) =>
      updateLeague(leagueId, { isOpen }, token),
    onSuccess: (data) => {
      setNotice({
        kind: "ok",
        text: data.league.isOpen ? "League reopened — the code works again." : "League closed to new members."
      });
      refreshAll();
    },
    onError: (err: Error) => setNotice({ kind: "err", text: err.message })
  });

  const handleJoin = (e: FormEvent) => {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;
    joinMutation.mutate(joinCodeInput.trim());
  };

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (newName.trim().length < 3) {
      setNotice({ kind: "err", text: "League name must be at least 3 characters." });
      return;
    }
    createMutation.mutate();
  };

  const selected = leaderboardQuery.data?.league ?? leagues.find((l) => l.id === selectedId) ?? null;
  const rows = leaderboardQuery.data?.leaderboard ?? [];
  const you = leaderboardQuery.data?.you ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {notice && (
        <div
          className="card"
          style={{
            padding: "0.75rem 1rem",
            borderLeft: `3px solid ${notice.kind === "ok" ? "var(--color-success, #2e9e6b)" : "var(--color-danger, #d9534f)"}`
          }}
        >
          {notice.text}
        </div>
      )}

      {/* ── Join / create strip ── */}
      <div className="card">
        <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <div>
            <h2 className="title-sm">Leagues</h2>
            <p className="body-sm" style={{ color: "var(--text-3)", margin: "0.2rem 0 0" }}>
              Compete on percentage return since joining — so everyone starts level, whatever their balance.
            </p>
          </div>
          <button className="btn-primary" style={{ padding: "0.45rem 1.1rem" }} onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancel" : "Create league"}
          </button>
        </div>

        <form onSubmit={handleJoin} style={{ display: "flex", gap: "0.6rem", alignItems: "flex-end", flexWrap: "wrap", marginTop: "0.5rem" }}>
          <div className="input-group" style={{ flex: "1 1 220px" }}>
            <label htmlFor="league-code">Have an invite code?</label>
            <input
              id="league-code"
              className="form-input"
              value={joinCodeInput}
              maxLength={12}
              placeholder="e.g. K4M7QP"
              autoCapitalize="characters"
              spellCheck={false}
              style={{ textTransform: "uppercase", letterSpacing: "0.2em", fontFamily: "monospace" }}
              onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
            />
          </div>
          <button className="btn-primary" style={{ padding: "0.6rem 1.4rem" }} disabled={joinMutation.isPending}>
            {joinMutation.isPending ? "Joining…" : "Join league"}
          </button>
        </form>

        {showCreate && (
          <form onSubmit={handleCreate} style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--outline-variant)", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div className="input-group">
              <label htmlFor="league-name">League name</label>
              <input
                id="league-name"
                className="form-input"
                value={newName}
                maxLength={60}
                placeholder="Class of 2026 Traders"
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="input-group">
              <label htmlFor="league-desc">Description (optional)</label>
              <input
                id="league-desc"
                className="form-input"
                value={newDescription}
                maxLength={280}
                placeholder="Monthly bragging rights."
                onChange={(e) => setNewDescription(e.target.value)}
              />
            </div>
            <button className="btn-primary" style={{ alignSelf: "flex-start", padding: "0.6rem 1.4rem" }} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating…" : "Create and get a code"}
            </button>
          </form>
        )}
      </div>

      {/* ── League switcher ── */}
      {leagues.length > 0 && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {leagues.map((l) => (
            <button
              key={l.id}
              className={`btn-sm${l.id === selectedId ? " active" : ""}`}
              onClick={() => setSelectedId(l.id)}
            >
              {l.name}
              <span style={{ color: "var(--text-3)", marginLeft: "0.4rem" }}>{l.memberCount}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {leaguesQuery.isLoading ? (
        <div className="card"><p className="muted">Loading your leagues…</p></div>
      ) : leagues.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "2.5rem 1rem" }}>
          <h3 className="title-sm">You're not in a league yet</h3>
          <p className="muted" style={{ maxWidth: "440px", margin: "0.5rem auto 0" }}>
            Create one and share the six-character code, or paste a code above to join a friend's.
            Your portfolio and trading stay exactly as they are — a league only tracks how your
            returns compare.
          </p>
        </div>
      ) : selected ? (
        <>
          {/* ── Selected league header ── */}
          <div className="card">
            <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem" }}>
              <div>
                <h2 className="title-sm">{selected.name}</h2>
                <p className="body-sm" style={{ color: "var(--text-3)", margin: "0.2rem 0 0" }}>
                  {selected.description || `Run by ${selected.ownerUsername}`}
                  {" · "}
                  {selected.memberCount} member{selected.memberCount === 1 ? "" : "s"}
                  {!selected.isOpen && " · closed to new joins"}
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {selected.isOwner ? (
                  <>
                    <button
                      className="btn-sm"
                      onClick={() => toggleOpenMutation.mutate({ leagueId: selected.id, isOpen: !selected.isOpen })}
                    >
                      {selected.isOpen ? "Close to new joins" : "Reopen"}
                    </button>
                    <button
                      className="btn-sm"
                      onClick={() => {
                        if (window.confirm(`Delete "${selected.name}"? This removes it for every member and can't be undone.`)) {
                          deleteMutation.mutate(selected.id);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <button
                    className="btn-sm"
                    onClick={() => {
                      if (window.confirm(`Leave "${selected.name}"?`)) leaveMutation.mutate(selected.id);
                    }}
                  >
                    Leave league
                  </button>
                )}
              </div>
            </div>

            <JoinCodeBox
              code={selected.joinCode}
              canRegenerate={selected.isOwner}
              onRegenerate={() => {
                if (window.confirm("Generate a new code? The current one will stop working for anyone who hasn't joined yet.")) {
                  regenerateMutation.mutate(selected.id);
                }
              }}
            />

            {/* Your own standing, surfaced above the table so it's readable
                without hunting through a long leaderboard. */}
            {you && (
              <div className="stats-row" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", marginTop: "1rem" }}>
                <div className="stat-cell">
                  <span>Your Rank</span>
                  <strong className="headline-sm">
                    #{you.rank} <span style={{ color: "var(--text-3)", fontWeight: 400, fontSize: "0.8rem" }}>of {rows.length}</span>
                  </strong>
                </div>
                <div className="stat-cell">
                  <span>Your Return</span>
                  <strong className={you.returnPct >= 0 ? "good headline-sm" : "bad headline-sm"}>{pct(you.returnPct)}</strong>
                </div>
                <div className="stat-cell">
                  <span>Since Joining</span>
                  <strong className={you.returnAmount >= 0 ? "good headline-sm" : "bad headline-sm"}>
                    {you.returnAmount >= 0 ? "+" : "−"}{inr(Math.abs(you.returnAmount))}
                  </strong>
                </div>
              </div>
            )}
          </div>

          {/* ── Leaderboard ── */}
          <div className="card">
            <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 className="title-sm">Leaderboard</h2>
              <span style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>
                {leaderboardQuery.isFetching ? "Updating…" : "Updates every 20s"}
              </span>
            </div>

            {leaderboardQuery.isLoading ? (
              <p className="muted" style={{ padding: "0.75rem 0" }}>Valuing portfolios…</p>
            ) : leaderboardQuery.isError ? (
              <p className="muted" style={{ padding: "0.75rem 0" }}>
                {(leaderboardQuery.error as Error).message}
              </p>
            ) : (
              <Leaderboard
                rows={rows}
                league={selected}
                onRemove={(userId, username) => {
                  if (window.confirm(`Remove ${username} from ${selected.name}?`)) {
                    removeMemberMutation.mutate({ leagueId: selected.id, userId });
                  }
                }}
              />
            )}

            <p style={{ color: "var(--text-3)", fontSize: "0.75rem", marginTop: "0.9rem" }}>
              Ranking is by percentage return measured from each member's portfolio value at the
              moment they joined, so joining later or with a larger balance is neither an advantage
              nor a penalty.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
