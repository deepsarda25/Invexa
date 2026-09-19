import { randomInt } from "node:crypto";
import { sql } from "../../lib/db";
import { redis } from "../../lib/redis";
import { PortfolioService } from "../portfolio/portfolioService";

/**
 * Alphabet for join codes.
 *
 * Deliberately excludes 0/O and 1/I/L — codes get read aloud, screenshotted
 * and retyped by hand, and those are the pairs people get wrong. Digits 2-9
 * and the remaining 22 letters give ~2.4e10 possibilities at length 6, which
 * is far more than enough while staying short enough to dictate over a call.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const MAX_CODE_ATTEMPTS = 8;

/** Leaderboards are expensive (one live price lookup per distinct holding), so cache briefly. */
const LEADERBOARD_TTL_SECONDS = 15;

export const MAX_LEAGUES_PER_USER = 20;
export const MAX_MEMBERS_CAP = 500;

export type LeagueSummary = {
  id: string;
  name: string;
  description: string | null;
  joinCode: string;
  ownerId: string;
  ownerUsername: string;
  isOwner: boolean;
  isOpen: boolean;
  maxMembers: number | null;
  memberCount: number;
  createdAt: string;
  joinedAt?: string;
};

export type LeaderboardRow = {
  rank: number;
  userId: string;
  username: string;
  isYou: boolean;
  isOwner: boolean;
  joinedAt: string;
  baselineValue: number;
  currentValue: number;
  returnAmount: number;
  returnPct: number;
};

export class LeagueService {
  /**
   * Generates a code and confirms it's actually free before handing it back.
   *
   * Collisions are vanishingly unlikely but not impossible, and a duplicate
   * would fail against the unique index at insert time — retrying here means
   * the user never sees that error.
   */
  static async generateJoinCode(): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }

      const [taken] = await sql<{ id: string }[]>`SELECT id FROM leagues WHERE join_code = ${code} LIMIT 1`;
      if (!taken) return code;
    }

    throw new Error("Could not generate a unique join code. Please try again.");
  }

  /**
   * Normalises whatever the user pasted into the join box.
   *
   * People share codes over chat and retype them by hand, so the input
   * arrives lowercased, spaced out, or wrapped in punctuation ("code:
   * a4-k9 xz"). Stripping everything that isn't alphanumeric and
   * uppercasing means all of those resolve to the same code.
   *
   * The characters most often confused when reading a code aloud — O/0 and
   * I/L/1 — aren't in CODE_ALPHABET at all, so a code can never contain
   * one. That means anyone who types an O or a 1 has genuinely misread a
   * different character, and guessing which would risk silently dropping
   * them into the wrong league. They get a "no league found" message
   * instead, which is the honest answer.
   */
  static normalizeJoinCode(raw: string): string {
    return String(raw ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  /** Current total portfolio value (cash + holdings) in INR for one user. */
  static async getPortfolioValue(userId: string): Promise<number> {
    const [account] = await sql<{ virtualBalance: string }[]>`
      SELECT virtual_balance as "virtualBalance" FROM users WHERE id = ${userId}
    `;
    if (!account) throw new Error("User not found");

    const holdings = await sql<{ ticker: string; quantity: string; avgCost: string }[]>`
      SELECT ticker, quantity, avg_cost as "avgCost"
      FROM holdings
      WHERE user_id = ${userId} AND quantity > 0
    `;

    const summary = await PortfolioService.buildSummary(holdings, account.virtualBalance);
    return summary.totalPortfolioValue;
  }

  static async createLeague(params: {
    ownerId: string;
    name: string;
    description?: string | null;
    maxMembers?: number | null;
  }): Promise<LeagueSummary> {
    const name = params.name.trim();
    if (name.length < 3) throw new Error("League name must be at least 3 characters.");
    if (name.length > 60) throw new Error("League name must be 60 characters or fewer.");

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM leagues WHERE owner_id = ${params.ownerId}
    `;
    if (count >= MAX_LEAGUES_PER_USER) {
      throw new Error(`You can own at most ${MAX_LEAGUES_PER_USER} leagues. Delete one to create another.`);
    }

    let maxMembers = params.maxMembers ?? null;
    if (maxMembers !== null) {
      if (!Number.isInteger(maxMembers) || maxMembers < 2) {
        throw new Error("Member limit must be a whole number of at least 2.");
      }
      if (maxMembers > MAX_MEMBERS_CAP) maxMembers = MAX_MEMBERS_CAP;
    }

    const joinCode = await LeagueService.generateJoinCode();
    const description = params.description?.trim() || null;

    const [league] = await sql<{ id: string; createdAt: string }[]>`
      INSERT INTO leagues (name, description, join_code, owner_id, max_members)
      VALUES (${name}, ${description}, ${joinCode}, ${params.ownerId}, ${maxMembers})
      RETURNING id, created_at as "createdAt"
    `;

    // The creator is a competitor too, not just an administrator — joining
    // them immediately means a new league is never a confusing empty room.
    await LeagueService.addMember(league.id, params.ownerId);

    return (await LeagueService.getLeagueForUser(league.id, params.ownerId))!;
  }

  /** Snapshots the user's portfolio value and records the membership. */
  private static async addMember(leagueId: string, userId: string) {
    const baseline = await LeagueService.getPortfolioValue(userId);

    // A zero baseline would make percentage return a division by zero, and
    // there's no meaningful "return" to show on an empty account anyway, so
    // clamp to 1 paisa — the row still appears, pinned at 0.00%.
    const safeBaseline = baseline > 0 ? baseline : 0.01;

    await sql`
      INSERT INTO league_members (league_id, user_id, baseline_value)
      VALUES (${leagueId}, ${userId}, ${safeBaseline.toFixed(2)})
      ON CONFLICT (league_id, user_id) DO NOTHING
    `;
  }

  /**
   * Joins by code. Returns the league the user landed in.
   *
   * Already being a member is treated as success rather than an error: a
   * shared code gets clicked twice all the time, and the useful outcome in
   * both cases is "show me the league".
   */
  static async joinByCode(rawCode: string, userId: string): Promise<{ league: LeagueSummary; alreadyMember: boolean }> {
    const code = LeagueService.normalizeJoinCode(rawCode);
    if (code.length !== CODE_LENGTH) {
      throw new Error(`A league code is ${CODE_LENGTH} characters — please check and try again.`);
    }

    const [league] = await sql<{ id: string; isOpen: boolean; maxMembers: number | null }[]>`
      SELECT id, is_open as "isOpen", max_members as "maxMembers"
      FROM leagues WHERE join_code = ${code} LIMIT 1
    `;
    if (!league) {
      throw new Error("No league found with that code. Double-check it with whoever invited you.");
    }

    const [existing] = await sql<{ userId: string }[]>`
      SELECT user_id as "userId" FROM league_members
      WHERE league_id = ${league.id} AND user_id = ${userId}
    `;
    if (existing) {
      return { league: (await LeagueService.getLeagueForUser(league.id, userId))!, alreadyMember: true };
    }

    if (!league.isOpen) {
      throw new Error("This league is closed to new members.");
    }

    if (league.maxMembers !== null) {
      const [{ count }] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM league_members WHERE league_id = ${league.id}
      `;
      if (count >= league.maxMembers) {
        throw new Error("This league is full.");
      }
    }

    await LeagueService.addMember(league.id, userId);
    await LeagueService.invalidateLeaderboard(league.id);

    return { league: (await LeagueService.getLeagueForUser(league.id, userId))!, alreadyMember: false };
  }

  /** Every league this user belongs to, most recently joined first. */
  static async listForUser(userId: string): Promise<LeagueSummary[]> {
    const rows = await sql<any[]>`
      SELECT
        l.id,
        l.name,
        l.description,
        l.join_code       AS "joinCode",
        l.owner_id        AS "ownerId",
        u.username        AS "ownerUsername",
        l.is_open         AS "isOpen",
        l.max_members     AS "maxMembers",
        l.created_at      AS "createdAt",
        lm.joined_at      AS "joinedAt",
        (SELECT COUNT(*)::int FROM league_members m WHERE m.league_id = l.id) AS "memberCount"
      FROM league_members lm
      JOIN leagues l ON l.id = lm.league_id
      JOIN users u   ON u.id = l.owner_id
      WHERE lm.user_id = ${userId}
      ORDER BY lm.joined_at DESC
    `;

    return rows.map((r) => LeagueService.toSummary(r, userId));
  }

  static async getLeagueForUser(leagueId: string, userId: string): Promise<LeagueSummary | null> {
    const [row] = await sql<any[]>`
      SELECT
        l.id,
        l.name,
        l.description,
        l.join_code   AS "joinCode",
        l.owner_id    AS "ownerId",
        u.username    AS "ownerUsername",
        l.is_open     AS "isOpen",
        l.max_members AS "maxMembers",
        l.created_at  AS "createdAt",
        lm.joined_at  AS "joinedAt",
        (SELECT COUNT(*)::int FROM league_members m WHERE m.league_id = l.id) AS "memberCount"
      FROM leagues l
      JOIN users u ON u.id = l.owner_id
      LEFT JOIN league_members lm ON lm.league_id = l.id AND lm.user_id = ${userId}
      WHERE l.id = ${leagueId}
      LIMIT 1
    `;

    return row ? LeagueService.toSummary(row, userId) : null;
  }

  private static toSummary(row: any, userId: string): LeagueSummary {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      joinCode: row.joinCode,
      ownerId: row.ownerId,
      ownerUsername: row.ownerUsername,
      isOwner: row.ownerId === userId,
      isOpen: row.isOpen,
      maxMembers: row.maxMembers,
      memberCount: row.memberCount,
      createdAt: new Date(row.createdAt).toISOString(),
      joinedAt: row.joinedAt ? new Date(row.joinedAt).toISOString() : undefined
    };
  }

  static async assertMember(leagueId: string, userId: string) {
    const [row] = await sql<{ userId: string }[]>`
      SELECT user_id as "userId" FROM league_members
      WHERE league_id = ${leagueId} AND user_id = ${userId}
    `;
    if (!row) throw new Error("You're not a member of this league.");
  }

  static async assertOwner(leagueId: string, userId: string) {
    const [row] = await sql<{ ownerId: string }[]>`
      SELECT owner_id as "ownerId" FROM leagues WHERE id = ${leagueId}
    `;
    if (!row) throw new Error("League not found.");
    if (row.ownerId !== userId) throw new Error("Only the league owner can do that.");
  }

  private static leaderboardKey(leagueId: string) {
    return `league:leaderboard:${leagueId}`;
  }

  static async invalidateLeaderboard(leagueId: string) {
    try {
      await redis.del(LeagueService.leaderboardKey(leagueId));
    } catch {
      // A stale cache entry for a few seconds is harmless; never let a
      // Redis hiccup break the write that triggered this.
    }
  }

  /**
   * Builds the standings: every member ranked by percentage return since
   * they joined.
   *
   * Cached for a few seconds because the cost scales with (members ×
   * distinct holdings) live price lookups, and a league tab left open with
   * a 20s refetch would otherwise hammer the price cache for every viewer.
   */
  static async getLeaderboard(leagueId: string, viewerId: string): Promise<LeaderboardRow[]> {
    const key = LeagueService.leaderboardKey(leagueId);

    let rows: Omit<LeaderboardRow, "isYou">[] | null = null;
    try {
      const cached = await redis.get(key);
      if (cached) rows = JSON.parse(cached);
    } catch {
      // Fall through to a live computation.
    }

    if (!rows) {
      rows = await LeagueService.computeLeaderboard(leagueId);
      try {
        await redis.set(key, JSON.stringify(rows), "EX", LEADERBOARD_TTL_SECONDS);
      } catch {
        // Caching is an optimisation, not a requirement.
      }
    }

    // `isYou` is viewer-dependent, so it's applied after the shared cache.
    return rows.map((r) => ({ ...r, isYou: r.userId === viewerId }));
  }

  private static async computeLeaderboard(leagueId: string): Promise<Omit<LeaderboardRow, "isYou">[]> {
    const members = await sql<
      { userId: string; username: string; baselineValue: string; joinedAt: string; ownerId: string }[]
    >`
      SELECT
        lm.user_id        AS "userId",
        u.username,
        lm.baseline_value AS "baselineValue",
        lm.joined_at      AS "joinedAt",
        l.owner_id        AS "ownerId"
      FROM league_members lm
      JOIN users u   ON u.id = lm.user_id
      JOIN leagues l ON l.id = lm.league_id
      WHERE lm.league_id = ${leagueId}
    `;

    const scored = await Promise.all(
      members.map(async (m) => {
        const baselineValue = Number(m.baselineValue);
        let currentValue = baselineValue;

        try {
          currentValue = await LeagueService.getPortfolioValue(m.userId);
        } catch (err) {
          // One member's pricing failure (a delisted ticker, a market data
          // timeout) must not blank out the whole leaderboard — fall back
          // to their baseline so they appear at 0.00% rather than vanish.
          console.error(`[leagues] Could not value portfolio for ${m.userId}:`, err);
        }

        const returnAmount = currentValue - baselineValue;

        return {
          userId: m.userId,
          username: m.username,
          isOwner: m.userId === m.ownerId,
          joinedAt: new Date(m.joinedAt).toISOString(),
          baselineValue,
          currentValue,
          returnAmount,
          returnPct: baselineValue > 0 ? (returnAmount / baselineValue) * 100 : 0
        };
      })
    );

    scored.sort((a, b) => {
      if (b.returnPct !== a.returnPct) return b.returnPct - a.returnPct;
      // Stable, non-arbitrary tiebreak: bigger absolute gain first, then
      // whoever joined earliest, so the order doesn't shuffle between
      // refreshes when several members are flat at 0.00%.
      if (b.returnAmount !== a.returnAmount) return b.returnAmount - a.returnAmount;
      return a.joinedAt.localeCompare(b.joinedAt);
    });

    // Dense-rank ties so two members on identical returns share a position.
    let lastPct: number | null = null;
    let lastRank = 0;
    return scored.map((row, index) => {
      const rank = lastPct !== null && row.returnPct === lastPct ? lastRank : index + 1;
      lastPct = row.returnPct;
      lastRank = rank;
      return { rank, ...row };
    });
  }

  /**
   * Removes a member. Owners can't simply walk out — the league would be
   * left with a code nobody can manage — so they must delete it or hand
   * ownership over first.
   */
  static async leave(leagueId: string, userId: string) {
    const [league] = await sql<{ ownerId: string }[]>`
      SELECT owner_id as "ownerId" FROM leagues WHERE id = ${leagueId}
    `;
    if (!league) throw new Error("League not found.");

    if (league.ownerId === userId) {
      throw new Error("You own this league — transfer it to another member or delete it instead of leaving.");
    }

    await sql`DELETE FROM league_members WHERE league_id = ${leagueId} AND user_id = ${userId}`;
    await LeagueService.invalidateLeaderboard(leagueId);
  }

  /** Owner-only: kick a member. */
  static async removeMember(leagueId: string, ownerId: string, targetUserId: string) {
    await LeagueService.assertOwner(leagueId, ownerId);
    if (targetUserId === ownerId) {
      throw new Error("You can't remove yourself — delete the league instead.");
    }

    await sql`DELETE FROM league_members WHERE league_id = ${leagueId} AND user_id = ${targetUserId}`;
    await LeagueService.invalidateLeaderboard(leagueId);
  }

  /**
   * Owner-only: issue a fresh code. The old one stops working immediately,
   * which is the point — it's how you shut out a code that leaked.
   */
  static async regenerateJoinCode(leagueId: string, ownerId: string): Promise<string> {
    await LeagueService.assertOwner(leagueId, ownerId);
    const joinCode = await LeagueService.generateJoinCode();
    await sql`UPDATE leagues SET join_code = ${joinCode} WHERE id = ${leagueId}`;
    return joinCode;
  }

  static async updateSettings(
    leagueId: string,
    ownerId: string,
    patch: { name?: string; description?: string | null; isOpen?: boolean; maxMembers?: number | null }
  ): Promise<LeagueSummary> {
    await LeagueService.assertOwner(leagueId, ownerId);

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.length < 3 || name.length > 60) {
        throw new Error("League name must be between 3 and 60 characters.");
      }
      await sql`UPDATE leagues SET name = ${name} WHERE id = ${leagueId}`;
    }

    if (patch.description !== undefined) {
      const description = patch.description?.trim() || null;
      await sql`UPDATE leagues SET description = ${description} WHERE id = ${leagueId}`;
    }

    if (patch.isOpen !== undefined) {
      await sql`UPDATE leagues SET is_open = ${patch.isOpen} WHERE id = ${leagueId}`;
    }

    if (patch.maxMembers !== undefined) {
      const limit =
        patch.maxMembers === null ? null : Math.min(Math.max(Math.trunc(patch.maxMembers), 2), MAX_MEMBERS_CAP);
      await sql`UPDATE leagues SET max_members = ${limit} WHERE id = ${leagueId}`;
    }

    return (await LeagueService.getLeagueForUser(leagueId, ownerId))!;
  }

  static async deleteLeague(leagueId: string, ownerId: string) {
    await LeagueService.assertOwner(leagueId, ownerId);
    // league_members rows cascade away with the parent row.
    await sql`DELETE FROM leagues WHERE id = ${leagueId}`;
    await LeagueService.invalidateLeaderboard(leagueId);
  }
}
